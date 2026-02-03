const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { getRegistry, getAllTrackers } = require('../trackers/registry')
const { setManual, getManual, setV3Params, setV4Params } = require('../lib/manual')
const { ethers } = require('ethers')
const ABI = require('../trackers/abi')

function emitManualAction(req, payload) {
  try {
    const io = req.app.get('io')
    if (!io) return
    io.emit('manual:action', { timestamp: Date.now(), ...payload })
  } catch (_) {}
}

// Manual mode APIs (declare BEFORE dynamic "/:id" route)
router.get('/manual', requireAuth, async (req, res) => {
  try {
    const { trackerId, token } = req.query || {}
    if (!trackerId || !token) return res.status(400).json({ error: 'trackerId and token required' })
    const redis = req.app.get('redis')
    const cfg = await getManual(redis, { trackerId, token })
    return res.json({ ok: true, config: cfg })
  } catch (e) {
    return res.status(500).json({ error: 'failed to get manual' })
  }
})

router.post('/manual', requireAuth, async (req, res) => {
  try {
    const { trackerId, token, enabled, stopLossPct } = req.body || {}
    if (!trackerId || !token) return res.status(400).json({ error: 'trackerId and token required' })
    const redis = req.app.get('redis')
    const cfg = await setManual(redis, { trackerId, token, enabled: !!enabled, stopLossPct })
    const reg = getRegistry()
    const trk = reg[trackerId]
    emitManualAction(req, { type: 'config', trackerId, trackerName: trk?.name || null, token, config: cfg })
    return res.json({ ok: true, config: cfg })
  } catch (e) {
    return res.status(500).json({ error: 'failed to set manual' })
  }
})

router.post('/manual/buy', requireAuth, async (req, res) => {
  try {
    const { trackerId, token, amountEth } = req.body || {}
    if (!trackerId || !token || !amountEth) return res.status(400).json({ error: 'trackerId, token, amountEth required' })
    const reg = getRegistry()
    const trk = reg[trackerId]
    if (!trk || typeof trk.manualBuy !== 'function') return res.status(400).json({ error: 'tracker does not support manual buy' })
    const receipt = await trk.manualBuy({ token, amountEth })
  emitManualAction(req, { type: 'buy', trackerId, trackerName: trk?.name || null, token, amountEth: Number(amountEth), tx: receipt?.transactionHash || null })
    return res.json({ ok: true, tx: receipt?.transactionHash || null })
  } catch (e) {
    return res.status(500).json({ error: 'manual buy failed' })
  }
})

router.post('/manual/sell', requireAuth, async (req, res) => {
  try {
    const { trackerId, token, amountPct } = req.body || {}
    if (!trackerId || !token) return res.status(400).json({ error: 'trackerId and token required' })
    const reg = getRegistry()
    const trk = reg[trackerId]
    if (!trk || typeof trk.manualSell !== 'function') return res.status(400).json({ error: 'tracker does not support manual sell' })
    const receipt = await trk.manualSell({ token, amountPct })
  emitManualAction(req, { type: 'sell', trackerId, trackerName: trk?.name || null, token, amountPct: amountPct != null ? Number(amountPct) : null, tx: receipt?.transactionHash || null })
    return res.json({ ok: true, tx: receipt?.transactionHash || null })
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'manual sell failed' })
  }
})

