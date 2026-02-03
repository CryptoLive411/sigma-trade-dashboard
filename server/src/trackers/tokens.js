const { ethers } = require('ethers')
const ABI = require('./abi')
const { initRedis } = require('../lib/redis')

async function ensureTokenMeta(provider, address) {
  const key = 'tokens' // Redis hash of address -> JSON
  const redis = await initRedis()
  const addr = (address || '').toLowerCase()
  const existing = await redis.hget(key, addr)
  if (existing) return JSON.parse(existing)
  const erc = new ethers.Contract(address, ABI.UniswapV2.ERC20, provider)
  const [symbol, name, decimals] = await Promise.all([
    erc.symbol().catch(() => 'TKN'),
    erc.name().catch(() => 'Token'),
    erc.decimals().catch(() => 18),
  ])
  const meta = { symbol, name, decimals }
  await redis.hset(key, addr, JSON.stringify(meta))
  return meta
}

module.exports = { ensureTokenMeta }
