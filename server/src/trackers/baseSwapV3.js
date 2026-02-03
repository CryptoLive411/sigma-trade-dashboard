const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { logger } = require('../lib/logger')
const { ensureTokenMeta } = require('./tokens')
const { getTrading, canBuy, addActiveEth, subActiveEth, addRealizedPnL, computeEthReceivedForTx, canTrade, incTrades, isApproved, setApproved } = require('./utils')
const { setV3Params, getManual, addManualExposure, getManualExposure } = require('../lib/manual')
const { initRedis } = require('../lib/redis')

const DEFAULT_V3_FACTORY = '0x38015D05f4fEC8AFe15D7cc0386a126574e8077B'
const DEFAULT_V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'
const DEFAULT_WETH = '0x4200000000000000000000000000000000000006'

function create(ctx) {
  const id = 'baseswapv3-' + uuidv4()
  const iface = new ethers.utils.Interface([ABI.UniswapV3.FactoryPoolCreated])

  const state = {
    id,
    name: 'BaseSwapV3',
    type: 'dex',
    enabled: true,
    priority: ctx.runtime?.priorities?.BaseSwapV3 ?? 0,
    include: [],
    blacklist: [],
    settings: { factory: DEFAULT_V3_FACTORY, router: DEFAULT_V3_ROUTER, weth: DEFAULT_WETH },
    trading: {},
    maxActiveBuyEth: '0',
    maxTrades: 10,
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
                  if (!options || !options.wantReason) state.io.emit('trade:skip', { dex: 'BaseSwapV3', reason, tokenOut: token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0 })
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
            return { pool, token0, token1, fee }
          } catch (_) { }
        }
      } catch (e) {
        logger.error(e, 'BaseSwapV3 detect error')
      }
      if (options && options.wantReason) return { reason: 'no-match' }
      return null
    },
    process: async ({ pool, token0, token1, fee }) => {
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

      const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, state.signer || state.provider)
      const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, state.signer || state.provider)
      const buildDeposit = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
      const { logger } = require('../lib/logger');
      logger.warn(e, 'BaseSwapV3 monitor transient error');
      await state.queue.enqueue({ signer, buildTx: buildDeposit, label: 'baseswapv3-wrap' })
      const chainId = 8453
      const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
      if (!alreadyApproved) {
        const buildApprove = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
        await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'baseswapv3-approve' })
        await setApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
      }

      const params = { tokenIn: WETH, tokenOut, fee, recipient: me, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
      const buildBuy = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
      const { rollbackReservedTrade, closeTrade } = require('./utils')
      // Create trade record before sending buy
      let trade = null
      try {
        const { newTrade } = require('../lib/trades')
        trade = await newTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'BaseSwapV3', token: tokenOut, pool })
      } catch (_) { }
      let receiptBuy
      try {
        receiptBuy = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'baseswapv3-buy', trade: trade?.id, action: 'buy' })
      } catch (e) {
        rollbackReservedTrade(state)
        throw e
      }
      addActiveEth(state, amountIn)
      try { await setV3Params(state.redis, { trackerId: state.id, token: tokenOut, pool, fee }) } catch (_) { }

      const poolCtr = new ethers.Contract(pool, ABI.UniswapV3.Pool, state.provider)
      const slot0 = await poolCtr.slot0().catch(() => null)
      const liq = await poolCtr.liquidity().catch(() => null)
      const initial = slot0 ? { sqrtPriceX96: slot0.sqrtPriceX96.toString(), tick: Number(slot0.tick), liquidity: liq ? liq.toString() : '0' } : null
      if (initial) {
        try {
          const redis = await initRedis()
          const key = 'baseswapv3PoolState'
          await redis.hset(key, pool.toLowerCase(), JSON.stringify({ ...initial, time: Date.now(), fee, token0, token1 }))
        } catch (_) { }
      }

      await monitorAndMaybeSell({ state, router, tokenIn: tokenOut, fee, me, pool, initial, tradeId: trade?.id })
      return receiptBuy
    }
  }
  try { attachManual(state) } catch (_) { }
  return state
}

