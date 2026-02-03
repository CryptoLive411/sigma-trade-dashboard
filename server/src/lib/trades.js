const { v4: uuidv4 } = require('uuid')

function now() { return Date.now() }

// Create a new trade record and index it by time
async function newTrade(redis, { trackerId, trackerName, dex, token, pool, meta }) {
  const id = uuidv4()
  const startedAt = now()
  const trade = {
    id,
    trackerId,
    trackerName,
    dex,
    token,
    pool: pool || null,
    status: 'open',
    startedAt,
    finishedAt: null,
    realizedEthWei: null,
    txs: [],
    meta: meta || {}
  }
  await redis.set(`trade:${id}`, JSON.stringify(trade))
  await redis.zadd('trades:index', startedAt, id)
  return trade
}

async function appendTradeTx(redis, tradeId, txEvent) {
  const key = `trade:${tradeId}`
  const raw = await redis.get(key)
  if (!raw) return null
  const trade = JSON.parse(raw)
  const entry = { time: now(), ...txEvent }
  trade.txs.push(entry)
  // Also update convenience fields
  if (txEvent.phase === 'sent' && txEvent.hash) {
    trade.lastHash = txEvent.hash
  }
  await redis.set(key, JSON.stringify(trade))
  return entry
}

// Increment or set the cumulative buy amount in Wei on a trade
async function addBuyEthWei(redis, tradeId, deltaWei) {
  const key = `trade:${tradeId}`
  const raw = await redis.get(key)
  if (!raw) return null
  const trade = JSON.parse(raw)
  const cur = BigInt(trade.buyEthWei || '0')
  const add = BigInt(String(deltaWei || '0'))
  trade.buyEthWei = (cur + add).toString()
  if (!trade.meta) trade.meta = {}
  const metaCur = BigInt(trade.meta.buyEthWei || '0')
  trade.meta.buyEthWei = (metaCur + add).toString()
  await redis.set(key, JSON.stringify(trade))
  return trade.buyEthWei
}

async function completeTrade(redis, tradeId, patch) {
  const key = `trade:${tradeId}`
  const raw = await redis.get(key)
  if (!raw) return null
  const trade = JSON.parse(raw)
  Object.assign(trade, patch)
  if (!trade.finishedAt) trade.finishedAt = now()
  if (!trade.status) trade.status = 'closed'
  await redis.set(key, JSON.stringify(trade))
  return trade
}

async function listTrades(redis, { offset = 0, limit = 50 } = {}) {
  const ids = await redis.zrevrange('trades:index', offset, offset + limit - 1)
  if (!ids || ids.length === 0) return []
  const keys = ids.map((id) => `trade:${id}`)
  const raws = await redis.mget(keys)
  const items = []
  for (let i = 0; i < ids.length; i++) {
    const raw = raws[i]
    if (!raw) continue
    try {
      const t = JSON.parse(raw)
      // summary
      items.push({
        id: t.id,
        trackerId: t.trackerId,
        trackerName: t.trackerName,
        dex: t.dex,
        token: t.token,
        pool: t.pool || null,
        status: t.status,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt || null,
        txCount: Array.isArray(t.txs) ? t.txs.length : 0,
        buyEthWei: t.buyEthWei || null,
        buyTx: t.buyTxHash || (t.txs || []).find(x => (x.action === 'buy' && x.phase === 'confirmed'))?.hash || null,
        sellTx: t.sellTxHash || (t.txs || []).find(x => (x.action === 'sell' && x.phase === 'confirmed'))?.hash || null,
        realizedEthWei: t.realizedEthWei || null
      })
    } catch (_) {}
  }
  return items
}

async function getTrade(redis, id) {
  const raw = await redis.get(`trade:${id}`)
  if (!raw) return null
  return JSON.parse(raw)
}

module.exports = { newTrade, appendTradeTx, completeTrade, listTrades, getTrade }

// Find the most recent open trade for a tracker+token (linear scan of recent N)
async function findOpenTrade(redis, { trackerId, token, lookback = 200 }) {
  const ids = await redis.zrevrange('trades:index', 0, lookback - 1)
  for (const id of ids) {
    try {
      const raw = await redis.get(`trade:${id}`)
      if (!raw) continue
      const t = JSON.parse(raw)
      if (t.status === 'open' && t.trackerId === trackerId && (t.token||'').toLowerCase() === (token||'').toLowerCase()) {
        return t
      }
    } catch (_) {}
  }
  return null
}

// Ensure an open trade exists; create one if not found
async function ensureOpenTrade(redis, { trackerId, trackerName, dex, token, pool }) {
  const found = await findOpenTrade(redis, { trackerId, token })
  if (found) return found
  return await newTrade(redis, { trackerId, trackerName, dex, token, pool })
}

module.exports.findOpenTrade = findOpenTrade
module.exports.ensureOpenTrade = ensureOpenTrade