// Manual sell by txid(s): detect tracker from receipt logs and execute a manual sell for the token
// Body: { txids: string[] | string (comma/whitespace-separated) | { txid }, amountPct?: number }
router.post('/sell-by-tx', requireAuth, async (req, res) => {
  const provider = req.app.get('provider')
  const redis = req.app.get('redis')
  const runtime = req.app.get('runtime')
  if (!provider) return res.status(500).json({ ok: false, error: 'no-provider' })
  try {
    let { txids, txid, txs, amountPct } = req.body || {}
    const list = []
    const addMaybe = (v) => { if (!v) return; if (Array.isArray(v)) list.push(...v); else if (typeof v === 'string') list.push(v); }
    addMaybe(txids); addMaybe(txid); addMaybe(txs)
    // Split comma/space separated strings
    const norm = []
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      for (const p of raw.split(/[\s,]+/).filter(Boolean)) norm.push(p.trim())
    }
    const uniq = Array.from(new Set(norm))
    if (!uniq.length) return res.status(400).json({ ok: false, error: 'txids required' })

    const trackers = getAllTrackers()
    const results = []
    for (const h of uniq) {
      try {
        const receipt = await provider.getTransactionReceipt(h)
        if (!receipt || !receipt.logs) { results.push({ tx: h, ok: false, error: 'no-receipt' }); continue }
        // Try all trackers to find a matching detection using log parsing (no side effects)
        const matches = []
        for (const trk of trackers) {
          try {
            const name = String(trk.name || '').toLowerCase()
            let detRes = null
            if (name.startsWith('uniswapv2') || name.startsWith('baseswapv2')) {
              const FACTORY = trk.settings?.factory
              if (FACTORY) {
                const topic = ethers.utils.id('PairCreated(address,address,address,uint256)')
                const iface = new ethers.utils.Interface([ABI.UniswapV2.FactoryPairCreated])
                for (const lg of receipt.logs) {
                  if (String(lg.address).toLowerCase() !== String(FACTORY).toLowerCase()) continue
                  if (String(lg.topics?.[0]||'').toLowerCase() !== topic.toLowerCase()) continue
                  try { const ev = iface.parseLog(lg); detRes = { token0: ev.args.token0, token1: ev.args.token1, pair: ev.args.pair }; break } catch (_) {}
                }
              }
            } else if (name.startsWith('uniswapv3') || name.startsWith('baseswapv3')) {
              const FACTORY = trk.settings?.factory
              if (FACTORY) {
                const topic = ethers.utils.id('PoolCreated(address,address,uint24,int24,address)')
                const iface = new ethers.utils.Interface([ABI.UniswapV3.FactoryPoolCreated])
                for (const lg of receipt.logs) {
                  if (String(lg.address).toLowerCase() !== String(FACTORY).toLowerCase()) continue
                  if (String(lg.topics?.[0]||'').toLowerCase() !== topic.toLowerCase()) continue
                  try { const ev = iface.parseLog(lg); detRes = { token0: ev.args.token0, token1: ev.args.token1, fee: ev.args.fee, pool: ev.args.pool }; break } catch (_) {}
                }
              }
            } else if (name.startsWith('uniswapv4')) {
              const PM = trk.settings?.poolManager
              if (PM) {
                const topic = ethers.utils.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
                const iface = new ethers.utils.Interface([ABI.UniswapV4.PoolManagerInitialize])
                for (const lg of receipt.logs) {
                  if (String(lg.address).toLowerCase() !== String(PM).toLowerCase()) continue
                  if (String(lg.topics?.[0]||'').toLowerCase() !== topic.toLowerCase()) continue
                  try { const ev = iface.parseLog(lg); detRes = { currency0: ev.args.currency0, currency1: ev.args.currency1, fee: ev.args.fee, tickSpacing: ev.args.tickSpacing, hooks: ev.args.hooks }; break } catch (_) {}
                }
              }
            }
            if (detRes) matches.push({ trk, det: detRes })
          } catch (_) {}
        }
        if (!matches.length) {
          // As a fallback, surface the primary token from logs even if we can't pick a tracker
          try {
            const { extractTokenTransfers, getKnownTokenSet, filterKnownTokens, pickPrimaryToken } = require('../lib/detectionUtils')
            const { list: addrs, counts } = extractTokenTransfers(receipt)
            const known = getKnownTokenSet(runtime)
            const filtered = filterKnownTokens(addrs, known)
            const token = pickPrimaryToken(filtered, counts)
            results.push({ tx: h, ok: false, error: 'no-tracker-match', token })
          } catch (_) {
            results.push({ tx: h, ok: false, error: 'no-tracker-match' })
          }
          continue
        }
        // Select the highest priority tracker
        matches.sort((a,b)=> (b.trk.priority||0)-(a.trk.priority||0))
  const winner = matches[0]
  const trk = winner.trk
  const det = winner.det
        // Derive token and seed manual params if needed per family
        let token = null
        const name = String(trk.name||'').toLowerCase()
        // UniswapV2/BaseSwapV2
        if (name.startsWith('uniswapv2') || name.startsWith('baseswapv2')) {
          const WETH = trk.settings?.weth || '0x4200000000000000000000000000000000000006'
          const token0 = det.token0 || det.currency0 || det.tokenIn || null
          const token1 = det.token1 || det.currency1 || det.tokenOut || null
          token = token0?.toLowerCase() === WETH.toLowerCase() ? token1 : token0
        } else if (name.startsWith('uniswapv3') || name.startsWith('baseswapv3')) {
          const WETH = trk.settings?.weth || '0x4200000000000000000000000000000000000006'
          const token0 = det.token0
          const token1 = det.token1
          token = token0?.toLowerCase() === WETH.toLowerCase() ? token1 : token0
          // Ensure v3 params are saved for manual flows
          try { if (token && det.pool && det.fee != null) await setV3Params(redis, { trackerId: trk.id, token, pool: det.pool, fee: det.fee }) } catch (_) {}
        } else if (name.startsWith('uniswapv4')) {
          const WETH = trk.settings?.weth || '0x4200000000000000000000000000000000000006'
          const isNative = (addr) => String(addr||'').toLowerCase() === WETH.toLowerCase() || String(addr||'').toLowerCase() === ethers.constants.AddressZero.toLowerCase()
          const currency0 = det.currency0
          const currency1 = det.currency1
          token = isNative(currency0) ? currency1 : currency0
          // Seed v4 params to enable manualSell to construct pool key
          try { if (currency0 && currency1 && det.fee != null && det.tickSpacing != null) await setV4Params(redis, { trackerId: trk.id, token, currency0, currency1, fee: det.fee, tickSpacing: det.tickSpacing, hooks: det.hooks || ethers.constants.AddressZero }) } catch (_) {}
        } else {
          // Other trackers: best effort token inference from logs
          try {
            const { extractTokenTransfers, getKnownTokenSet, filterKnownTokens, pickPrimaryToken } = require('../lib/detectionUtils')
            const { list: addrs, counts } = extractTokenTransfers(receipt)
            const known = getKnownTokenSet(runtime)
            const filtered = filterKnownTokens(addrs, known)
            token = pickPrimaryToken(filtered, counts)
          } catch (_) {}
        }
        if (!token) { results.push({ tx: h, ok: false, error: 'no-token-inferred', trackerId: trk.id, tracker: trk.name }); continue }
        if (typeof trk.manualSell !== 'function') { results.push({ tx: h, ok: false, error: 'tracker-unsupported', trackerId: trk.id, tracker: trk.name, token }); continue }
        try {
          const rc = await trk.manualSell({ token, amountPct })
          results.push({ tx: h, ok: true, trackerId: trk.id, tracker: trk.name, token, sellTx: rc?.transactionHash || null })
        } catch (e) {
          results.push({ tx: h, ok: false, trackerId: trk.id, tracker: trk.name, token, error: e?.message || 'sell-failed' })
        }
      } catch (e) {
        results.push({ tx: h, ok: false, error: e?.message || 'error' })
      }
    }

    // After selling, unwrap all WETH for the configured signer
    let unwrap = { attempted: false, ok: false, tx: null, error: null, amountWei: '0' }
    try {
      const reg = getRegistry()
      const trackersAny = Object.values(reg)
      const withSigner = trackersAny.find(t => t && t.signer && typeof t.signer.getAddress === 'function')
      const signer = withSigner?.signer
      const WETH = withSigner?.settings?.weth || '0x4200000000000000000000000000000000000006'
      const queue = req.app.get('txQueue')
      if (signer && queue && WETH) {
        const me = await signer.getAddress()
        const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, signer)
        const bal = await weth9.balanceOf(me)
        if (bal && !bal.isZero()) {
          unwrap.attempted = true
          unwrap.amountWei = bal.toString()
          const buildTx = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('withdraw', [bal]) })
          const rc = await queue.enqueue({ signer, buildTx, label: 'unwrap-weth', waitForConfirm: false, resolveOnSent: true })
          unwrap.ok = true
          unwrap.tx = rc?.transactionHash || null
        }
      }
    } catch (e) {
      unwrap.ok = false
      unwrap.error = e?.message || 'unwrap-failed'
    }

    const summary = { attempted: uniq.length, succeeded: results.filter(r=>r.ok).length, failed: results.filter(r=>!r.ok).length }

    results.forEach((r) => {
      if (r && r.ok && r.trackerId && r.token) {
        emitManualAction(req, { type: 'sell', trackerId: r.trackerId, trackerName: r.tracker || r.trackerName || null, token: r.token, via: 'sell-by-tx', tx: r.sellTx || r.tx || null })
      }
    })

    return res.json({ ok: true, summary, unwrap, results })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'sell-by-tx failed' })
  }
})

