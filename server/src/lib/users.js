const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { initRedis } = require('./redis')

const USERS_KEY = 'users' // Redis hash: field=username, value=JSON { hash, role }

async function ensureAdminUser() {
  const redis = await initRedis()
  const username = process.env.ADMIN_USER || 'admin'
  const password = process.env.ADMIN_PASS || 'admin123!'
  const existing = await redis.hget(USERS_KEY, username)
  if (!existing) {
    const hash = await bcrypt.hash(password, 10)
    await redis.hset(USERS_KEY, username, JSON.stringify({ hash, role: 'admin' }))
  }
}

async function authenticate(username, password) {
  if (!username || !password) return null
  const redis = await initRedis()
  const raw = await redis.hget(USERS_KEY, username)
  if (!raw) return null
  let parsed
  try { parsed = JSON.parse(raw) } catch (_) { return null }
  const ok = await bcrypt.compare(password, parsed.hash)
  if (!ok) return null
  const token = jwt.sign({ sub: username, role: parsed.role || 'user' }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' })
  return { token }
}

function verifyToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'secret')
  } catch (_e) {
    return null
  }
}
/**
 * Change credentials for the currently authenticated user.
 * Verifies current password, optionally updates username and/or password.
 * Returns a freshly signed JWT for the (possibly new) username on success, or null on failure.
 */
async function changeCredentials(currentUsername, currentPassword, { newUsername, newPassword }) {
  if (!currentUsername || !currentPassword) return null
  const redis = await initRedis()
  const raw = await redis.hget(USERS_KEY, currentUsername)
  if (!raw) return null
  let user
  try { user = JSON.parse(raw) } catch (_) { return null }
  const ok = await bcrypt.compare(currentPassword, user.hash)
  if (!ok) return null

  const targetUsername = (newUsername && newUsername.trim()) || currentUsername

  // If username is changing, ensure uniqueness
  if (targetUsername !== currentUsername) {
    const exists = await redis.hget(USERS_KEY, targetUsername)
    if (exists) {
      const err = new Error('username_taken')
      err.code = 'USERNAME_TAKEN'
      throw err
    }
  }

  // Update password hash if provided
  let nextHash = user.hash
  if (typeof newPassword === 'string' && newPassword.length > 0) {
    nextHash = await bcrypt.hash(newPassword, 10)
  }

  const updated = { hash: nextHash, role: user.role || 'user' }

  // Persist
  await redis.hset(USERS_KEY, targetUsername, JSON.stringify(updated))
  if (targetUsername !== currentUsername) {
    await redis.hdel(USERS_KEY, currentUsername)
  }

  const token = jwt.sign({ sub: targetUsername, role: updated.role }, process.env.JWT_SECRET || 'secret', { expiresIn: '12h' })
  return { token, username: targetUsername }
}

module.exports = { ensureAdminUser, authenticate, verifyToken, changeCredentials }
