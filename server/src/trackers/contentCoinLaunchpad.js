const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { appendTrackerLog, logger } = require('../lib/logger')
const baseUniv4 = require('./uniswapV4')

// ContentCoin Launchpad (Uniswap V4 flavor)
// Allows only a specific hooks address: 0x9ea932730a7787000042e34390b8e435dd839040
const ALLOWED_HOOK = '0x9ea932730a7787000042e34390b8e435dd839040'

function create(ctx) {
  const base = baseUniv4.create(ctx)
  base.name = 'ContentCoin Launchpad'
  base.id = 'contentcoin-' + uuidv4()
  // Accept only if hooks equals ALLOWED_HOOK
  const iface = new ethers.utils.Interface([ABI.UniswapV4.PoolManagerInitialize])
  base.detect = async (receipt, options) => {
    let lastReason = 'no-poolmanager-logs'
    let sawPoolManager = false
    try {
      const POOL_MANAGER = base.settings.poolManager
      const WETH = base.settings.weth || '0x4200000000000000000000000000000000000006'
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== POOL_MANAGER.toLowerCase()) continue
        sawPoolManager = true
        try {
          const ev = iface.parseLog(log)
          if (ev.name !== 'Initialize') { lastReason = 'wrong-event'; continue }
          const currency0 = ev.args.currency0
          const currency1 = ev.args.currency1
          const fee = ev.args.fee
          const tickSpacing = ev.args.tickSpacing
          const hooks = ev.args.hooks
          // Only allow specific hook
          if (!hooks || hooks.toLowerCase() !== ALLOWED_HOOK.toLowerCase()) {
            lastReason = 'hook-not-allowed'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          // Treat native as either WETH or zero address
          const isNative = (addr) => addr.toLowerCase() === WETH.toLowerCase() || addr.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
          if (![currency0, currency1].some((t) => isNative(t))) {
            lastReason = 'no-native-in-pair'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          // blacklist/include
          const globalBlacklist = (base.runtime.blacklist?.global || []).map((x) => x.toLowerCase())
          const trackerBlacklist = (base.blacklist || []).map((x) => x.toLowerCase())
          const fromTo = [receipt.from, receipt.to].filter(Boolean)
          const candidates = [currency0, currency1, ...fromTo].filter(Boolean).map((x)=>x.toLowerCase())
          if (candidates.some((a) => globalBlacklist.includes(a) || trackerBlacklist.includes(a))) {
            lastReason = 'blacklisted-address'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          const include = (base.include || []).map((x)=>x.toLowerCase())
          if (include.length && !include.some((a)=>candidates.includes(a))) {
            lastReason = 'not-in-include-list'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          // Honeypot check (use same as base)
          try {
            const tr2 = require('./utils').getTrading(base)
            if (!tr2.disableHoneypotCheck) {
              const chainId = await base.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
              const { checkHoneypot } = require('./utils')
              const tokenOut = isNative(currency0) ? currency1 : currency0
              const hp = await checkHoneypot(tokenOut, chainId)
              if (hp) { lastReason = 'honeypot-detected'; if (options && options.wantReason) return { reason: lastReason }; return null }
            }
          } catch (_) { }
          // Early trade reservation (enforce maxTrades & exposure, only if tracker is enabled)
          if (base.enabled) {
            try {
              const { getTrading, reserveTrade } = require('./utils')
              const trading = getTrading(base)
              const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
              const res = reserveTrade(base, amountIn)
              if (!res.ok) {
                const reason = res.reason || 'max_trades_reached'
                if (!options || !options.wantReason) base.io.emit('trade:skip', { dex: 'ContentCoinV4', reason })
                try { await appendTrackerLog({ tracker: base.name, trackerId: base.id, phase: 'detect:skip', tx: receipt.transactionHash, reason }) } catch (_) {}
                continue
              }
            } catch (_) {}
          }
          try { await appendTrackerLog({ tracker: base.name, trackerId: base.id, phase: 'detect:match', tx: receipt.transactionHash, currency0, currency1, fee: String(fee), tickSpacing: String(tickSpacing), hooks }) } catch (_) {}
          return { currency0, currency1, fee, tickSpacing, hooks }
        } catch (_) {}
      }
    } catch (e) { logger.error(e, 'contentcoin detect error') }
    if (options && options.wantReason) { try { await appendTrackerLog({ tracker: base.name, trackerId: base.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: sawPoolManager ? (lastReason || 'no-match') : 'no-poolmanager-logs' }) } catch (_) {}; return { reason: sawPoolManager ? (lastReason || 'no-match') : 'no-poolmanager-logs' } }
    return null
  }
  // keep process from base as-is
  return base
}

module.exports = { create }