// Force-sell all open trades that have a confirmed buy and no confirmed sell
// Optional body: { trackerId?: string } to restrict to one tracker
router.post('/force-sell-open', requireAuth, async (req, res) => {
  const redis = req.app.get('redis')
  const { trackerId } = req.body || {}
  try {
    const ids = await redis.zrevrange('trades:index', 0, -1)
    const results = []
    const reg = getRegistry()
    for (const id of ids) {
      let trade
      try {
        const raw = await redis.get(`trade:${id}`)
        if (!raw) continue
        trade = JSON.parse(raw)
      } catch (_) { continue }
      if (!trade) continue
      if (trade.status && trade.status !== 'open') continue
      if (trackerId && trade.trackerId !== trackerId) continue
      const txs = Array.isArray(trade.txs) ? trade.txs : []
      const hasBuy = txs.some(x => x.action === 'buy' && x.phase === 'confirmed')
      const hasSell = txs.some(x => x.action === 'sell' && x.phase === 'confirmed')
      if (!hasBuy || hasSell) continue
      const trk = reg[trade.trackerId]
      if (!trk || typeof trk.manualSell !== 'function') {
        results.push({ tradeId: trade.id, trackerId: trade.trackerId, token: trade.token, ok: false, error: 'tracker-unsupported' })
        continue
      }
      try {
        const receipt = await trk.manualSell({ token: trade.token, amountPct: 100 })
        results.push({ tradeId: trade.id, trackerId: trade.trackerId, trackerName: trk?.name || null, token: trade.token, ok: true, tx: receipt?.transactionHash || null })
      } catch (e) {
        results.push({ tradeId: trade.id, trackerId: trade.trackerId, token: trade.token, ok: false, error: e?.message || 'sell-failed' })
      }
    }
    const summary = { attempted: results.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }

    results.forEach((r) => {
      if (r && r.ok && r.trackerId && r.token) {
        emitManualAction(req, { type: 'sell', trackerId: r.trackerId, trackerName: r.trackerName || null, token: r.token, via: 'force-sell-open', tx: r.tx || null })
      }
    })

    // After selling, unwrap all WETH for the configured signer
    let unwrap = { attempted: false, ok: false, tx: null, error: null, amountWei: '0' }
    try {
      const trackers = Object.values(reg)
      const withSigner = trackers.find(t => t && t.signer && typeof t.signer.getAddress === 'function')
      const signer = withSigner?.signer
      const WETH = withSigner?.settings?.weth || '0x4200000000000000000000000000000000000006'
      const queue = req.app.get('txQueue')
      if (signer && queue && WETH) {
        const me = await signer.getAddress()
        const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, signer)
        const bal = await weth9.balanceOf(me)
        if (bal && !bal.isZero()) {
          unwrap.attempted = true
          unwrap.amountWei = bal.toString()
          const buildTx = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('withdraw', [bal]) })
          const receipt = await queue.enqueue({ signer, buildTx, label: 'unwrap-weth', waitForConfirm: false, resolveOnSent: true })
          unwrap.ok = true
          unwrap.tx = receipt?.transactionHash || null
        }
      }
    } catch (e) {
      unwrap.ok = false
      unwrap.error = e?.message || 'unwrap-failed'
    }

    return res.json({ ok: true, summary, unwrap, results })
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'force-sell failed' })
  }
})

