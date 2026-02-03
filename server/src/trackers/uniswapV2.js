const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const { ensureTokenMeta } = require('./tokens')
const { logger, appendTrackerLog } = require('../lib/logger')
const ABI = require('./abi')
const { getTrading, canBuy, addActiveEth, subActiveEth, addRealizedPnL, computeEthReceivedForTx, canTrade, incTrades, isApproved, setApproved } = require('./utils')
const { getManual, addManualExposure, getManualExposure } = require('../lib/manual')

const DEFAULT_WETH = '0x4200000000000000000000000000000000000006'
const DEFAULT_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6'
const DEFAULT_ROUTER = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'

function create(ctx) {
  const id = 'univ2-' + uuidv4()
  const iface = new ethers.utils.Interface([ABI.UniswapV2.FactoryPairCreated])
  // router is initialized after state for dynamic address
  const state = {
    id,
    name: 'UniswapV2',
    type: 'dex',
    enabled: true,
    priority: ctx.runtime?.priorities?.UniswapV2 ?? 0,
    include: [],
    blacklist: [],
    settings: { weth: DEFAULT_WETH, factory: DEFAULT_FACTORY, router: DEFAULT_ROUTER },
    // per-tracker overrides
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
      const FACTORY = state.settings?.factory || DEFAULT_FACTORY
      const topic = ethers.utils.id('PairCreated(address,address,address,uint256)')
      return [{ address: FACTORY, topics: [topic] }]
    },
    onReceipt: async (receipt) => {
      // in case other parts call via registry.ingestReceipt
      const det = await state.detect(receipt)
      if (det) await state.process(det)
    },
    detect: async (receipt, options) => {
      try {
        const FACTORY = state.settings.factory
        const WETH = state.settings.weth || DEFAULT_WETH
        let capture = { tracker: 'UniswapV2', trackerId: state.id, phase: 'detect', tx: receipt.transactionHash, factory: FACTORY, weth: WETH }
        let lastReason = 'no-factory-logs'
        let sawFactory = false
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== FACTORY.toLowerCase()) continue
          sawFactory = true
          try {
            const ev = iface.parseLog(log)
            if (ev.name !== 'PairCreated') { lastReason = 'wrong-event'; continue }
            const token0 = ev.args.token0
            const token1 = ev.args.token1
            const pair = ev.args.pair
            if (![token0, token1].some((t) => t.toLowerCase() === WETH.toLowerCase())) { lastReason = 'no-weth-in-pair'; continue }
            // Liquidity check: WETH sent to pair
            const wethTopic = ethers.utils.id('Transfer(address,address,uint256)')
            let wethIn = ethers.BigNumber.from(0)
            for (const lg of receipt.logs) {
              if (lg.topics[0] === wethTopic && lg.address.toLowerCase() === WETH.toLowerCase()) {
                const to = '0x' + lg.topics[2].slice(26)
                if (to.toLowerCase() === pair.toLowerCase()) wethIn = wethIn.add(ethers.BigNumber.from(lg.data))
              }
            }
            const tr = getTrading(state)
            const minLiq = tr.minWethLiquidity ?? '1'
            const minWei = ethers.utils.parseUnits(String(minLiq), 18)
            if (wethIn.lt(minWei)) { lastReason = 'insufficient-weth-liquidity'; continue }
            // lists
            const globalBlacklist = (ctx.runtime.blacklist?.global || []).map((x) => x.toLowerCase())
            const trackerBlacklist = (state.blacklist || []).map((x) => x.toLowerCase())
            const fromTo = [receipt.from, receipt.to].filter(Boolean)
            const candidates = [token0, token1, pair, ...fromTo]
              .filter(Boolean)
              .map((x) => x.toLowerCase())
            if (candidates.some((a) => globalBlacklist.includes(a) || trackerBlacklist.includes(a))) { lastReason = 'blacklisted-address'; continue }
            const include = (state.include || []).map((x) => x.toLowerCase())
            if (include.length && !include.some((a) => candidates.includes(a))) { lastReason = 'not-in-include-list'; continue }
            // Honeypot check via Uniswap interface API (skip if disabled)
            try {
              const tr2 = getTrading(state)
              if (!tr2.disableHoneypotCheck) {
                const chainId = 8453
                const { checkHoneypot } = require('./utils')
                const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0
                const hp = await checkHoneypot(tokenOut, chainId)
                if (hp) { lastReason = 'honeypot-detected'; continue }
              }
            } catch (_) { }
            // Before returning a match, attempt reservation (enforce limits early, only if tracker is enabled)
            if (state.enabled) {
              try {
                const trading = getTrading(state)
                const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
                const { reserveTrade } = require('./utils')
                const res = reserveTrade(state, amountIn)
                if (!res.ok) {
                  lastReason = res.reason || 'max_trades_reached'
                  if (!options || !options.wantReason) {
                    state.io.emit('trade:skip', { dex: 'UniswapV2', reason: lastReason, tokenOut: token0 === WETH ? token1 : token0 })
                  }
                  try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: lastReason }) } catch (_) { }
                  continue
                }
              } catch (_) { }
            }
            // Final balance check: ensure signer ETH >= multiplier * buyEthAmount
            try {
              const trading = getTrading(state)
              const multRaw = process.env.BUY_BALANCE_MULTIPLIER || state.runtime?.trackerDefaults?.buyBalanceMultiplier || 10
              const mult = Math.max(1, Number(multRaw || 10))
              const needWei = ethers.utils.parseUnits(trading.buyEthAmount, 18).mul(ethers.BigNumber.from(mult))
              const { getEthBalanceWei } = require('./utils')
              const haveWei = getEthBalanceWei()
              if (haveWei.lt(needWei)) {
                lastReason = 'insufficient-eth-balance'
                try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: `${lastReason}:${mult}x` }) } catch (_) { }
                continue
              }
            } catch (_) { }
            try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'detect:match', tx: receipt.transactionHash, token0, token1, pair, wethIn: wethIn.toString() }) } catch (_) { }
            return { token0, token1, pair }
          } catch (_) { }
        }
        if (!sawFactory) lastReason = 'no-factory-logs'
        if (options && options.wantReason) {
          try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: lastReason }) } catch (_) { }
          return { reason: lastReason || 'no-match' }
        }
      } catch (e) { logger.error(e, 'uniswapV2 detect error') }
      return null
    },
    process: async ({ token0, token1, pair }) => {
      const WETH = state.settings.weth || DEFAULT_WETH
      const ROUTER = state.settings.router
      const tokenOut = token0 === WETH ? token1 : token0
      //await ensureTokenMeta(state.provider, tokenOut)
      const router = new ethers.Contract(ROUTER, ABI.UniswapV2.Router, state.signer || state.provider)
      await buyAndMonitor({ token0, token1, pair, router, state, WETH, ROUTER })
    }
  }

  async function buyAndMonitor({ token0, token1, pair, receipt, router, state, WETH, ROUTER }) {
    const signer = state.signer
    if (!signer) return
    const me = await signer.getAddress()
    const erc = new ethers.Contract(token0 === WETH ? token1 : token0, ABI.UniswapV2.ERC20, state.provider)
    const decimals = await erc.decimals().catch(() => 18)
    const now = Math.floor(Date.now() / 1000)
    const deadline = now + 3600
    const path = token0 === WETH ? [WETH, token1] : [WETH, token0]
    const trading = getTrading(state)
    const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)

    // Reservation and exposure limits already enforced in detect(); proceed without re-checking canBuy here

    const tokenOut = path[1]

    // Reserve an open trade slot to enforce maxTrades under concurrency
    // Reservation already performed in detect(). We only need closeTrade or rollback on failure.
    const { rollbackReservedTrade, closeTrade } = require('./utils')
    const buildTx = async () => ({
      to: ROUTER,
      data: router.interface.encodeFunctionData('swapExactETHForTokens', [0, path, me, deadline]),
      value: amountIn
    })
    // Create trade record
    let trade = null
    try {
      const { newTrade } = require('../lib/trades')
      trade = await newTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV2', token: tokenOut, pool: pair })
    } catch (_) { }
    let receiptBuy
    try {
      receiptBuy = await state.queue.enqueue({ signer, buildTx, label: 'univ2-buy', trade: trade?.id, action: 'buy' })
    } catch (e) {
      // rollback reservation since buy failed
      rollbackReservedTrade(state)
      try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'buy:error', error: e.message, tokenOut, pair }) } catch (_) { }
      throw e
    }
    addActiveEth(state, amountIn)
    const boughtAmount = extractBoughtAmount(receiptBuy, tokenOut, me)
    state.io.emit('trade:buy', { dex: 'UniswapV2', tokenOut, amountIn: trading.buyEthAmount, boughtAmount, pair })
    try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'buy:confirmed', tokenOut, amountIn: trading.buyEthAmount, boughtAmount, pair }) } catch (_) { }

    // Monitor loop (price = via getAmountsOut or reserves)
    const started = Date.now()
    let sold = false
    let prevPnl = null
    const baseAutoEth = parseFloat(ethers.utils.formatUnits(amountIn, 18))
    const sellLoss = trading.sellLossPct / 100
    const sellProfit = trading.sellProfitPct / 100
    const maxHoldMs = (trading.sellMaxHoldSeconds || 3600) * 1000

    while (!sold) {
      await sleep(8000)
      try {
        const held = Date.now() - started
        const bal = await new ethers.Contract(tokenOut, ABI.UniswapV2.ERC20, state.provider).balanceOf(me).catch(() => null)
        if (!bal) continue
        if (bal.isZero()) break
        const amounts = await router.getAmountsOut(bal, [tokenOut, WETH]).catch(() => null)
        if (!amounts) continue
        const outEth = parseFloat(ethers.utils.formatUnits(amounts[1], 18))
        let expWei = '0'
        try { expWei = await getManualExposure(state.redis, { trackerId: state.id, token: tokenOut }) } catch (_) { }
        const expEth = Number(expWei || '0') / 1e18
        const inEth = Math.max(1e-12, baseAutoEth + expEth)
        const pnl = (outEth - inEth) / inEth
        state.io.emit('trade:monitor', { dex: 'UniswapV2', tokenOut, outEth, pnl, trackerId: state.id, trackerName: state.name })
        // Manual mode: signed threshold semantics
        let manual = null
        try { manual = await getManual(state.redis, { trackerId: state.id, token: tokenOut }) } catch (_) { manual = null }
        const effStopRaw = (manual && manual.enabled && manual.stopLossPct != null) ? Number(manual.stopLossPct) / 100 : null
        let shouldSell = false
        if (manual && manual.enabled) {
          if (effStopRaw == null || effStopRaw === 0) {
            shouldSell = false
          } else if (effStopRaw > 0) {
            const thr = effStopRaw
            if (prevPnl != null && prevPnl >= thr && pnl < thr) shouldSell = true
          } else {
            const thr = effStopRaw
            if (prevPnl != null && prevPnl <= thr && pnl > thr) shouldSell = true
          }
        } else {
          shouldSell = (pnl >= sellProfit || pnl <= -sellLoss || held >= maxHoldMs)
        }
        prevPnl = pnl
        if (shouldSell) {
          // ensure approve (with redis approval cache)
          const signerErc = new ethers.Contract(tokenOut, ABI.UniswapV2.ERC20, signer)
          const allowance = await signerErc.allowance(me, ROUTER)
          const chainId = 8453
          if (allowance.lt(bal)) {
            const buildApprove = async () => ({ to: tokenOut, data: signerErc.interface.encodeFunctionData('approve', [ROUTER, ethers.constants.MaxUint256]) })
            await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ2-approve-sell' })
            try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'approve:sent', tokenOut, spender: ROUTER, amount: 'max' }) } catch (_) { }
            await setApproved(state.redis, { chainId, owner: me, token: tokenOut, spender: ROUTER, system: 'erc20' })
          }
          const buildTx2 = async () => ({
            to: ROUTER,
            data: router.interface.encodeFunctionData('swapExactTokensForETH', [bal, 0, [tokenOut, WETH], me, Math.floor(Date.now() / 1000) + 3600])
          })
          const receiptSell = await state.queue.enqueue({ signer, buildTx: buildTx2, label: 'univ2-sell', trade: trade?.id, action: 'sell' })
          const ethReceived = extractEthReceived(receiptSell, me)
          state.io.emit('trade:sell', { dex: 'UniswapV2', tokenOut, ethReceived })
          try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'sell:confirmed', tokenOut, ethReceived, pnlHint: 'computed-below' }) } catch (_) { }
          // Realized PnL and active reduction (compute via balance delta + gas)
          try {
            const rx = await computeEthReceivedForTx(state.provider, me, receiptSell)
            const pnlWei = rx.sub(amountIn) // rx includes returned ETH; subtract cost basis
            addRealizedPnL(state, pnlWei)
            try { await appendTrackerLog({ tracker: 'UniswapV2', trackerId: state.id, phase: 'pnl', tokenOut, pnlWei: pnlWei.toString() }) } catch (_) { }
            try {
              if (trade?.id) {
                const { completeTrade } = require('../lib/trades')
                await completeTrade(state.redis, trade.id, { status: 'closed', realizedEthWei: pnlWei.toString() })
              }
            } catch (_) { }
          } catch (_) { }
          subActiveEth(state, amountIn)
          closeTrade(state)
          sold = true
        }
      } catch (e) { logger.warn(e, 'UniswapV2 monitor transient error'); }
    }
  }

  // attach manual methods
  try { extendManualMethods(state) } catch (_) { }
  return state
}

