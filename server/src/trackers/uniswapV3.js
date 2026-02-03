const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { logger, appendTrackerLog } = require('../lib/logger')
const { ensureTokenMeta } = require('./tokens')
const { getTrading, canBuy, addActiveEth, subActiveEth, addRealizedPnL, computeEthReceivedForTx, canTrade, incTrades, isApproved, setApproved } = require('./utils')
const { setV3Params, getManual, addManualExposure, getManualExposure } = require('../lib/manual')
const { initRedis } = require('../lib/redis')

const DEFAULT_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD'
const DEFAULT_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'
const DEFAULT_WETH = '0x4200000000000000000000000000000000000006'

function create(ctx) {
  const id = 'univ3-' + uuidv4()
  const iface = new ethers.utils.Interface([ABI.UniswapV3.FactoryPoolCreated])
  // contracts created after state initialization (addresses may be overridden via settings)

  const state = {
    id,
    name: 'UniswapV3',
    type: 'dex',
    enabled: true,
    priority: ctx.runtime?.priorities?.UniswapV3 ?? 0,
    include: [],
    blacklist: [],
    settings: { factory: DEFAULT_V3_FACTORY, router: DEFAULT_V3_ROUTER, weth: DEFAULT_WETH },
    trading: {},
    maxActiveBuyEth: '0',
    maxTrades: 100,
    metrics: { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 },
    provider: ctx.provider,
    signer: ctx.signer,
    redis: ctx.redis,
    io: ctx.io,
    queue: ctx.queue,
    runtime: ctx.runtime,
    // Precise log filters for fast detection
    getLogFilters: () => {
      const V3_FACTORY = state.settings?.factory || DEFAULT_V3_FACTORY
      const topic = ethers.utils.id('PoolCreated(address,address,uint24,int24,address)')
      return [{ address: V3_FACTORY, topics: [topic] }]
    },
    onReceipt: async (receipt) => {
      const det = await state.detect(receipt)
      if (det) await state.process(det)
    },
    detect: async (receipt, options) => {

      try {
        const V3_FACTORY = state.settings.factory
        const WETH = state.settings.weth || DEFAULT_WETH
        let lastReason = 'no-factory-logs'
        let sawFactory = false
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== V3_FACTORY.toLowerCase()) continue
          sawFactory = true
          try {
            const ev = iface.parseLog(log)
            if (ev.name !== 'PoolCreated') { lastReason = 'wrong-event'; continue }
            const { token0, token1, fee, pool } = ev.args
            if (![token0, token1].some((t) => t.toLowerCase() === WETH.toLowerCase())) { lastReason = 'no-weth-in-pair'; return options && options.wantReason ? { reason: lastReason } : null }
            // liquidity check: WETH transfer to pool
            const topic = ethers.utils.id('Transfer(address,address,uint256)')
            let wethIn = ethers.BigNumber.from(0)
            for (const lg of receipt.logs) {
              if (lg.topics[0] === topic && lg.address.toLowerCase() === WETH.toLowerCase()) {
                const to = '0x' + lg.topics[2].slice(26)
                if (to.toLowerCase() === pool.toLowerCase()) wethIn = wethIn.add(ethers.BigNumber.from(lg.data))
              }
            }
            const tr = getTrading(state)
            const minLiq = tr.minWethLiquidity ?? '1'
            const minWei = ethers.utils.parseUnits(String(minLiq), 18)
            if (wethIn.lt(minWei)) { lastReason = 'insufficient-weth-liquidity'; return options && options.wantReason ? { reason: lastReason } : null }
            // lists
            const globalBlacklist = (ctx.runtime.blacklist?.global || []).map((x) => x.toLowerCase())
            const trackerBlacklist = (state.blacklist || []).map((x) => x.toLowerCase())
            const fromTo = [receipt.from, receipt.to].filter(Boolean)
            const candidates = [token0, token1, pool, ...fromTo]
              .filter(Boolean)
              .map((x) => x.toLowerCase())
            if (candidates.some((a) => globalBlacklist.includes(a) || trackerBlacklist.includes(a))) { lastReason = 'blacklisted-address'; return options && options.wantReason ? { reason: lastReason } : null }
            const include = (state.include || []).map((x) => x.toLowerCase())
            if (include.length && !include.some((a) => candidates.includes(a))) { lastReason = 'not-in-include-list'; return options && options.wantReason ? { reason: lastReason } : null }
            try {
              const tr2 = getTrading(state)
              if (!tr2.disableHoneypotCheck) {
                const chainId = 8453
                const { checkHoneypot } = require('./utils')
                const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0
                const hp = await checkHoneypot(tokenOut, chainId)
                if (hp) { lastReason = 'honeypot-detected'; return options && options.wantReason ? { reason: lastReason } : null }
              }
            } catch (_) { }
            // Reserve trade before confirming detection (only if tracker is enabled)
            if (state.enabled) {
              try {
                const trading = getTrading(state)
                const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
                const { reserveTrade } = require('./utils')
                const res = reserveTrade(state, amountIn)
                if (!res.ok) {
                  const reason = res.reason || 'max_trades_reached'
                  if (!options || !options.wantReason) state.io.emit('trade:skip', { dex: 'UniswapV3', reason, tokenOut: token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0 })
                  try { await appendTrackerLog({ tracker: 'UniswapV3', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason }) } catch (_) { }
                  continue
                }
              } catch (_) { }
            }
            // Final balance check
            try {
              const trading = getTrading(state)
              const multRaw = process.env.BUY_BALANCE_MULTIPLIER || state.runtime?.trackerDefaults?.buyBalanceMultiplier || 10
              const mult = Math.max(1, Number(multRaw || 10))
              const needWei = ethers.utils.parseUnits(trading.buyEthAmount, 18).mul(ethers.BigNumber.from(mult))
              const { getEthBalanceWei } = require('./utils')
              const haveWei = getEthBalanceWei()
              if (haveWei.lt(needWei)) { return options && options.wantReason ? { reason: 'insufficient-eth-balance' } : null }
            } catch (_) { }
            try { await appendTrackerLog({ tracker: 'UniswapV3', trackerId: state.id, phase: 'detect:match', tx: receipt.transactionHash, token0, token1, pool, wethIn: wethIn.toString() }) } catch (_) { }
            return { pool, token0, token1, fee }
          } catch (_) { }
        }
      } catch (e) {
        logger.error(e, 'uniswapV3 detect error')
      }
      if (options && options.wantReason) { try { await appendTrackerLog({ tracker: 'UniswapV3', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: 'no-match' }) } catch (_) { }; return { reason: 'no-match' } }
      return null
    },
    process: async ({ pool, token0, token1, fee }) => {
      logger.debug(`UniswapV3 detected new pool ${pool} (${token0}/${token1} fee ${fee})`)
      const signer = state.signer
      if (!signer) return
      const me = await signer.getAddress()
      const WETH = state.settings.weth || DEFAULT_WETH
      const V3_ROUTER = state.settings.router
      const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0
      //await ensureTokenMeta(state.provider, tokenOut)
      const trading = getTrading(state)
      const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)

      // Reservation and exposure limits already enforced in detect(); proceed without re-checking canBuy here

      // Wrap to WETH and approve router if needed
      const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, state.signer || state.provider)
      const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, state.signer || state.provider)
      logger.debug(`UniswapV3 buy: wrapping ${ethers.utils.formatUnits(amountIn, 18)} ETH to WETH`)
      const buildDeposit = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
      await state.queue.enqueue({ signer, buildTx: buildDeposit, label: 'univ3-wrap' })
      const chainId = 8453
      const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
      if (!alreadyApproved) {
        const buildApprove = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
        await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ3-approve' })
        await setApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
      }

      logger.debug(`UniswapV3 buy: proceeding to buy ${tokenOut} with ${ethers.utils.formatUnits(amountIn, 18)} WETH via pool ${pool}`)


      // Buy via exactInputSingle
      const params = { tokenIn: WETH, tokenOut, fee, recipient: me, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
      const buildBuy = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
      // reservation already done in detect
      const { rollbackReservedTrade, closeTrade } = require('./utils')
      // Create trade record before sending buy
      let trade = null
      try {
        const { newTrade } = require('../lib/trades')
        trade = await newTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV3', token: tokenOut, pool })
      } catch (_) { }
      // save manual params for later buys/sells
      try { await setV3Params(state.redis, { trackerId: state.id, token: tokenOut, pool, fee }) } catch (_) { }
      let receiptBuy
      try {
        receiptBuy = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'univ3-buy', trade: trade?.id, action: 'buy' })
      } catch (e) {
        rollbackReservedTrade(state)
        try { await appendTrackerLog({ tracker: 'UniswapV3', trackerId: state.id, phase: 'buy:error', error: e.message, tokenOut, pool }) } catch (_) { }
        throw e
      }
      addActiveEth(state, amountIn)

      // Capture initial pool state for monitoring
      const poolCtr = new ethers.Contract(pool, ABI.UniswapV3.Pool, state.provider)
      const slot0 = await poolCtr.slot0().catch(() => null)
      const liq = await poolCtr.liquidity().catch(() => null)
      const initial = slot0 ? { sqrtPriceX96: slot0.sqrtPriceX96.toString(), tick: Number(slot0.tick), liquidity: liq ? liq.toString() : '0' } : null
      if (initial) {
        try {
          const redis = await initRedis()
          const key = 'univ3PoolState'
          await redis.hset(key, pool.toLowerCase(), JSON.stringify({ ...initial, time: Date.now(), fee, token0, token1 }))
        } catch (_) { }
      }

      // Monitor and sell conditions with pool state baseline
      try { await appendTrackerLog({ tracker: 'UniswapV3', trackerId: state.id, phase: 'buy:confirmed', tokenOut, pool, amountIn: trading.buyEthAmount }) } catch (_) { }
      await monitorAndMaybeSell({ state, router, tokenIn: tokenOut, fee, me, pool, initial, tradeId: trade?.id })
      return receiptBuy
    }
  }

  try { attachManual(state) } catch (_) { }
  return state
}