// Trades list and details
router.get('/', requireAuth, async (req, res) => {
  const redis = req.app.get('redis')
  const { listTrades } = require('../lib/trades')
  const { getCreatorTokenCounts } = require('../lib/creatorStats')
  const page = Math.max(0, Number(req.query.page || 0))
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize || 50)))
  const offset = page * pageSize
  try {
    let items = await listTrades(redis, { offset, limit: pageSize })
    
    // Enrich with creator information from recent detections
    if (items.length > 0 && redis) {
      try {
        const tokenKeys = [...new Set(
          items
            .map(t => (t.token || '').toLowerCase())
            .filter(Boolean)
        )]

        const tokenCreatorMap = {}

        if (tokenKeys.length > 0) {
          const pipeline = redis.pipeline()
          tokenKeys.forEach(token => pipeline.hget('token:creators', token))
          const results = await pipeline.exec()

          tokenKeys.forEach((token, idx) => {
            const res = results[idx]
            if (res && res[1]) tokenCreatorMap[token] = res[1]
          })

          // Fallback: scan recent detections only for tokens still missing
          const missingTokens = tokenKeys.filter(token => !tokenCreatorMap[token])
          if (missingTokens.length > 0) {
            const missingSet = new Set(missingTokens)
            const detectionsRaw = await redis.lrange('detections:events', 0, 199)
            if (detectionsRaw?.length) {
              for (const raw of detectionsRaw) {
                let det
                try { det = JSON.parse(raw) } catch (_) { det = null }
                if (!det || !det.token || !det.creator) continue
                const tokenKey = String(det.token).toLowerCase()
                if (missingSet.has(tokenKey) && !tokenCreatorMap[tokenKey]) {
                  tokenCreatorMap[tokenKey] = det.creator
                  missingSet.delete(tokenKey)
                  if (missingSet.size === 0) break
                }
              }
            }
          }
        }

        const creators = [...new Set(
          Object.values(tokenCreatorMap).map(addr => String(addr).toLowerCase())
        )]

        const creatorCounts = creators.length > 0 ? await getCreatorTokenCounts(redis, creators) : {}

        items = items.map(trade => {
          const tokenKey = trade.token ? trade.token.toLowerCase() : null
          if (tokenKey && tokenCreatorMap[tokenKey]) {
            const creatorAddr = tokenCreatorMap[tokenKey]
            const creatorKey = creatorAddr.toLowerCase()
            return {
              ...trade,
              creator: creatorAddr,
              creatorTokens: creatorCounts[creatorKey] || 0
            }
          }
          return trade
        })
      } catch (err) {
        // If enrichment fails, just return trades without creator info
        console.error('Failed to enrich trades with creator info:', err.message)
      }
    }
    
    res.json({ page, pageSize, items })
  } catch (e) {
    res.status(500).json({ error: 'failed to load trades' })
  }
})

router.get('/:id', requireAuth, async (req, res) => {
  const redis = req.app.get('redis')
  const { getTrade } = require('../lib/trades')
  try {
    const trade = await getTrade(redis, req.params.id)
    if (!trade) return res.status(404).json({ error: 'not found' })
    res.json(trade)
  } catch (e) {
    res.status(500).json({ error: 'failed to load trade' })
  }
})

module.exports = router
