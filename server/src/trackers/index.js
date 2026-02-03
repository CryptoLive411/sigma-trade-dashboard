const { ethers } = require('ethers')
const { logger } = require('../lib/logger')
const { DEFAULTS } = require('../lib/runtimeConfig')
const { initRegistry, getActiveTrackers, getAllTrackers } = require('./registry')

// In-memory watcher metrics (reset on process restart)
const watcherMetrics = {
  blocksScanned: 0,
  receiptsScanned: 0,
  detectCalls: 0,
  detectionsFound: 0,
  processedTxs: 0,
  perTracker: {}, // id -> { name, detectCalls, detectionsFound, processedTxs }
}

function ensureTrackerMetrics(trk) {
  const id = trk.id || trk.name
  if (!watcherMetrics.perTracker[id]) {
    watcherMetrics.perTracker[id] = { name: trk.name, detectCalls: 0, detectionsFound: 0, processedTxs: 0 }
  } else if (watcherMetrics.perTracker[id].name !== trk.name) {
    watcherMetrics.perTracker[id].name = trk.name
  }
}

function getWatcherMetrics() {
  return {
    blocksScanned: watcherMetrics.blocksScanned,
    receiptsScanned: watcherMetrics.receiptsScanned,
    detectCalls: watcherMetrics.detectCalls,
    detectionsFound: watcherMetrics.detectionsFound,
    processedTxs: watcherMetrics.processedTxs,
    perTracker: watcherMetrics.perTracker,
  }
}

async function initTrackers({ redis, io, runtime, queue }) {
  const provider = new ethers.providers.JsonRpcProvider(runtime.chainRpc || DEFAULTS.chainRpc)
  const signer = runtime.signer.privateKey ? new ethers.Wallet(runtime.signer.privateKey, provider) : null
  await initRegistry({ provider, signer, redis, io, queue, runtime })
  return { provider, signer }
}

