const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { getCreatorTokenCounts, getTopCreators } = require('../lib/creatorStats')

// GET /api/detections - Get all detections (per-tracker events, not aggregated by tx)
router.get('/', requireAuth, async (req, res) => {
  try {
    const redis = req.app.get('redis')
    const lim = Math.max(1, Math.min(500, Number(req.query.limit) || 100))
    let items = []
    if (redis) {
      // Return per-tracker detection events (includes pass/fail reasons)
      const key = 'detections:events'
      const arr = await redis.lrange(key, 0, lim - 1)
      items = arr.map((s) => { try { return JSON.parse(s) } catch (_) { return null } }).filter(Boolean)
      
      // Enrich with creator stats (token counts)
      const creators = [...new Set(items.map(it => it.creator).filter(Boolean))]
      if (creators.length > 0) {
        const creatorCounts = await getCreatorTokenCounts(redis, creators)
        items = items.map(it => {
          if (it.creator) {
            const creatorTokens = creatorCounts[it.creator.toLowerCase()] || 0
            return { ...it, creatorTokens }
          }
          return it
        })
      }
    }
    res.json({ ok: true, items })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' })
  }
})

// GET /api/detections/tx - Get aggregated per-tx detections (legacy endpoint)
router.get('/tx', requireAuth, async (req, res) => {
  try {
    const redis = req.app.get('redis')
    const lim = Math.max(1, Math.min(500, Number(req.query.limit) || 20))
    let items = []
    if (redis) {
      const key = 'detections:tx'
      const arr = await redis.lrange(key, 0, lim - 1)
      items = arr.map((s) => { try { return JSON.parse(s) } catch (_) { return null } }).filter(Boolean)
    }
    res.json({ ok: true, items })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' })
  }
})

// GET /api/detections/creators - Get top token creators
router.get('/creators', requireAuth, async (req, res) => {
  try {
    const redis = req.app.get('redis')
    const lim = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
    const creators = await getTopCreators(redis, lim)
    res.json({ ok: true, creators })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'failed' })
  }
})

module.exports = router
