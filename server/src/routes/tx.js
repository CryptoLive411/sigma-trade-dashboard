const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')

router.get('/', requireAuth, (req, res) => {
  const redis = req.app.get('redis')
  // txlog stored as a Redis list (JSON strings)
  redis.lrange('txlog', 0, -1).then((items) => {
    const arr = []
    for (const it of items || []) { try { arr.push(JSON.parse(it)) } catch (_) {} }
    res.json(arr)
  }).catch(() => res.json([]))
})

router.get('/approvals', requireAuth, (req, res) => {
  const redis = req.app.get('redis')
  redis.hgetall('approvals').then((h) => res.json(h || {})).catch(() => res.json({}))
})

module.exports = router
