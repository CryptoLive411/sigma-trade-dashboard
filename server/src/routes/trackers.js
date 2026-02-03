const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { getRegistry, cloneTracker, updateTrackerSettings, setTrackerEnabled } = require('../trackers/registry')
const { getWatcherMetrics } = require('../trackers')
const { getSubscriberMetrics } = require('../lib/logSubscriber')
const { ethers } = require('ethers')

function toResponse(t) {
  return {
    id: t.id,
    name: t.name,
    enabled: !!t.enabled,
    priority: t.priority,
    include: t.include || [],
    blacklist: t.blacklist || [],
    settings: t.settings,
    trading: t.trading || {},
    maxActiveBuyEth: t.maxActiveBuyEth || '0',
    maxTrades: t.maxTrades || 0,
    metrics: t.metrics || { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 }
  }
}

router.get('/', requireAuth, (req, res) => {
  const registry = getRegistry()
  res.json(Object.values(registry).map(toResponse))
})

router.post('/:id/clone', requireAuth, (req, res) => {
  const { id } = req.params
  const { newId, name, settings } = req.body
  const tracker = cloneTracker(id, { newId, name, settings })
  res.json(toResponse(tracker))
})

router.put('/:id', requireAuth, (req, res) => {
  const { id } = req.params
  const tracker = updateTrackerSettings(id, req.body)
  res.json(toResponse(tracker))
})

// Update per-tracker config values (trading overrides and limits)
router.put('/:id/config', requireAuth, (req, res) => {
  const { id } = req.params
  const { trading, maxActiveBuyEth, include, blacklist, priority, enabled, name, maxTrades } = req.body || {}
  const patch = {}
  if (trading && typeof trading === 'object') patch.trading = trading
  if (maxActiveBuyEth != null) patch.maxActiveBuyEth = String(maxActiveBuyEth)
  if (maxTrades != null) patch.maxTrades = Number(maxTrades)
  if (Array.isArray(include)) patch.include = include
  if (Array.isArray(blacklist)) patch.blacklist = blacklist
  if (priority != null) patch.priority = priority
  if (enabled != null) patch.enabled = !!enabled
  if (name) patch.name = name
  const tracker = updateTrackerSettings(id, patch)
  res.json({ ok: true, tracker: toResponse(tracker) })
})

// Global metrics summary
router.get('/metrics', requireAuth, (req, res) => {
  const reg = getRegistry()
  const items = Object.values(reg)
  const sum = (arr, key) => arr.reduce((a, t) => a.add(ethers.BigNumber.from((t.metrics && t.metrics[key]) || '0')), ethers.BigNumber.from(0))
  const active = sum(items, 'activeEthWei')
  const realized = sum(items, 'realizedPnLEthWei')
  const watcher = getWatcherMetrics()
  const subscriber = getSubscriberMetrics()
  res.json({
    activeEthWei: active.toString(),
    realizedPnLEthWei: realized.toString(),
    perTracker: items.map(t => ({ id: t.id, name: t.name, metrics: t.metrics || { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 } })),
    watcher,
    subscriber
  })
})

router.post('/:id/enable', requireAuth, (req, res) => {
  const { id } = req.params
  const tracker = setTrackerEnabled(id, true)
  res.json(toResponse(tracker))
})

router.post('/:id/disable', requireAuth, (req, res) => {
  const { id } = req.params
  const tracker = setTrackerEnabled(id, false)
  res.json(toResponse(tracker))
})

// Test detect/process using a tx hash (no config changes). Body: { tx, trackerId?, wait? }
router.post('/test', requireAuth, async (req, res) => {
  const { tx, trackerId, wait } = req.body || {}
  if (!tx || typeof tx !== 'string' || !tx.startsWith('0x')) return res.status(400).json({ ok: false, error: 'invalid tx hash' })
  try {
    const reg = getRegistry()
    const trackers = trackerId ? [reg[trackerId]].filter(Boolean) : Object.values(reg)
    if (!trackers.length) return res.status(404).json({ ok: false, error: 'no trackers' })
    const provider = trackers[0]?.provider
    if (!provider) return res.status(500).json({ ok: false, error: 'provider unavailable' })

    let receipt = await provider.getTransactionReceipt(tx)
    if (!receipt && wait) {
      let attempts = 0
      while (!receipt && attempts < 30) { // up to ~60s if 2s cluster delay
        await new Promise(r => setTimeout(r, 2000))
        receipt = await provider.getTransactionReceipt(tx)
        attempts++
      }
    }
    if (!receipt) return res.status(404).json({ ok: false, error: 'receipt not found' })

    const results = []
    for (const t of trackers) {
      try {
        const det = await t.detect?.(receipt, { wantReason: true })
        if (det && det.reason) {
          results.push({ trackerId: t.id, name: t.name, detected: false, processed: false, reason: det.reason })
        } else if (det) {
          try { await t.process(det); results.push({ trackerId: t.id, name: t.name, detected: true, processed: true }) }
          catch (e) { results.push({ trackerId: t.id, name: t.name, detected: true, processed: false, error: e?.message || 'process failed' }) }
        } else {
          results.push({ trackerId: t.id, name: t.name, detected: false, processed: false })
        }
      } catch (e) {
        results.push({ trackerId: t.id, name: t.name, detected: false, processed: false, error: e?.message || 'detect failed' })
      }
    }
    res.json({ ok: true, tx, results })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'test failed' })
  }
})

module.exports = router
