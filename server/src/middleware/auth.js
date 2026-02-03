const { verifyToken } = require('../lib/users')

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  const decoded = verifyToken(token)
  if (!decoded) return res.status(401).json({ error: 'invalid token' })
  req.user = decoded
  next()
}

module.exports = { requireAuth }