async function monitorAndMaybeSell({ state, router, tokenIn, fee, me, pool, initial, tradeId }) {
  const WETH = state.settings.weth || DEFAULT_WETH
  const V3_ROUTER = state.settings.router
  const signer = state.signer
  const trading = getTrading(state)
  // Auto-buy cost basis in ETH (manual exposures will be added dynamically below)
  const amountInEth = parseFloat(trading.buyEthAmount)
  const sellLoss = trading.sellLossPct / 100
  const sellProfit = trading.sellProfitPct / 100
  const maxHoldMs = (trading.sellMaxHoldSeconds || 3600) * 1000
  const start = Date.now()
  let sold = false
  let prevPnl = null
  const erc = new ethers.Contract(tokenIn, ABI.UniswapV3.ERC20, state.provider)
  const poolCtr = pool ? new ethers.Contract(pool, ABI.UniswapV3.Pool, state.provider) : null
  const startTick = initial?.tick
  const startSqrt = initial?.sqrtPriceX96 ? ethers.BigNumber.from(initial.sqrtPriceX96) : null

  while (!sold) {
    await sleep(8000)
    try {
      const bal = await erc.balanceOf(me).catch(() => null)
      if (!bal) continue
      if (bal.isZero()) break
      // Try to read current pool state
      let tickNow = null, sqrtNow = null, liqNow = null
      if (poolCtr) {
        const s0 = await poolCtr.slot0().catch(() => null)
        const lq = await poolCtr.liquidity().catch(() => null)
        if (s0) { tickNow = Number(s0.tick); sqrtNow = s0.sqrtPriceX96; }
        if (lq) liqNow = lq
      }

      // Compute price move using tick delta if available
      let tickDelta = null
      if (startTick != null && tickNow != null) tickDelta = tickNow - startTick

      // Approximate expected ETH out using current sqrtPrice and full token balance.
      // If we can compute a quote from price math, use that for PnL relative to (auto + manual exposure) basis; otherwise fallback to price ratio proxy.
      let quotedEthOut = null
      let outEth = null
      try {
        if (sqrtNow && !bal.isZero()) {
          // Determine direction via pool tokens
          let t0 = null, t1 = null
          try { t0 = await poolCtr.token0(); t1 = await poolCtr.token1() } catch (_) { }
          const W = state.settings.weth || DEFAULT_WETH
          const token0IsWeth = t0 && t0.toLowerCase() === W.toLowerCase()
          const token1IsWeth = t1 && t1.toLowerCase() === W.toLowerCase()
          // P(token1/token0) = (sqrtPriceX96^2) / 2^192
          const S = ethers.BigNumber.from(sqrtNow)
          const priceX192 = S.mul(S)
          const num = BigInt(priceX192.toString())
          const denom = (1n << 192n)
          // priceScaled has 1e18 scale
          const priceScaled = (num * 1000000000000000000n) / denom
          let priceEthScaled = null
          if (token0IsWeth && !token1IsWeth) {
            // token1 priced in token0 (WETH) -> need inverse (WETH per token1)
            priceEthScaled = (1000000000000000000n * 1000000000000000000n) / priceScaled
          } else if (token1IsWeth && !token0IsWeth) {
            // token0 priced in token1 (WETH) -> direct
            priceEthScaled = priceScaled
          }
          if (priceEthScaled != null) {
            const balBI = BigInt(bal.toString())
            const outWei = (balBI * priceEthScaled) / 1000000000000000000n
            quotedEthOut = outWei.toString()
            outEth = Number(outWei) / 1e18
          }
        }
      } catch (_) { }

      // Manual exposure baseline in ETH to include with auto entry amount
      let expWei = '0'
      try { expWei = await getManualExposure(state.redis, { trackerId: state.id, token: tokenIn }) } catch (_) { }
      const expEth = Number(expWei || '0') / 1e18
      const inEth = Math.max(1e-12, amountInEth + expEth)

      // Compute PnL percentage
      let pnl = 0
      if (outEth != null) {
        pnl = (outEth - inEth) / inEth
      } else if (tickDelta != null) {
        // Fallback rough signal when price math quote unavailable
        const ratio = Math.pow(1.0001, tickDelta)
        pnl = ratio - 1
      }

      // Emit monitor metrics including timing so UI can show details
      const elapsedMs = Date.now() - start
      const timeLeftMs = Math.max(0, maxHoldMs - elapsedMs)
      // Emit monitor update including time & quote
      state.io.emit('trade:monitor', {
        dex: 'UniswapV3',
        token: tokenIn,
        tokenIn,
        pnlPct: pnl,
        pnl,
        tickDelta,
        sqrtPriceX96: sqrtNow ? sqrtNow.toString() : null,
        liquidity: liqNow ? liqNow.toString() : null,
        quotedEthOut: quotedEthOut,
        startedAt: start,
        maxHoldMs,
        timeLeftMs: timeLeftMs,
        trackerId: state.id,
        trackerName: state.name
      })

      // Manual mode: only auto-sell on stoploss or max-hold if not manual; if manual, only stoploss
      let manual = null
      try { manual = await getManual(state.redis, { trackerId: state.id, token: tokenIn }) } catch (_) { }
      // Use elapsedMs computed above for decision logic
      const effStopRaw = (manual && manual.enabled && manual.stopLossPct != null) ? Number(manual.stopLossPct) / 100 : null
      const shouldForceSell = manual && manual.enabled ? false : (elapsedMs >= maxHoldMs)
      let shouldAutoSell = false
      if (manual && manual.enabled) {
        if (effStopRaw == null || effStopRaw === 0) {
          shouldAutoSell = false
        } else if (effStopRaw > 0) {
          const thr = effStopRaw
          if (prevPnl != null && prevPnl >= thr && pnl < thr) shouldAutoSell = true
        } else {
          const thr = effStopRaw
          if (prevPnl != null && prevPnl <= thr && pnl > thr) shouldAutoSell = true
        }
      } else {
        // Without manual, use legacy: profit/loss thresholds or time
        if (pnl >= sellProfit || pnl <= -sellLoss) shouldAutoSell = true
      }
      prevPnl = pnl
      if (shouldAutoSell || shouldForceSell) {
        // ensure approval
        const signerErc = new ethers.Contract(tokenIn, ABI.UniswapV3.ERC20, signer)
        const allowance = await signerErc.allowance(me, V3_ROUTER)
        if (allowance.lt(bal)) {
          const chainId = 8453
          const already = await isApproved(state.redis, { chainId, owner: me, token: tokenIn, spender: V3_ROUTER, system: 'erc20' })
          if (!already) {
            const buildApprove = async () => ({ to: tokenIn, data: signerErc.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
            await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ3-approve-sell' })
            await setApproved(state.redis, { chainId, owner: me, token: tokenIn, spender: V3_ROUTER, system: 'erc20' })
          }
        }
        const params = { tokenIn, tokenOut: WETH, fee, recipient: me, amountIn: bal, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
        const buildSell = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
        const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ3-sell', trade: tradeId, action: 'sell' })
        state.io.emit('trade:sell', { dex: 'UniswapV3', tokenIn, receipt: receiptSell.transactionHash })
        try {
          const me = await signer.getAddress()
          const rx = await computeEthReceivedForTx(state.provider, me, receiptSell)
          const pnlWei = rx.sub(ethers.utils.parseUnits(trading.buyEthAmount, 18))
          addRealizedPnL(state, pnlWei)
          // Complete trade record
          try {
            if (tradeId) {
              const { completeTrade } = require('../lib/trades')
              await completeTrade(state.redis, tradeId, { status: 'closed', realizedEthWei: pnlWei.toString() })
            }
          } catch (_) { }
        } catch (_) { }
        const { closeTrade } = require('./utils')
        subActiveEth(state, ethers.utils.parseUnits(trading.buyEthAmount, 18))
        closeTrade(state)
        sold = true
      }
    } catch (_) { /* transient error; continue */ }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = { create }

// Attach manual methods
function attachManual(state) {
  const { ethers } = require('ethers')
  const ABI = require('./abi')
  state.manualBuy = async ({ token, amountEth }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const V3_ROUTER = state.settings.router
    const WETH = state.settings.weth || DEFAULT_WETH
    const { getV3Params, setManual } = require('../lib/manual')
    const paramsSaved = await getV3Params(state.redis, { trackerId: state.id, token })
    if (!paramsSaved) throw new Error('missing-v3-params')
    const { pool, fee } = paramsSaved

    // Set token to manual mode to prevent automatic selling
    await setManual(state.redis, { trackerId: state.id, token, enabled: true })

    const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, signer)
    const amountIn = ethers.utils.parseUnits(String(amountEth), 18)
    if (!canBuy(state, amountIn)) throw new Error('exposure-limit')
    // Wrap & approve if needed
    const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, signer)
    const buildDeposit = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
    await state.queue.enqueue({ signer, buildTx: buildDeposit, label: 'univ3-manual-wrap', priority: true, resolveOnSent: true })
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ3-manual-approve', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
    }
    const params = { tokenIn: WETH, tokenOut: token, fee: Number(fee), recipient: me, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
    const buildBuy = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
    // Ensure we attach this manual buy to an existing open trade (or create one)
    let tradeId = null
    try {
      const { ensureOpenTrade } = require('../lib/trades')
      const tr = await ensureOpenTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV3', token, pool })
      tradeId = tr?.id || null
    } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'univ3-manual-buy', trade: tradeId, action: 'buy', priority: true, resolveOnSent: true })
    try {
      if (tradeId) {
        const { addBuyEthWei } = require('../lib/trades')
        await addBuyEthWei(state.redis, tradeId, amountIn.toString())
        const key = `trade:${tradeId}`
        const raw = await state.redis.get(key)
        if (raw && receipt?.transactionHash) { const t = JSON.parse(raw); t.buyTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) }
      }
    } catch (_) { }
    addActiveEth(state, amountIn)
    try { await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: amountIn.toString() }) } catch (_) { }
    state.io.emit('trade:buy', { dex: 'UniswapV3', tokenOut: token, amountIn: String(amountEth) })
    // Trigger monitor loop already in place (monitorAndMaybeSell handles emitting). It runs for auto flow; for manual, start a lightweight watcher for UI if pool known
    try {
      const { getV3Params } = require('../lib/manual')
      const p = await getV3Params(state.redis, { trackerId: state.id, token })
      if (p && p.pool) {
        // Reuse monitorAndMaybeSell-style emission but without selling: fire a one-off background loop that reads pool and emits PnL
        ; (async () => {
          const router = new ethers.Contract(state.settings.router, ABI.UniswapV3.Router, state.provider)
          const me = await signer.getAddress()
          const erc = new ethers.Contract(token, ABI.UniswapV3.ERC20, state.provider)
          const poolCtr = new ethers.Contract(p.pool, ABI.UniswapV3.Pool, state.provider)
          const start = Date.now()
          while (true) {
            await sleep(8000)
            const bal = await erc.balanceOf(me).catch(() => null)
            if (!bal || bal.isZero()) break
            let sqrtNow = null
            const s0 = await poolCtr.slot0().catch(() => null)
            if (s0) sqrtNow = s0.sqrtPriceX96
            let outEth = null
            try {
              if (sqrtNow) {
                // Estimate like in monitor: price math
                let t0 = null, t1 = null; try { t0 = await poolCtr.token0(); t1 = await poolCtr.token1() } catch (_) { }
                const W = state.settings.weth || '0x4200000000000000000000000000000000000006'
                const S = ethers.BigNumber.from(sqrtNow)
                const priceX192 = S.mul(S)
                const num = BigInt(priceX192.toString())
                const denom = (1n << 192n)
                const priceScaled = (num * 1000000000000000000n) / denom
                let priceEthScaled = null
                if (t0 && t0.toLowerCase() === W.toLowerCase()) priceEthScaled = (1000000000000000000n * 1000000000000000000n) / priceScaled
                else if (t1 && t1.toLowerCase() === W.toLowerCase()) priceEthScaled = priceScaled
                if (priceEthScaled != null) { const balBI = BigInt(bal.toString()); const outWei = (balBI * priceEthScaled) / 1000000000000000000n; outEth = Number(outWei) / 1e18 }
              }
            } catch (_) { }
            // Baseline inEth
            let inEth = 0
            try { const { getManualExposure } = require('../lib/manual'); const expWei = await getManualExposure(state.redis, { trackerId: state.id, token }); const expEth = Number(expWei || '0') / 1e18; inEth = expEth > 0 ? expEth : inEth } catch (_) { }
            if (inEth <= 0) { try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); if (tr?.buyEthWei) inEth = Number(tr.buyEthWei) / 1e18 } catch (_) { } }
            if (inEth <= 0) inEth = 1e-12
            const pnl = outEth != null ? (outEth - inEth) / inEth : null
            state.io.emit('trade:monitor', { dex: 'UniswapV3', tokenIn: token, pnl, outEth, trackerId: state.id, trackerName: state.name, startedAt: start, manual: true })
          }
        })()
      }
    } catch (_) { }
    return receipt
  }
  state.manualSell = async ({ token, amountPct }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const V3_ROUTER = state.settings.router
    const WETH = state.settings.weth || DEFAULT_WETH
    const erc = new ethers.Contract(token, ABI.UniswapV3.ERC20, state.provider)
    const bal = await erc.balanceOf(me)
    if (bal.isZero()) throw new Error('no-balance')
    // Interpret amountPct robustly:
    // - If between 0 and 1: treat as ratio (e.g., 1 => 100%, 0.5 => 50%)
    // - If between 1 and 100: whole-number percent
    // - If missing/NaN: default to 100
    let pct100
    if (amountPct == null || !Number.isFinite(Number(amountPct))) {
      pct100 = 100
    } else {
      const raw = Number(amountPct)
      if (raw <= 1) pct100 = Math.max(0, Math.min(100, Math.round(raw * 100)))
      else pct100 = Math.max(0, Math.min(100, Math.round(raw)))
    }
    const amountInTok = pct100 >= 100 ? bal : bal.mul(pct100).div(100)
    const signerErc = new ethers.Contract(token, ABI.UniswapV3.ERC20, signer)
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token, spender: V3_ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: token, data: signerErc.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ3-manual-approve-sell', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner: me, token, spender: V3_ROUTER, system: 'erc20' })
    }
    const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, signer)
    // Use saved fee if available
    let feeNum = 3000
    try { const { getV3Params } = require('../lib/manual'); const p = await getV3Params(state.redis, { trackerId: state.id, token }); if (p?.fee) feeNum = Number(p.fee) } catch (_) { }
    const params = { tokenIn: token, tokenOut: WETH, fee: feeNum, recipient: me, amountIn: amountInTok, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
    const buildSell = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
    // Attach to existing open trade if present
    let tradeId = null
    try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ3-manual-sell', trade: tradeId, action: 'sell', priority: true, resolveOnSent: true })
    try { if (tradeId && receipt?.transactionHash) { const key = `trade:${tradeId}`; const raw = await state.redis.get(key); if (raw) { const t = JSON.parse(raw); t.sellTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) } } } catch (_) { }
    try {
      const exp = await getManualExposure(state.redis, { trackerId: state.id, token })
      const expBN = BigInt(exp || '0')
      const delta = (expBN * BigInt(pct100)) / 100n
      subActiveEth(state, ethers.BigNumber.from(delta.toString()))
      await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: (-delta).toString() })
    } catch (_) { }
    state.io.emit('trade:sell', { dex: 'UniswapV3', tokenIn: token })
    // If user sold 100% in manual mode, close the open trade and free the slot
    try {
      const full = (amountPct == null) || (Number.isFinite(Number(amountPct)) ? (Number(amountPct) >= 100 || Number(amountPct) >= 0.999) : true) || pct100 >= 100
      if (full) {
        const { closeTrade } = require('./utils')
        closeTrade(state)
        if (tradeId) {
          const { completeTrade } = require('../lib/trades')
          await completeTrade(state.redis, tradeId, { status: 'closed' })
        }
      }
    } catch (_) { }
    return receipt
  }
}