async function monitorAndMaybeSell({ state, router, tokenIn, fee, me, pool, initial, tradeId }) {
  const WETH = state.settings.weth || DEFAULT_WETH
  const signer = state.signer
  const trading = getTrading(state)
  const sellLoss = trading.sellLossPct / 100
  const sellProfit = trading.sellProfitPct / 100
  const maxHoldMs = (trading.sellMaxHoldSeconds || 3600) * 1000
  const start = Date.now()
  let sold = false
  let prevPnl = null
  const erc = new ethers.Contract(tokenIn, ABI.UniswapV3.ERC20, state.provider)
  const poolCtr = pool ? new ethers.Contract(pool, ABI.UniswapV3.Pool, state.provider) : null
  const startTick = initial?.tick

  while (!sold) {
    await sleep(8000)
    const bal = await erc.balanceOf(me)
    if (bal.isZero()) break
    // Try to read current pool state
    let tickNow = null, sqrtNow = null, liqNow = null
    if (poolCtr) {
      const s0 = await poolCtr.slot0().catch(() => null)
      const lq = await poolCtr.liquidity().catch(() => null)
      if (s0) { tickNow = Number(s0.tick); sqrtNow = s0.sqrtPriceX96 }
      if (lq) liqNow = lq
    }
    let pnl = 0
    if (startTick != null && tickNow != null) {
      const ratio = Math.pow(1.0001, tickNow - startTick)
      pnl = ratio - 1
    }
    // Adjust PnL baseline by manual exposure if present
    try {
      const expWei = await getManualExposure(state.redis, { trackerId: state.id, token: tokenIn })
      const expEth = Number(expWei || '0') / 1e18
      if (expEth > 0) {
        // Convert tick-based pnl to approximate price-based if needed is complex; keep tick-based but adjust reporting via io hint
      }
    } catch (_) { }
    const elapsedMs = Date.now() - start
    const timeLeftMs = Math.max(0, maxHoldMs - elapsedMs)
    // Estimate quoted ETH out by applying current price derived from sqrtPrice to our token balance
    let quotedEthOut = null
    try {
      if (sqrtNow && !bal.isZero()) {
        let t0 = null, t1 = null
        try { t0 = await poolCtr.token0(); t1 = await poolCtr.token1() } catch (_) { }
        const WETH = state.settings.weth || DEFAULT_WETH
        const token0IsWeth = t0 && t0.toLowerCase() === WETH.toLowerCase()
        const token1IsWeth = t1 && t1.toLowerCase() === WETH.toLowerCase()
        // Price of token1 in terms of token0: P = (sqrtPriceX96^2) / 2^192, scaled to 1e18
        const S = ethers.BigNumber.from(sqrtNow)
        const priceX192 = S.mul(S)
        const num = BigInt(priceX192.toString())
        const denom = (1n << 192n)
        const priceScaled = (num * 1000000000000000000n) / denom
        let priceEthScaled = null
        if (token0IsWeth && !token1IsWeth) {
          // token1 per token0 (WETH) => need inverse for token1->ETH
          priceEthScaled = (1000000000000000000n * 1000000000000000000n) / priceScaled
        } else if (token1IsWeth && !token0IsWeth) {
          // token1 is WETH, so priceScaled already token (token1) per token0; but tokenIn is the non-WETH side
          priceEthScaled = priceScaled
        }
        if (priceEthScaled != null) {
          const balBI = BigInt(bal.toString())
          const outWei = (balBI * priceEthScaled) / 1000000000000000000n
          quotedEthOut = outWei.toString()
        }
      }
    } catch (_) { }
    state.io.emit('trade:monitor', { dex: 'BaseSwapV3', token: tokenIn, tokenIn, pnlPct: pnl, pnl, tickDelta: tickNow != null && startTick != null ? (tickNow - startTick) : null, sqrtPriceX96: sqrtNow ? sqrtNow.toString() : null, liquidity: liqNow ? liqNow.toString() : null, quotedEthOut, startedAt: start, maxHoldMs, timeLeftMs, trackerId: state.id, trackerName: state.name })
    // Manual mode: signed stop-loss semantics; otherwise include time exit
    let manual = null
    try { manual = await getManual(state.redis, { trackerId: state.id, token: tokenIn }) } catch (_) { }
    const elapsed = elapsedMs
    let proceedToSell = false
    if (manual && manual.enabled) {
      const effStopRaw = manual.stopLossPct != null ? (Number(manual.stopLossPct) / 100) : null
      if (effStopRaw == null || effStopRaw === 0) {
        proceedToSell = false
      } else if (effStopRaw > 0) {
        const thr = effStopRaw
        if (prevPnl != null && prevPnl >= thr && pnl < thr) proceedToSell = true
      } else {
        const thr = effStopRaw
        if (prevPnl != null && prevPnl <= thr && pnl > thr) proceedToSell = true
      }
    } else {
      proceedToSell = (elapsed >= maxHoldMs) || (pnl >= sellProfit || pnl <= -sellLoss)
    }
    prevPnl = pnl
    if (!proceedToSell) continue
    const signerErc = new ethers.Contract(tokenIn, ABI.UniswapV3.ERC20, signer)
    const V3_ROUTER = state.settings.router
    const allowance = await signerErc.allowance(me, V3_ROUTER)
    if (allowance.lt(bal)) {
      const chainId = 8453
      const already = await isApproved(state.redis, { chainId, owner: me, token: tokenIn, spender: V3_ROUTER, system: 'erc20' })
      if (!already) {
        const buildApprove = async () => ({ to: tokenIn, data: signerErc.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
        await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'baseswapv3-approve-sell' })
        await setApproved(state.redis, { chainId, owner: me, token: tokenIn, spender: V3_ROUTER, system: 'erc20' })
      }
    }
    const params = { tokenIn, tokenOut: WETH, fee, recipient: me, amountIn: bal, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
    const buildSell = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
    const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'baseswapv3-sell', trade: tradeId, action: 'sell' })
    try {
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
}


function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = { create }

// Manual methods similar to UniswapV3
function attachManual(state) {
  const { ethers } = require('ethers')
  const ABI = require('./abi')
  const DEFAULT_WETH = state.settings.weth
  state.manualBuy = async ({ token, amountEth }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const V3_ROUTER = state.settings.router
    const { getV3Params, setManual } = require('../lib/manual')
    const paramsSaved = await getV3Params(state.redis, { trackerId: state.id, token })
    if (!paramsSaved) throw new Error('missing-v3-params')
    const { fee } = paramsSaved

    // Set token to manual mode to prevent automatic selling
    await setManual(state.redis, { trackerId: state.id, token, enabled: true })

    const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, signer)
    const amountIn = ethers.utils.parseUnits(String(amountEth), 18)
    if (!canBuy(state, amountIn)) throw new Error('exposure-limit')
    const WETH = DEFAULT_WETH
    const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, signer)
    const buildDeposit = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
    await state.queue.enqueue({ signer, buildTx: buildDeposit, label: 'baseswapv3-manual-wrap', priority: true, resolveOnSent: true })
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'baseswapv3-manual-approve', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner: me, token: WETH, spender: V3_ROUTER, system: 'erc20' })
    }
    const params = { tokenIn: WETH, tokenOut: token, fee: Number(fee), recipient: me, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
    const buildBuy = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
    let tradeId = null
    try { const { ensureOpenTrade } = require('../lib/trades'); const tr = await ensureOpenTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'BaseSwapV3', token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'baseswapv3-manual-buy', trade: tradeId, action: 'buy', priority: true, resolveOnSent: true })
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
    state.io.emit('trade:buy', { dex: 'BaseSwapV3', tokenOut: token })
    // Start a lightweight monitor loop to emit quotedOut/pnl for UI
    try {
      const { getV3Params } = require('../lib/manual')
      const p = await getV3Params(state.redis, { trackerId: state.id, token })
      if (p && p.fee != null) {
        ; (async () => {
          const WETH = DEFAULT_WETH
          const me = await signer.getAddress()
          const erc = new ethers.Contract(token, ABI.UniswapV3.ERC20, state.provider)
          const start = Date.now()
          while (true) {
            await sleep(8000)
            const bal = await erc.balanceOf(me).catch(() => null)
            if (!bal || bal.isZero()) break
            // Approx: try router exactInputSingle quote via price math isn't trivial without pool; skip precise math and emit null outEth if unavailable
            let outEth = null
            // Baseline in
            let inEth = 0
            try { const { getManualExposure } = require('../lib/manual'); const expWei = await getManualExposure(state.redis, { trackerId: state.id, token }); const expEth = Number(expWei || '0') / 1e18; if (expEth > 0) inEth = expEth } catch (_) { }
            if (inEth <= 0) { try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); if (tr?.buyEthWei) inEth = Number(tr.buyEthWei) / 1e18 } catch (_) { } }
            if (inEth <= 0) inEth = 1e-12
            const pnl = outEth != null ? (outEth - inEth) / inEth : null
            state.io.emit('trade:monitor', { dex: 'BaseSwapV3', tokenIn: token, outEth, pnl, trackerId: state.id, trackerName: state.name, startedAt: start, manual: true })
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
    const WETH = DEFAULT_WETH
    const erc = new ethers.Contract(token, ABI.UniswapV3.ERC20, state.provider)
    const bal = await erc.balanceOf(me)
    if (bal.isZero()) throw new Error('no-balance')
    // Interpret amountPct as whole-number percent: 1=1%, 10=10%, 100=100%
    const pct100 = amountPct != null ? Math.max(0, Math.min(100, Math.floor(Number(amountPct)))) : 100
    const amountInTok = pct100 >= 100 ? bal : bal.mul(pct100).div(100)
    const signerErc = new ethers.Contract(token, ABI.UniswapV3.ERC20, signer)
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token, spender: V3_ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: token, data: signerErc.interface.encodeFunctionData('approve', [V3_ROUTER, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'baseswapv3-manual-approve-sell', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner: me, token, spender: V3_ROUTER, system: 'erc20' })
    }
    const router = new ethers.Contract(V3_ROUTER, ABI.UniswapV3.Router, signer)
    let fee = 3000
    try { const { getV3Params } = require('../lib/manual'); const p = await getV3Params(state.redis, { trackerId: state.id, token }); if (p?.fee) fee = Number(p.fee) } catch (_) { }
    const params = { tokenIn: token, tokenOut: WETH, fee, recipient: me, amountIn: amountInTok, amountOutMinimum: 0, sqrtPriceLimitX96: 0 }
    const buildSell = async () => ({ to: V3_ROUTER, data: router.interface.encodeFunctionData('exactInputSingle', [params]) })
    let tradeId = null
    try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'baseswapv3-manual-sell', trade: tradeId, action: 'sell', priority: true, resolveOnSent: true })
    try { if (tradeId && receipt?.transactionHash) { const key = `trade:${tradeId}`; const raw = await state.redis.get(key); if (raw) { const t = JSON.parse(raw); t.sellTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) } } } catch (_) { }
    try {
      const exp = await getManualExposure(state.redis, { trackerId: state.id, token })
      const expBN = BigInt(exp || '0')
      const delta = (expBN * BigInt(pct100)) / 100n
      subActiveEth(state, ethers.BigNumber.from(delta.toString()))
      await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: (-delta).toString() })
    } catch (_) { }
    state.io.emit('trade:sell', { dex: 'BaseSwapV3', tokenIn: token })
    // If user sold 100%, close the open trade and free the slot
    try {
      const full = (amountPct == null) || (Number(amountPct) >= 100)
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
