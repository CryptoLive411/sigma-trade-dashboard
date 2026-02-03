const { ethers, logger } = require('ethers')
const { getEthBalanceWei } = require('../lib/ethBalance')
const { getRegistry } = require('./registry')

// Simple in-memory cache for honeypot checks
const _hpCache = new Map() // key: chainId:address (lowercase), value: { isHoneypot: boolean, ts: number }
const HP_TTL_MS = 30 * 60 * 1000 // 30 minutes

// Merge runtime trading defaults with per-tracker overrides
function getTrading(state) {
  const base = (state.runtime && state.runtime.trading) || {}
  const overrides = state.trading || {}
  return { ...base, ...overrides }
}

// Ensure metrics container exists on tracker
function ensureMetrics(state) {
  if (!state.metrics) state.metrics = {}
  if (!state.metrics.activeEthWei) state.metrics.activeEthWei = '0'
  if (!state.metrics.realizedPnLEthWei) state.metrics.realizedPnLEthWei = '0'
  if (state.metrics.tradesCount == null) state.metrics.tradesCount = 0
  if (state.metrics.openTrades == null) state.metrics.openTrades = 0
}

function bn(x) { return ethers.BigNumber.from(x) }

// Check if a new buy amount (wei BN) fits within per-tracker maxActiveBuyEth (string in ETH)
function canBuy(state, nextBuyWei) {
  ensureMetrics(state)
  const maxEth = state.maxActiveBuyEth
  if (!maxEth || maxEth === '0') return true
  try {
    const maxWei = ethers.utils.parseUnits(maxEth.toString(), 18)
    const active = bn(state.metrics.activeEthWei)

    logger.debug(`canBuy check: active ${ethers.utils.formatUnits(active, 18)} ETH, nextBuy ${ethers.utils.formatUnits(nextBuyWei, 18)} ETH, max ${maxEth} ETH Canbuy: ${active.add(nextBuyWei).lte(maxWei)}`)
    return active.add(nextBuyWei).lte(maxWei)
  } catch (_) {
    return true
  }
}

function addActiveEth(state, addWei) {
  ensureMetrics(state)
  const cur = bn(state.metrics.activeEthWei)
  state.metrics.activeEthWei = cur.add(addWei).toString()
  persistTrackers()
}

function subActiveEth(state, subWei) {
  ensureMetrics(state)
  const cur = bn(state.metrics.activeEthWei)
  let next
  try {
    next = cur.sub(subWei)
  } catch (_) {
    next = ethers.BigNumber.from(0)
  }
  if (next.lt(0)) next = ethers.BigNumber.from(0)
  state.metrics.activeEthWei = next.toString()
  persistTrackers()
}

function addRealizedPnL(state, realizedWei) {
  ensureMetrics(state)
  const cur = bn(state.metrics.realizedPnLEthWei)
  state.metrics.realizedPnLEthWei = cur.add(realizedWei).toString()
  persistTrackers()
}

// Whether tracker can open another trade.
// New semantics (2025-09-17): maxTrades now represents MAX ACTIVE (open) trades only.
// Historical tradesCount is NO LONGER used for gating; it remains a metric.
// If maxTrades == 0 treat as unlimited concurrent trades.
function canTrade(state) {
  ensureMetrics(state)
  const tradingOverride = state.trading && state.trading.maxTrades != null ? Number(state.trading.maxTrades) : null
  const configured = tradingOverride != null ? tradingOverride : state.maxTrades
  const maxTrades = Number(configured || 0)
  if (maxTrades === 0) return true
  const open = Number(state.metrics.openTrades || 0)
  logger.debug(`canTrade (active-only) check: open ${open}, max ${maxTrades}`)
  return open < maxTrades
}

// Increment total trades count metric and persist
function incTrades(state) {
  ensureMetrics(state)
  const cur = Number(state.metrics.tradesCount || 0)
  state.metrics.tradesCount = cur + 1
  persistTrackers()
}

// Reserve a trade during detection phase: checks maxTrades and maxActiveBuyEth.
// If reservation succeeds, increments tradesCount and openTrades immediately so
// later process() does not need to re-check and cannot overrun limits.
// Returns { ok: boolean, reason?: string }
function reserveTrade(state, nextBuyWei) {
  try {
    ensureMetrics(state)
    // Enforce active trade concurrency limit only
    if (!canTrade(state)) return { ok: false, reason: 'max_trades_reached' }
    // Enforce exposure limit
    if (!canBuy(state, nextBuyWei)) return { ok: false, reason: 'maxActiveBuyEth' }

    // Increment metrics: tradesCount (historical) and openTrades (active)
    state.metrics.tradesCount = Number(state.metrics.tradesCount || 0) + 1
    state.metrics.openTrades = Number(state.metrics.openTrades || 0) + 1
    persistTrackers()
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'reserve_error' }
  }
}

