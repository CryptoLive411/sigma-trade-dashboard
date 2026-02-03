const { ethers } = require('ethers')
const { logger } = require('./logger')
const { getActiveTrackers, getAllTrackers } = require('../trackers/registry')

// Lightweight LRU Set implemented with a Map (preserves insertion order)
function makeLRUSet(limit) {
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
    clear: () => map.clear(),
  }
}

function defaultFiltersForTracker(trk) {
  const name = (trk.name || '').toLowerCase()
  try {
    if (name.startsWith('uniswapv2') || name.startsWith('baseswapv2')) {
      const factory = trk.settings?.factory
      if (!factory) return []
      const topic = ethers.utils.id('PairCreated(address,address,address,uint256)')
      return [{ address: factory, topics: [topic] }]
    }
    if (name.startsWith('uniswapv3') || name.startsWith('baseswapv3')) {
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

function buildFilters(trackers) {
  const filters = []
  for (const t of trackers) {
    try {
      const fns = typeof t.getLogFilters === 'function' ? t.getLogFilters() : defaultFiltersForTracker(t)
      if (Array.isArray(fns)) filters.push(...fns)
    } catch (_) {}
  }
  const key = (f) => `${JSON.stringify(f.address||null)}|${JSON.stringify(f.topics||null)}`
  const map = new Map()
  for (const f of filters) map.set(key(f), f)
  return Array.from(map.values())
}

function ensureTrackerMetrics(store, trk) {
  const id = trk.id || trk.name
  if (!store.perTracker[id]) {
    store.perTracker[id] = { name: trk.name, detectCalls: 0, detectionsFound: 0, processedTxs: 0 }
  } else if (store.perTracker[id].name !== trk.name) {
    store.perTracker[id].name = trk.name
  }
}

// Extract pool/token data from receipt for all DEX types
async function extractPoolDataFromReceipt(receipt, trk, detRes, provider) {
  const name = (trk.name || '').toLowerCase()
  const ABI = require('../trackers/abi')
  let data = {}
  
  // Known tokens to exclude (WETH, USDC, etc.)
  const knownTokens = [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  ].map(addr => addr.toLowerCase())
  
  const isKnownToken = (addr) => knownTokens.includes((addr || '').toLowerCase())
  
  try {
    // UniswapV2 / BaseSwapV2
    if (name.includes('v2')) {
      const factory = trk.settings?.factory
      if (!factory) return data
      const topic = ethers.utils.id('PairCreated(address,address,address,uint256)')
      const iface = new ethers.utils.Interface([ABI.UniswapV2.FactoryPairCreated])
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === factory.toLowerCase() && log.topics[0] === topic) {
          const ev = iface.parseLog(log)
          data.token0 = ev.args.token0
          data.token1 = ev.args.token1
          data.pair = ev.args.pair
          data.dex = name.includes('baseswap') ? 'BaseSwap' : 'Uniswap'
          data.version = 'v2'
          // Get token - prioritize non-known tokens
          if (!isKnownToken(data.token0) && !isKnownToken(data.token1)) {
            // Both are unknown, default to token1
            data.token = data.token1
          } else if (!isKnownToken(data.token0)) {
            data.token = data.token0
          } else if (!isKnownToken(data.token1)) {
            data.token = data.token1
          } else {
            // Both are known (rare), default to token1
            data.token = data.token1
          }
          // Build DEX links
          data.dexscreener = `https://dexscreener.com/base/${data.token}`
          data.uniswapLink = `https://app.uniswap.org/explore/tokens/base/${data.token}`
          break
        }
      }
    }
    
    // UniswapV3 / BaseSwapV3
    if (name.includes('v3')) {
      const factory = trk.settings?.factory
      if (!factory) return data
      const topic = ethers.utils.id('PoolCreated(address,address,uint24,int24,address)')
      const iface = new ethers.utils.Interface([ABI.UniswapV3.FactoryPoolCreated])
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === factory.toLowerCase() && log.topics[0] === topic) {
          const ev = iface.parseLog(log)
          data.token0 = ev.args.token0
          data.token1 = ev.args.token1
          data.fee = ev.args.fee
          data.pool = ev.args.pool
          data.dex = name.includes('baseswap') ? 'BaseSwap' : 'Uniswap'
          data.version = 'v3'
          // Get token - prioritize non-known tokens
          if (!isKnownToken(data.token0) && !isKnownToken(data.token1)) {
            data.token = data.token1
          } else if (!isKnownToken(data.token0)) {
            data.token = data.token0
          } else if (!isKnownToken(data.token1)) {
            data.token = data.token1
          } else {
            data.token = data.token1
          }
          data.dexscreener = `https://dexscreener.com/base/${data.token}`
          data.uniswapLink = `https://app.uniswap.org/explore/pools/base/${data.pool}`
          break
        }
      }
    }
    
    // UniswapV4
    if (name.includes('v4')) {
      const poolManager = trk.settings?.poolManager
      if (!poolManager) return data
      const topic = ethers.utils.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
      const iface = new ethers.utils.Interface([ABI.UniswapV4.PoolManagerInitialize])
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() === poolManager.toLowerCase() && log.topics[0] === topic) {
          const ev = iface.parseLog(log)
          data.currency0 = ev.args.currency0
          data.currency1 = ev.args.currency1
          data.fee = ev.args.fee
          data.tickSpacing = ev.args.tickSpacing
          data.hooks = ev.args.hooks
          data.dex = 'Uniswap'
          data.version = 'v4'
          // Get token - prioritize non-known tokens
          if (!isKnownToken(data.currency0) && !isKnownToken(data.currency1)) {
            data.token = data.currency1
          } else if (!isKnownToken(data.currency0)) {
            data.token = data.currency0
          } else if (!isKnownToken(data.currency1)) {
            data.token = data.currency1
          } else {
            data.token = data.currency1
          }
          data.dexscreener = `https://dexscreener.com/base/${data.token}`
          data.uniswapLink = `https://app.uniswap.org/explore/tokens/base/${data.token}`
          break
        }
      }
    }
    
    // Fetch token metadata if we have a token
    if (data.token) {
      try {
        const { ensureTokenMeta } = require('../trackers/tokens')
        if (provider) {
          const meta = await ensureTokenMeta(provider, data.token)
          if (meta) {
            data.tokenName = meta.name
            data.tokenSymbol = meta.symbol
            data.tokenDecimals = meta.decimals
          } else {
            logger.debug({ token: data.token }, 'ensureTokenMeta returned null')
          }
        } else {
          logger.debug('Provider not available for token metadata fetch')
        }
      } catch (err) {
        logger.debug({ err: err.message, token: data.token }, 'Failed to fetch token metadata')
      }
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'extractPoolDataFromReceipt failed')
  }
  
  return data
}