function startBlockWatcher({ provider, redis, io }) {
  // Use small LRU caches instead of unbounded Sets to avoid memory growth
  const makeLRUSet = (limit) => {
    const map = new Map()
    return {
      has: (k) => map.has(k),
      add: (k) => {
        if (map.has(k)) return
        map.set(k, true)
        if (map.size > limit) {
          const first = map.keys().next().value
          map.delete(first)
        }
      },
      size: () => map.size,
    }
  }
  const seenTxs = makeLRUSet(5000)
  const claimedTxs = makeLRUSet(5000)
  const emittedDetections = makeLRUSet(20000) // key = `${tx}:${trackerId}`
  const emittedTxEvents = makeLRUSet(20000) // key = tx

  async function scanBlock(blockNumber) {
    try {
      const block = await provider.getBlockWithTransactions(blockNumber)
      if (!block) return
      watcherMetrics.blocksScanned += 1
      const receiptsSet = await Promise.allSettled((block.transactions || []).map((tx) => provider.getTransactionReceipt(tx.hash)))
      const receipts = receiptsSet.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)
      watcherMetrics.receiptsScanned += receipts.length
  // Run detection across all trackers (enabled and disabled) but only process enabled ones.
  const trackers = getAllTrackers()
      //logger.info({ blockNumber, txCount: (block.transactions||[]).length, receiptCount: receipts.length, activeTrackers: trackers.length }, 'block watcher: scanning')
      for (const receipt of receipts) {
        if (!receipt || !receipt.logs) continue
        if (seenTxs.has(receipt.transactionHash)) continue
        const detections = []
        for (const trk of trackers) {
          try {
            ensureTrackerMetrics(trk)
            watcherMetrics.detectCalls += 1
            watcherMetrics.perTracker[trk.id].detectCalls += 1
            const detRes = await trk.detect?.(receipt, { wantReason: true })
            const baseEvt = { tx: receipt.transactionHash, blockNumber, trackerId: trk.id, tracker: trk.name, ts: Date.now() }
            const key = `${baseEvt.tx}:${baseEvt.trackerId}`
            if (detRes && detRes.reason) {
              if (!emittedDetections.has(key)) {
                const evt = { ...baseEvt, pass: false, reason: detRes.reason }
                io.emit('detection', evt)
                try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
                emittedDetections.add(key)
              }
            } else if (detRes) {
              if (!emittedDetections.has(key)) {
                const evt = { ...baseEvt, pass: true }
                io.emit('detection', evt)
                try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
                emittedDetections.add(key)
              }
              detections.push({ trk, det: detRes })
            } else {
              // Do not emit or store "no-match" events to reduce memory churn
            }
          } catch (_) {}
        }
        if (detections.length) {
          logger.info({ blockNumber, transactionHash: receipt.transactionHash, detections: detections.map(d=>d.trk.name) }, 'block watcher: detections found')
          watcherMetrics.detectionsFound += detections.length
          for (const d of detections) {
            ensureTrackerMetrics(d.trk)
            watcherMetrics.perTracker[d.trk.id].detectionsFound += 1
          }
          detections.sort((a, b) => (b.trk.priority ?? 0) - (a.trk.priority ?? 0))
          const winner = detections[0]
          if (winner.trk.enabled) {
            try {
              claimedTxs.add(receipt.transactionHash)
              seenTxs.add(receipt.transactionHash)
              await winner.trk.process(winner.det)
              logger.info({ blockNumber, transactionHash: receipt.transactionHash, tracker: winner.trk.name }, 'block watcher: processed by tracker')
              ensureTrackerMetrics(winner.trk)
              watcherMetrics.processedTxs += 1
              watcherMetrics.perTracker[winner.trk.id].processedTxs += 1
            } catch (_) {}
          } else {
            // still mark as seen to avoid repeating detection spam for disabled trackers
            logger.debug && logger.debug({ blockNumber, transactionHash: receipt.transactionHash, tracker: winner.trk.name }, 'block watcher: detection for disabled tracker (skipped process)')
            seenTxs.add(receipt.transactionHash)
          }
        }
        // Emit per-tx aggregated event
        try {
          const { extractTokenTransfers, getKnownTokenSet, filterKnownTokens, pickPrimaryToken, buildDexscreenerLink } = require('../lib/detectionUtils')
          const pass = detections.length > 0
          const { list, counts } = extractTokenTransfers(receipt)
          const known = getKnownTokenSet()
          const filtered = filterKnownTokens(list, known)
          const token = pickPrimaryToken(filtered, counts)
          const dexscreener = buildDexscreenerLink('base', token)
          const evtTx = { tx: receipt.transactionHash, blockNumber, pass, token, dexscreener, ts: Date.now() }
          const key = receipt.transactionHash
          if (!emittedTxEvents.has(key)) {
            io.emit('detection:tx', evtTx)
            try { if (redis) { await redis.lpush('detections:tx', JSON.stringify(evtTx)); await redis.ltrim('detections:tx', 0, 499) } } catch (_) {}
            emittedTxEvents.add(key)
          }
        } catch (_) {}
      }
      io.emit('chain:block', { blockNumber })
    } catch (_) {}
  }

  const intervalMs = 2000
  let nextBlock = null
  let bootstrapped = false
  const SCAN_KEY = 'scanner:lastBlock'

  async function bootstrap() {
    if (bootstrapped) return
    bootstrapped = true
    try {
      // resume from redis if available
      if (redis) {
        const saved = await redis.get(SCAN_KEY)
        if (saved && !isNaN(Number(saved))) {
          nextBlock = Number(saved) + 1
        }
      }
      if (nextBlock == null) {
        nextBlock = await provider.getBlockNumber()
      }
    } catch (_) {
      // fallback to provider latest
      try { nextBlock = await provider.getBlockNumber() } catch (_) {}
    }
  }

  const tick = async () => {
    try {
      if (!bootstrapped) await bootstrap()
      const latest = await provider.getBlockNumber()
      if (nextBlock == null) nextBlock = latest
      if (nextBlock > latest) {
        // chain not yet at nextBlock, wait for next tick
        return setTimeout(tick, intervalMs)
      }
      // Try to get the next block
      let got = false
      try {
        const block = await provider.getBlockWithTransactions(nextBlock)
        if (block) {
          await scanBlock(nextBlock)
          // persist last scanned
          try { if (redis) await redis.set(SCAN_KEY, String(nextBlock)) } catch (_) {}
          nextBlock += 1
          got = true
        }
      } catch (_) {}

      if (!got) {
        // If we were ahead, realign with current tip to catch the next block ASAP
        try {
          const tip = await provider.getBlockNumber()
          nextBlock = tip
        } catch (_) {}
      }
    } catch (_) {
      // ignore errors and continue
    } finally {
      setTimeout(tick, intervalMs)
    }
  }

  // kick off polling loop
  setTimeout(tick, 0)
}