// Rollback a reservation if the later buy action fails (e.g. queue enqueue error)
function rollbackReservedTrade(state) {
  try {
    ensureMetrics(state)
    // Decrement only openTrades (cannot go below 0). We intentionally DO NOT decrement
    // tradesCount anymore so it remains a monotonic historical metric even for failed reservations.
    let open = Number(state.metrics.openTrades || 0)
    if (open > 0) state.metrics.openTrades = open - 1
    persistTrackers()
  } catch (_) {}
}

// Reserve an open trade slot immediately to avoid concurrency race
function openTrade(state) {
  ensureMetrics(state)
  const open = Number(state.metrics.openTrades || 0)
  state.metrics.openTrades = open + 1
  persistTrackers()
}

// Release an open trade slot
function closeTrade(state) {
  ensureMetrics(state)
  let open = Number(state.metrics.openTrades || 0)
  open = Math.max(0, open - 1)
  state.metrics.openTrades = open
  persistTrackers()
}

// Compute ETH received in a transaction for a given address (excludes gas, i.e., adds gas back)
async function computeEthReceivedForTx(provider, address, receipt) {
  try {
    const before = await provider.getBalance(address, receipt.blockNumber - 1)
    const after = await provider.getBalance(address, receipt.blockNumber)
    const gasPaid = receipt.gasUsed.mul(receipt.effectiveGasPrice || receipt.effectiveGasPrice === 0 ? receipt.effectiveGasPrice : receipt.gasPrice || 0)
    // after = before - gasPaid + ethDelta; so ethDelta = after - before + gasPaid
    return after.sub(before).add(gasPaid)
  } catch (_e) {
    return ethers.BigNumber.from(0)
  }
}

// Query Uniswap interface API to check honeypot protection signal for a token address on a chain
async function checkHoneypot(tokenAddress, chainId) {
  try {
    const addr = String(tokenAddress || '').toLowerCase()
    const key = `${chainId}:${addr}`
    const now = Date.now()
    const cached = _hpCache.get(key)
    if (cached && (now - cached.ts) < HP_TTL_MS) return cached.isHoneypot

    const url = 'https://interface.gateway.uniswap.org/v2/Search.v1.SearchService/SearchTokens'
    const body = { searchQuery: tokenAddress, chainIds: [Number(chainId)], searchType: 'TOKEN', page: 1, size: 15 }
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
      'content-type': 'application/json',
      'connect-protocol-version': '1'
    }
  const doFetch = typeof fetch === 'function' ? fetch : (async (u, o) => (await import('node-fetch')).default(u, o))
  const resp = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (!resp.ok) {
      _hpCache.set(key, { isHoneypot: false, ts: now })
      return false
    }
    const json = await resp.json().catch(()=>({ tokens: [] }))
    const tok = (json.tokens || []).find(t => String(t.chainId) === String(chainId) && String(t.address || '').toLowerCase() === addr)
    const attackTypes = (tok && tok.protectionInfo && Array.isArray(tok.protectionInfo.attackTypes)) ? tok.protectionInfo.attackTypes.map(x=>String(x).toLowerCase()) : []
    const isHp = attackTypes.includes('honeypot')
    _hpCache.set(key, { isHoneypot: isHp, ts: now })
    return isHp
  } catch (_e) {
    return false
  }
}

function persistTrackers() {
  // Reuse registry persist logic by writing the same file shape
  try {
  // call registry.persist via dynamic import to avoid cycle
  const reg = getRegistry()
  const { initRedis } = require('../lib/redis')
  const arr = Object.values(reg).map(({ provider, signer, redis, io, queue, runtime, ...pure }) => pure)
  initRedis().then(r => r.set('trackers', JSON.stringify(arr)).catch(()=>{})).catch(()=>{})
  } catch (_) {}
}

// Approval cache helpers (Redis-backed)
function approvalKey({ chainId, owner, token, spender, system }) {
  const cid = String(chainId || '').trim()
  const o = String(owner || '').toLowerCase()
  const t = String(token || '').toLowerCase()
  const s = String(spender || '').toLowerCase()
  const sys = String(system || 'erc20').toLowerCase()
  return `${cid}:${o}:${t}:${s}:${sys}`
}

async function isApproved(redis, params) {
  try {
    if (!redis) return false
    const key = approvalKey(params)
    const v = await redis.hget('approvals', key)
    return v === '1'
  } catch (_) { return false }
}

async function setApproved(redis, params) {
  try {
    if (!redis) return
    const key = approvalKey(params)
    await redis.hset('approvals', key, '1')
  } catch (_) {}
}

module.exports = {
  getTrading,
  canBuy,
  getEthBalanceWei,
  addActiveEth,
  subActiveEth,
  addRealizedPnL,
  computeEthReceivedForTx,
  canTrade,
  incTrades,
  reserveTrade,
  rollbackReservedTrade,
  openTrade,
  closeTrade,
  checkHoneypot,
  approvalKey,
  isApproved,
  setApproved,
}