function extractBoughtAmount(receipt, token, to) {
  const topic = ethers.utils.id('Transfer(address,address,uint256)')
  let total = ethers.BigNumber.from(0)
  for (const log of receipt.logs || []) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    if (log.topics[0] !== topic) continue
    const dst = '0x' + log.topics[2].slice(26)
    if (dst.toLowerCase() === to.toLowerCase()) {
      total = total.add(ethers.BigNumber.from(log.data))
    }
  }
  return total.toString()
}

function extractEthReceived(receipt, to) {
  // Not trivial via logs; fallback to sum of value transfers is not available. Return 0 and rely on amountsOut.
  return '0'
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = { create }

// Extend tracker with manual buy/sell methods
function extendManualMethods(state) {
  const { ethers } = require('ethers')
  const ABI = require('./abi')
  // Track running manual monitors per token to avoid duplicates
  state._manualMonitors = state._manualMonitors || new Map()

  async function ensureManualMonitor(token) {
    if (state._manualMonitors.get(token.toLowerCase())) return
    state._manualMonitors.set(token.toLowerCase(), true)
    const WETH = state.settings.weth
    const ROUTER = state.settings.router
    const routerRO = new ethers.Contract(ROUTER, ABI.UniswapV2.Router, state.provider)
    const me = await state.signer.getAddress()
    const ercRO = new ethers.Contract(token, ABI.UniswapV2.ERC20, state.provider)
    const started = Date.now()
    try {
      while (true) {
        await sleep(8000)
        // End conditions: no balance or manual disabled
        const bal = await ercRO.balanceOf(me).catch(() => null)
        if (!bal || bal.isZero()) break
        let manual = null
        try { const { getManual } = require('../lib/manual'); manual = await getManual(state.redis, { trackerId: state.id, token }) } catch (_) { }
        if (!manual || !manual.enabled) { /* still show, but can stop soon if needed */ }
        // Compute out via router amountsOut
        let outEth = null
        try {
          const amounts = await routerRO.getAmountsOut(bal, [token, WETH])
          if (amounts && amounts[1]) outEth = Number(ethers.utils.formatUnits(amounts[1], 18))
        } catch (_) { }
        // Baseline inEth: prefer manual exposure; else open trade buyEthWei
        let inEth = 0
        try {
          const { getManualExposure } = require('../lib/manual')
          const expWei = await getManualExposure(state.redis, { trackerId: state.id, token })
          const expEth = Number(expWei || '0') / 1e18
          if (expEth > 0) inEth = expEth
          else {
            const { findOpenTrade } = require('../lib/trades')
            const tr = await findOpenTrade(state.redis, { trackerId: state.id, token })
            if (tr && tr.buyEthWei) inEth = Number(tr.buyEthWei) / 1e18
          }
        } catch (_) { }
        if (inEth <= 0) inEth = 1e-12
        let pnl = null
        if (outEth != null) pnl = (outEth - inEth) / inEth
        state.io.emit('trade:monitor', { dex: 'UniswapV2', tokenOut: token, outEth, pnl, trackerId: state.id, trackerName: state.name, startedAt: started, manual: true })
      }
    } finally {
      state._manualMonitors.delete(token.toLowerCase())
    }
  }
  state.manualBuy = async ({ token, amountEth }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const WETH = state.settings.weth
    const ROUTER = state.settings.router
    const { setManual } = require('../lib/manual')

    // Set token to manual mode to prevent automatic selling
    await setManual(state.redis, { trackerId: state.id, token, enabled: true })

    const router = new ethers.Contract(ROUTER, ABI.UniswapV2.Router, signer)
    const amountIn = ethers.utils.parseUnits(String(amountEth), 18)
    if (!canBuy(state, amountIn)) throw new Error('exposure-limit')
    const path = [WETH, token]
    const deadline = Math.floor(Date.now() / 1000) + 3600
    const buildTx = async () => ({ to: ROUTER, data: router.interface.encodeFunctionData('swapExactETHForTokens', [0, path, me, deadline]), value: amountIn })
    let tradeId = null
    try { const { ensureOpenTrade } = require('../lib/trades'); const tr = await ensureOpenTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV2', token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx, label: 'univ2-manual-buy', waitForConfirm: false, resolveOnSent: true, trade: tradeId, action: 'buy', priority: true })
    try {
      if (tradeId) {
        const { addBuyEthWei } = require('../lib/trades')
        await addBuyEthWei(state.redis, tradeId, amountIn.toString())
        // Also store buy hash for fast UI
        const key = `trade:${tradeId}`
        const raw = await state.redis.get(key)
        if (raw && receipt?.transactionHash) {
          const t = JSON.parse(raw)
          t.buyTxHash = receipt.transactionHash
          await state.redis.set(key, JSON.stringify(t))
        }
      }
    } catch (_) { }
    addActiveEth(state, amountIn)
    try { await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: amountIn.toString() }) } catch (_) { }
    state.io.emit('trade:buy', { dex: 'UniswapV2', tokenOut: token, amountIn: String(amountEth) })
    // Start manual monitor loop for this token
    ensureManualMonitor(token).catch(() => { })
    return receipt
  }
  state.manualSell = async ({ token, amountPct }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const WETH = state.settings.weth
    const ROUTER = state.settings.router
    const erc = new ethers.Contract(token, ABI.UniswapV2.ERC20, state.provider)
    let bal = await erc.balanceOf(me)
    if (bal.isZero()) throw new Error('no-balance')
    // Interpret amountPct as whole-number percent: 1=1%, 10=10%, 100=100%
    const pct100 = amountPct != null ? Math.max(0, Math.min(100, Math.floor(Number(amountPct)))) : 100
    const amountInTok = pct100 >= 100 ? bal : bal.mul(pct100).div(100)
    const signerErc = new ethers.Contract(token, ABI.UniswapV2.ERC20, signer)
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token, spender: ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: token, data: signerErc.interface.encodeFunctionData('approve', [ROUTER, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'univ2-manual-approve', priority: true })
      await setApproved(state.redis, { chainId, owner: me, token, spender: ROUTER, system: 'erc20' })
    }
    const router = new ethers.Contract(ROUTER, ABI.UniswapV2.Router, signer)
    const buildSell = async () => ({ to: ROUTER, data: router.interface.encodeFunctionData('swapExactTokensForETH', [amountInTok, 0, [token, WETH], me, Math.floor(Date.now() / 1000) + 3600]) })
    let tradeId = null
    try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ2-manual-sell', waitForConfirm: false, resolveOnSent: true, trade: tradeId, action: 'sell', priority: true })
    // Persist sell hash immediately
    try { if (tradeId && receipt?.transactionHash) { const key = `trade:${tradeId}`; const raw = await state.redis.get(key); if (raw) { const t = JSON.parse(raw); t.sellTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) } } } catch (_) { }
    try {
      const exp = await getManualExposure(state.redis, { trackerId: state.id, token })
      const expBN = BigInt(exp || '0')
      const delta = (expBN * BigInt(pct100)) / 100n
      const sub = ethers.BigNumber.from(delta.toString())
      subActiveEth(state, sub)
      await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: (-delta).toString() })
    } catch (_) { }
    state.io.emit('trade:sell', { dex: 'UniswapV2', tokenOut: token })
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