// Faster log-based watcher: subscribes to relevant addresses/topics declared by trackers
function startLogWatcher({ provider, redis, io }) {
  // State (bounded to avoid unbounded memory usage)
  const makeLRUSet = (limit) => {
    const map = new Map()
    return {
      has: (k) => map.has(k),
      add: (k) => {
        if (map.has(k)) return
        map.set(k, true)
        if (map.size > limit) {
          const first = map.keys().next().value
          map.delete(first)
        }
      },
      size: () => map.size,
    }
  }
  const seenTxs = makeLRUSet(5000)
  const claimedTxs = makeLRUSet(5000)
  const emittedDetections = makeLRUSet(20000) // key = `${tx}:${trackerId}`
  const emittedTxEvents = makeLRUSet(20000) // key = tx
  let fromBlock = null
  let bootstrapped = false
  const SCAN_KEY = 'scanner:lastBlock'
  const intervalMs = 1500

  async function bootstrap() {
    if (bootstrapped) return
    bootstrapped = true
    try {
      if (redis) {
        const saved = await redis.get(SCAN_KEY)
        if (saved && !isNaN(Number(saved))) fromBlock = Number(saved) + 1
      }
      if (fromBlock == null) fromBlock = await provider.getBlockNumber()
    } catch (_) {
      try { fromBlock = await provider.getBlockNumber() } catch (__) {}
    }
  }

  function buildFilters(trackers) {
    // Each tracker can expose a getLogFilters(): Array<{address?:string|string[], topics?:(string|null)[]|((string|null)[])[] }>
    // We'll normalize and merge by address where possible; fallback to multiple filters to stay under node limits.
    const filters = []
    for (const t of trackers) {
      try {
        const fns = typeof t.getLogFilters === 'function' ? t.getLogFilters() : defaultFiltersForTracker(t)
        if (Array.isArray(fns)) filters.push(...fns)
      } catch (_) {}
    }
    // Compact basic duplicates
    const key = (f) => `${JSON.stringify(f.address||null)}|${JSON.stringify(f.topics||null)}`
    const map = new Map()
    for (const f of filters) {
      map.set(key(f), f)
    }
    return Array.from(map.values())
  }

  function defaultFiltersForTracker(trk) {
    // Heuristic defaults based on known tracker families to avoid scanning all blocks
    const name = (trk.name || '').toLowerCase()
    try {
      if (name.startsWith('uniswapv2') || name.startsWith('baseswapv2')) {
        // Factory PairCreated
        const factory = trk.settings?.factory
        if (!factory) return []
        const topic = ethers.utils.id('PairCreated(address,address,address,uint256)')
        return [{ address: factory, topics: [topic] }]
      }
      if (name.startsWith('uniswapv3')) {
        const factory = trk.settings?.factory
        if (!factory) return []
        const topic = ethers.utils.id('PoolCreated(address,address,uint24,int24,address)')
        return [{ address: factory, topics: [topic] }]
      }
      if (name.startsWith('uniswapv4')) {
        const poolManager = trk.settings?.poolManager
        if (!poolManager) return []
        const topic = ethers.utils.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
        return [{ address: poolManager, topics: [topic] }]
      }
    } catch (_) {}
    return []
  }

  async function tick() {
    try {
      if (!bootstrapped) await bootstrap()
      const latest = await provider.getBlockNumber()
      if (fromBlock == null) fromBlock = latest
      if (fromBlock > latest) return setTimeout(tick, intervalMs)

  // Use all trackers for detection (enabled+disabled) but process only enabled
  const trackers = getAllTrackers()
      if (!trackers.length) {
        // Nothing to watch; advance to latest and wait
        fromBlock = latest
        return setTimeout(tick, 2000)
      }
      const filters = buildFilters(trackers)
      // To avoid giant ranges, cap to small window
      const toBlock = Math.min(latest, fromBlock + 4)
      let logs = []
      for (const f of filters) {
        try {
          const lf = { ...f, fromBlock, toBlock }
          const set = await provider.getLogs(lf)
          if (set && set.length) logs.push(...set)
        } catch (e) {
          // Some nodes disallow large ranges; try per-block fallback
          for (let b = fromBlock; b <= toBlock; b++) {
            try {
              const set = await provider.getLogs({ ...f, fromBlock: b, toBlock: b })
              if (set && set.length) logs.push(...set)
            } catch (_) {}
          }
        }
      }

      // Group logs by txHash
      const byTx = new Map()
      for (const lg of logs) {
        if (!lg || !lg.transactionHash) continue
        const arr = byTx.get(lg.transactionHash) || []
        arr.push(lg)
        byTx.set(lg.transactionHash, arr)
      }

      // Fetch receipts only for matching txs
      const txHashes = Array.from(byTx.keys())
      const results = await Promise.allSettled(txHashes.map((h) => provider.getTransactionReceipt(h)))
      const receipts = []
      for (let i = 0; i < results.length; i++) {
        const r = results[i]
        if (r.status === 'fulfilled' && r.value) receipts.push(r.value)
      }
      watcherMetrics.receiptsScanned += receipts.length
      if (toBlock >= fromBlock) watcherMetrics.blocksScanned += (toBlock - fromBlock + 1)

      for (const receipt of receipts) {
        if (!receipt || !receipt.logs) continue
        if (seenTxs.has(receipt.transactionHash)) continue
        const detections = []
        for (const trk of trackers) {
          try {
            ensureTrackerMetrics(trk)
            watcherMetrics.detectCalls += 1
            watcherMetrics.perTracker[trk.id].detectCalls += 1
            const detRes = await trk.detect?.(receipt, { wantReason: true })
            const baseEvt = { tx: receipt.transactionHash, blockNumber: receipt.blockNumber, trackerId: trk.id, tracker: trk.name, ts: Date.now() }
            const key = `${baseEvt.tx}:${baseEvt.trackerId}`
            if (detRes && detRes.reason) {
              if (!emittedDetections.has(key)) {
                const evt = { ...baseEvt, pass: false, reason: detRes.reason }
                io.emit('detection', evt)
                try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
                emittedDetections.add(key)
              }
            } else if (detRes) {
              if (!emittedDetections.has(key)) {
                const evt = { ...baseEvt, pass: true }
                io.emit('detection', evt)
                try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
                emittedDetections.add(key)
              }
              detections.push({ trk, det: detRes })
            } else {
              // Do not emit/store "no-match" events; they are extremely chatty and cause memory growth
            }
          } catch (_) {}
        }
        if (detections.length) {
          detections.sort((a, b) => (b.trk.priority ?? 0) - (a.trk.priority ?? 0))
          const winner = detections[0]
          try {
            if (winner.trk.enabled) {
              claimedTxs.add(receipt.transactionHash)
              seenTxs.add(receipt.transactionHash)
              await winner.trk.process(winner.det)
              ensureTrackerMetrics(winner.trk)
              watcherMetrics.detectionsFound += detections.length
              watcherMetrics.processedTxs += 1
              watcherMetrics.perTracker[winner.trk.id].detectionsFound += 1
              watcherMetrics.perTracker[winner.trk.id].processedTxs += 1
            } else {
              // For disabled winner, record detections count but skip processing and processedTxs metric
              watcherMetrics.detectionsFound += detections.length
              ensureTrackerMetrics(winner.trk)
              watcherMetrics.perTracker[winner.trk.id].detectionsFound += 1
              // Mark seen to avoid repeating detections flood for same tx
              seenTxs.add(receipt.transactionHash)
              logger.debug && logger.debug({ blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, tracker: winner.trk.name }, 'log watcher: detection for disabled tracker (skipped process)')
            }
          } catch (_) {}
        }
        // Emit per-tx aggregated event
        try {
          const { extractTokenTransfers, getKnownTokenSet, filterKnownTokens, pickPrimaryToken, buildDexscreenerLink } = require('../lib/detectionUtils')
          const pass = detections.length > 0
          const { list, counts } = extractTokenTransfers(receipt)
          const known = getKnownTokenSet()
          const filtered = filterKnownTokens(list, known)
          const token = pickPrimaryToken(filtered, counts)
          const dexscreener = buildDexscreenerLink('base', token)
          const evtTx = { tx: receipt.transactionHash, blockNumber: receipt.blockNumber, pass, token, dexscreener, ts: Date.now() }
          const key = receipt.transactionHash
          if (!emittedTxEvents.has(key)) {
            io.emit('detection:tx', evtTx)
            try { if (redis) { await redis.lpush('detections:tx', JSON.stringify(evtTx)); await redis.ltrim('detections:tx', 0, 499) } } catch (_) {}
            emittedTxEvents.add(key)
          }
        } catch (_) {}
      }

      // persist last scanned block
      try { if (redis) await redis.set(SCAN_KEY, String(toBlock)) } catch (_) {}
      fromBlock = toBlock + 1
      io.emit('chain:block', { blockNumber: toBlock })
    } catch (_) {
      // ignore and continue
    } finally {
      setTimeout(tick, intervalMs)
    }
  }

  setTimeout(tick, 0)
}

module.exports = { initTrackers, startBlockWatcher, startLogWatcher, getWatcherMetrics }