// Public start function. Uses a WebSocket provider to eth_subscribe to logs and dispatches receipts to trackers.
// Keep a module-level reference for metrics access
let lastInstance = null

async function startLogSubscriber({ httpProvider, redis, io, runtime }) {

  // Metrics (in-memory)
  const metrics = {
    logEvents: 0,
    receiptsScanned: 0,
    processedTxs: 0,
    detectionsFound: 0,
    detectCalls: 0,
    perTracker: {},
  }

  // De-dupe and backpressure controls
  const seenTxs = makeLRUSet(10000)
  const claimedTxs = makeLRUSet(10000)
  const emittedDetections = makeLRUSet(40000) // key = `${tx}:${trackerId}`
  const emittedTxEvents = makeLRUSet(40000) // key = tx

  // Buffer logs grouped by tx
  const logBuffer = new Map() // txHash -> { logs: [], blockNumber }
  let latestBlock = null

  // Resolve WS URL
  const wsUrl = runtime?.chainWs || process.env.CHAIN_WS || deriveWsUrl(runtime?.chainRpc || process.env.CHAIN_RPC)
  if (!wsUrl) {
    logger.warn('No CHAIN_WS provided and could not derive WS URL from CHAIN_RPC; falling back to polling log watcher.')
    return require('../trackers').startLogWatcher({ provider: httpProvider, redis, io })
  }

  let wsProvider = null
  let subscriptions = [] // [{ filter, handler }]
  let connected = false
  let reconnectTimer = null

  function deriveAndSubscribe() {
    // Use ALL trackers for filter subscription (even disabled ones)
    // This ensures we detect all pools for the detections page
    const allTrackers = getAllTrackers()
    const filters = buildFilters(allTrackers)
    // Unsubscribe previous
    for (const s of subscriptions) {
      try { wsProvider.off(s.filter, s.handler) } catch (_) {}
    }
    subscriptions = []
    for (const f of filters) {
      const handler = (log) => onLog(log)
      try {
        wsProvider.on(f, handler)
        subscriptions.push({ filter: f, handler })
      } catch (e) {
        logger.warn({ err: e?.message }, 'failed to subscribe to filter; continuing')
      }
    }
  logger.info({ count: subscriptions.length }, 'log subscriber: subscribed filters')
  }

  function onLog(log) {
    if (!log || !log.transactionHash) return
    metrics.logEvents += 1
    const tx = log.transactionHash
    const entry = logBuffer.get(tx) || { logs: [], blockNumber: log.blockNumber }
    entry.logs.push(log)
    entry.blockNumber = log.blockNumber || entry.blockNumber
    logBuffer.set(tx, entry)
    // small tick to process soon
    scheduleFlush()
  }

  let flushTimer = null
  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(flush, 300) // batch logs briefly
  }

  async function flush() {
    flushTimer = null
    const entries = Array.from(logBuffer.entries())
    if (!entries.length) return
    logBuffer.clear()
    const txHashes = entries.map(([tx]) => tx)
    // Use WS provider if available; fallback to HTTP provider
    const p = (wsProvider || httpProvider)
    const results = await Promise.allSettled(txHashes.map((h) => p.getTransactionReceipt(h)))
    const receipts = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'fulfilled' && r.value) receipts.push(r.value)
    }
    metrics.receiptsScanned += receipts.length
    await processReceipts(receipts)
  }

  async function processReceipts(receipts) {
    const { extractTokenTransfers, getKnownTokenSet, filterKnownTokens, pickPrimaryToken, buildDexscreenerLink } = require('./detectionUtils')
    // Use ALL trackers for detection (even disabled ones) to populate detections page
    const allTrackers = getAllTrackers()
    if (!allTrackers.length) return
    
    for (const receipt of receipts) {
      if (!receipt || !receipt.logs) continue
      if (seenTxs.has(receipt.transactionHash)) continue
  const detections = []
      for (const trk of allTrackers) {
        try {
          ensureTrackerMetrics(metrics, trk)
          metrics.detectCalls += 1
          metrics.perTracker[trk.id].detectCalls += 1
          const detRes = await trk.detect?.(receipt, { wantReason: true })
          const baseEvt = { tx: receipt.transactionHash, blockNumber: receipt.blockNumber, trackerId: trk.id, tracker: trk.name, ts: Date.now(), enabled: trk.enabled }
          const key = `${baseEvt.tx}:${baseEvt.trackerId}`
          
          // Extract pool/token data for all detections (pass or fail)
          // Pass httpProvider for token metadata fetching
          let poolData = null
          try {
            poolData = await extractPoolDataFromReceipt(receipt, trk, detRes, httpProvider)
          } catch (err) {
            logger.debug({ err: err.message, tx: receipt.transactionHash }, 'extractPoolDataFromReceipt error')
          }
          
          // Check if detection has valid token metadata
          // poolData.token exists AND has name AND symbol
          const hasValidToken = !!(poolData && poolData.token && poolData.tokenName && poolData.tokenSymbol)
          
          // Debug logging for token metadata
          if (poolData && poolData.token) {
            /*logger.debug({ 
              tx: receipt.transactionHash.slice(0, 10),
              tracker: trk.name,
              token: poolData.token.slice(0, 10),
              hasName: !!poolData.tokenName,
              hasSymbol: !!poolData.tokenSymbol,
              hasValidToken
            }, 'Token metadata check')*/
          }
          
          // Add creator address (from transaction sender - no extra RPC call)
          // Fallback to 'to' address if 'from' is not available (shouldn't happen but be safe)
          const creator = receipt.from || receipt.to || null
          
          if (detRes && detRes.reason) {
            if (!emittedDetections.has(key)) {
              const evt = { ...baseEvt, pass: false, reason: detRes.reason, creator, hasToken: hasValidToken, ...poolData }
              
              // Track creator stats for ALL detections where we have a token (pass or fail)
              if (creator && poolData && poolData.token) {
                try {
                  const { incrementCreatorTokens, getCreatorTokenCount } = require('./creatorStats')
                  await incrementCreatorTokens(redis, creator)
                  
                  // Store permanent token->creator mapping
                  const tokenKey = poolData.token.toLowerCase()
                  await redis.hset('token:creators', tokenKey, creator)
                  
                  // Enrich event with creator token count for websocket
                  const creatorTokens = await getCreatorTokenCount(redis, creator)
                  evt.creatorTokens = creatorTokens
                } catch (_) {}
              }
              
              io.emit('detection', evt)
              try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
              emittedDetections.add(key)
            }
          } else if (detRes) {
            if (!emittedDetections.has(key)) {
              const evt = { ...baseEvt, pass: true, creator, hasToken: hasValidToken, ...poolData }
              
              // Track creator stats for ALL detections where we have a token (pass or fail)
              if (creator && poolData && poolData.token) {
                try {
                  const { incrementCreatorTokens, getCreatorTokenCount } = require('./creatorStats')
                  await incrementCreatorTokens(redis, creator)
                  
                  // Store permanent token->creator mapping
                  const tokenKey = poolData.token.toLowerCase()
                  await redis.hset('token:creators', tokenKey, creator)
                  
                  // Enrich event with creator token count for websocket
                  const creatorTokens = await getCreatorTokenCount(redis, creator)
                  evt.creatorTokens = creatorTokens
                } catch (_) {}
              }
              
              io.emit('detection', evt)
              try { if (redis) { await redis.lpush('detections:events', JSON.stringify(evt)); await redis.ltrim('detections:events', 0, 499) } } catch (_) {}
              emittedDetections.add(key)
            }
            // Only add to detections array if tracker is enabled for trading
            if (trk.enabled) {
              detections.push({ trk, det: detRes })
            }
          }
        } catch (_) {}
      }
      // Only process trades for enabled trackers that passed detection
      if (detections.length) {
        detections.sort((a, b) => (b.trk.priority ?? 0) - (a.trk.priority ?? 0))
        const winner = detections[0]
        try {
          claimedTxs.add(receipt.transactionHash)
          seenTxs.add(receipt.transactionHash)
          await winner.trk.process(winner.det)
          ensureTrackerMetrics(metrics, winner.trk)
          metrics.detectionsFound += detections.length
          metrics.processedTxs += 1
          metrics.perTracker[winner.trk.id].detectionsFound += 1
          metrics.perTracker[winner.trk.id].processedTxs += 1
        } catch (_) {}
      }
      // Emit a per-tx aggregated event (pass if any tracker passed, otherwise if any tracker failed then fail)
      try {
        const pass = detections.length > 0
        // Build token suggestions from Transfer logs
        const { list, counts } = extractTokenTransfers(receipt)
        const known = getKnownTokenSet(require('./runtimeConfig')?.DEFAULTS)
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
      // live-only: do not persist block progress
    }
  }

  function deriveWsUrl(httpUrl) {
    try {
      if (!httpUrl) return null
      const u = new URL(httpUrl)
      if (u.protocol === 'http:') u.protocol = 'ws:'
      if (u.protocol === 'https:') u.protocol = 'wss:'
      return u.toString()
    } catch (_) {
      return null
    }
  }

  // live-only: no backfill

  async function connect() {
    try {
      wsProvider = new ethers.providers.WebSocketProvider(wsUrl)
      // Defensive patch: guard against ethers WebSocketProvider crash when a stray message lacks a matching request (request.callback undefined)
      try {
        const ws = wsProvider._websocket
        if (ws && ws.onmessage && !ws.__safePatched) {
          const originalOnMessage = ws.onmessage
          ws.onmessage = (event) => {
            try {
              originalOnMessage(event)
            } catch (err) {
              if (err && /callback/.test(String(err.message || err))) {
                logger.warn({ err: err.message }, 'ignored stray websocket response (no matching request)')
                return
              }
              throw err
            }
          }
          ws.__safePatched = true
        }
      } catch (_) {}
      connected = true
      logger.info({ url: wsUrl }, 'log subscriber: connected')
      // subscribe to new blocks for heartbeat
      wsProvider.on('block', (bn) => {
        latestBlock = bn
        io.emit('chain:block', { blockNumber: bn })
      })
      wsProvider._websocket?.on('close', () => onDisconnect('close'))
      wsProvider._websocket?.on('error', (err) => onDisconnect('error', err))
      // Update subscriptions to current trackers
      deriveAndSubscribe()
      // Live-only: no backfill
    } catch (e) {
      logger.error({ err: e?.message }, 'log subscriber: connection failed')
      scheduleReconnect()
    }
  }

  function onDisconnect(why, err) {
    if (!connected) return
    connected = false
    logger.warn({ why, err: err?.message }, 'log subscriber: disconnected')
    try { wsProvider.removeAllListeners() } catch (_) {}
    try { wsProvider._websocket?.terminate?.() } catch (_) {}
    wsProvider = null
    subscriptions = []
    scheduleReconnect()
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(async () => { reconnectTimer = null; await connect() }, 1500)
  }

  // Periodically refresh subscriptions in case trackers updated
  setInterval(() => { if (connected && wsProvider) deriveAndSubscribe() }, 15000)

  // Start
  await connect()

  // Expose a minimal control API if needed later
  lastInstance = {
    metrics,
    stop: () => {
      try { if (flushTimer) clearTimeout(flushTimer) } catch (_) {}
      try { if (reconnectTimer) clearTimeout(reconnectTimer) } catch (_) {}
      try { wsProvider?.removeAllListeners() } catch (_) {}
      try { wsProvider?._websocket?.terminate?.() } catch (_) {}
    }
  }
  return lastInstance
}

function getSubscriberMetrics() {
  if (!lastInstance) return null
  return lastInstance.metrics
}

module.exports = { startLogSubscriber, getSubscriberMetrics }
