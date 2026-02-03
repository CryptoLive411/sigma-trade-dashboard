const router = require('express').Router()
const { authenticate } = require('../lib/users')

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {}
  const result = await authenticate(username, password)
  if (!result) return res.status(401).json({ error: 'invalid credentials' })
  res.json(result)
})

module.exports = router
