// Redis-backed helpers for manual trading mode per tracker+token
// Keys:
// - manual:pos => hash of key `${trackerId}:${token}` -> JSON { enabled: boolean, stopLossPct?: number }
// - manual:v3  => hash of key `${trackerId}:${token}` -> JSON { pool: string, fee: number }
// - manual:v4  => hash of key `${trackerId}:${token}` -> JSON { currency0, currency1, fee, tickSpacing, hooks }

function key(trackerId, token) {
  return `${String(trackerId||'').trim()}:${String(token||'').toLowerCase()}`
}

async function setManual(redis, { trackerId, token, enabled, stopLossPct }) {
  if (!redis) throw new Error('redis required')
  const k = key(trackerId, token)
  const obj = { enabled: !!enabled }
  if (stopLossPct != null && !isNaN(Number(stopLossPct))) obj.stopLossPct = Number(stopLossPct)
  await redis.hset('manual:pos', k, JSON.stringify(obj))
  return obj
}

async function getManual(redis, { trackerId, token }) {
  if (!redis) return { enabled: false }
  const k = key(trackerId, token)
  const raw = await redis.hget('manual:pos', k)
  if (!raw) return { enabled: false }
  try { return JSON.parse(raw) } catch (_) { return { enabled: false } }
}

async function setV3Params(redis, { trackerId, token, pool, fee }) {
  if (!redis) throw new Error('redis required')
  const k = key(trackerId, token)
  const obj = { pool, fee: Number(fee) }
  await redis.hset('manual:v3', k, JSON.stringify(obj))
  return obj
}

async function getV3Params(redis, { trackerId, token }) {
  if (!redis) return null
  const k = key(trackerId, token)
  const raw = await redis.hget('manual:v3', k)
  if (!raw) return null
  try { return JSON.parse(raw) } catch (_) { return null }
}

async function setV4Params(redis, { trackerId, token, currency0, currency1, fee, tickSpacing, hooks }) {
  if (!redis) throw new Error('redis required')
  const k = key(trackerId, token)
  const obj = { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: hooks || '0x0000000000000000000000000000000000000000' }
  await redis.hset('manual:v4', k, JSON.stringify(obj))
  return obj
}

async function getV4Params(redis, { trackerId, token }) {
  if (!redis) return null
  const k = key(trackerId, token)
  const raw = await redis.hget('manual:v4', k)
  if (!raw) return null
  try { return JSON.parse(raw) } catch (_) { return null }
}

module.exports = { setManual, getManual, setV3Params, getV3Params, setV4Params, getV4Params }

// Exposure tracking for manual buys to keep activeEth metrics in sync roughly per token
async function addManualExposure(redis, { trackerId, token, deltaWei }) {
  try {
    if (!redis) return
    const k = key(trackerId, token)
    const cur = await redis.hget('manual:exp', k)
    const curBN = BigInt(cur || '0')
    const next = curBN + BigInt(String(deltaWei || '0'))
    await redis.hset('manual:exp', k, next.toString())
  } catch (_) {}
}

async function getManualExposure(redis, { trackerId, token }) {
  try {
    if (!redis) return '0'
    const k = key(trackerId, token)
    const v = await redis.hget('manual:exp', k)
    return v || '0'
  } catch (_) { return '0' }
}

module.exports.addManualExposure = addManualExposure
module.exports.getManualExposure = getManualExposure
