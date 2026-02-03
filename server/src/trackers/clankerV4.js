const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { appendTrackerLog, logger } = require('../lib/logger')
const baseUniv4 = require('./uniswapV4')

// ClankerV4: allows any hook address, but requires include address to be present
// and waits at least 2 minutes from pool deployment time before buying.
const REQUIRE_INCLUDE = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9'.toLowerCase()

function create(ctx) {
  const base = baseUniv4.create(ctx)
  base.name = 'ClankerV4'
  base.id = 'clanker-' + uuidv4()

  const iface = new ethers.utils.Interface([ABI.UniswapV4.PoolManagerInitialize])
  const PM = () => base.settings.poolManager
  // Accept any hooks; ensure include address present in candidates like base does.
  base.include = (base.include || []).concat([REQUIRE_INCLUDE])

  base.detect = async (receipt, options) => {
    let lastReason = 'no-poolmanager-logs'
    try {
      const pm = PM()
      const WETH = base.settings.weth || '0x4200000000000000000000000000000000000006'
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== pm.toLowerCase()) continue
        try {
          const ev = iface.parseLog(log)
          if (ev.name !== 'Initialize') continue
          const currency0 = ev.args.currency0
          const currency1 = ev.args.currency1
          const fee = ev.args.fee
          const tickSpacing = ev.args.tickSpacing
          const hooks = ev.args.hooks
          // Require include address presence among candidates
          const fromTo = [receipt.from, receipt.to].filter(Boolean)
          const candidates = [currency0, currency1, ...fromTo].filter(Boolean).map((x)=>x.toLowerCase())
          if (!candidates.includes(REQUIRE_INCLUDE.toLowerCase())) {
            lastReason = 'include-address-missing'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          // Require native token in pair like base
          const isNative = (addr) => addr.toLowerCase() === WETH.toLowerCase() || addr.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
          if (![currency0, currency1].some((t) => isNative(t))) {
            lastReason = 'no-native-in-pair'
            if (options && options.wantReason) return { reason: lastReason }
            return null
          }
          // basic blacklist/include support similar to base
          const globalBlacklist = (base.runtime.blacklist?.global || []).map((x) => x.toLowerCase())
          const trackerBlacklist = (base.blacklist || []).map((x) => x.toLowerCase())
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
          // Early trade reservation (only if tracker is enabled)
          if (base.enabled) {
            try {
              const { getTrading, reserveTrade } = require('./utils')
              const trading = getTrading(base)
              const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
              const res = reserveTrade(base, amountIn)
              if (!res.ok) {
                const reason = res.reason || 'max_trades_reached'
                if (!options || !options.wantReason) base.io.emit('trade:skip', { dex: 'ClankerV4', reason })
                try { await appendTrackerLog({ tracker: base.name, trackerId: base.id, phase: 'detect:skip', tx: receipt.transactionHash, reason }) } catch (_) {}
                continue
              }
            } catch (_) {}
          }
          return { currency0, currency1, fee, tickSpacing, hooks, __deployLog: log }
        } catch (_) {}
      }
    } catch (e) { logger.error(e, 'clanker detect error') }
    if (options && options.wantReason) return { reason: lastReason }
    return null
  }

  // Wrap process to wait 2 minutes from pool deploy time before buying
  const origProcess = base.process
  base.process = async (det) => {
    try {
      const deployTs = await getBlockTimestamp(base.provider, det.__deployLog?.blockNumber)
      const waitMs = 15000
      const now = Date.now()
      const earliest = (deployTs ? deployTs * 1000 : now)
      const delay = earliest + waitMs - now
      if (delay > 0) {
        try { await appendTrackerLog({ tracker: base.name, trackerId: base.id, phase: 'delay', ms: delay }) } catch (_) {}
        await new Promise(r => setTimeout(r, delay))
      }
    } catch (_) {}
    // proceed to normal base process (which will buy/sell)
    const { __deployLog, ...rest } = det
    return origProcess(rest)
  }

  return base
}

async function getBlockTimestamp(provider, blockNumber) {
  try {
    if (!blockNumber) return null
    const blk = await provider.getBlock(blockNumber)
    return blk?.timestamp || null
  } catch (_) { return null }
}

module.exports = { create }
