const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')

// Returns recent tracker events from Redis list "trackerlog"
// Query params: trackerId, tracker (name), limit
router.get('/', requireAuth, async (req, res) => {
  try {
    const redis = req.app.get('redis')
    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000)
    const items = await redis.lrange('trackerlog', -limit, -1)
    const arr = []
    for (const it of items || []) { try { arr.push(JSON.parse(it)) } catch (_) {} }
    const { trackerId, tracker } = req.query
    const out = arr.filter((e) => {
      if (trackerId && e.trackerId !== trackerId) return false
      if (tracker && e.tracker !== tracker) return false
      return true
    })
    res.json(out)
  } catch (_) {
    res.json([])
  }
})

module.exports = router
