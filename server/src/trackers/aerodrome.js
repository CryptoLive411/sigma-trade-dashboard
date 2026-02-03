const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { logger, appendTrackerLog } = require('../lib/logger')
const { getTrading, canBuy, addActiveEth, subActiveEth, addRealizedPnL, computeEthReceivedForTx, canTrade, incTrades, isApproved, setApproved } = require('./utils')
const { getManual, addManualExposure, getManualExposure } = require('../lib/manual')

// Base chain canonical WETH
const DEFAULT_WETH = '0x4200000000000000000000000000000000000006'
// Aerodrome factory & router (Base mainnet)
// Source: https://docs.aerodrome.finance (Factory & Router addresses)
const DEFAULT_FACTORY = '0x420dd381b31aef6683db6b902084cb0ffece40da'
const DEFAULT_ROUTER = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43'

function create(ctx) {
  const id = 'aero-' + uuidv4()
  const iface = new ethers.utils.Interface([ABI.Aerodrome.FactoryPairCreated])

  const state = {
    id,
    name: 'Aerodrome',
    type: 'dex',
    enabled: true,
    priority: ctx.runtime?.priorities?.Aerodrome ?? 0,
    include: [],
    blacklist: [],
    settings: { weth: DEFAULT_WETH, factory: DEFAULT_FACTORY, router: DEFAULT_ROUTER },
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
    getLogFilters: () => {
      const FACTORY = state.settings?.factory || DEFAULT_FACTORY
      const topic = ethers.utils.id('PairCreated(address,address,bool,address,uint256)')
      return [{ address: FACTORY, topics: [topic] }]
    },
    onReceipt: async (receipt) => {
      const det = await state.detect(receipt)
      if (det) await state.process(det)
    },
    detect: async (receipt, options) => {
      try {
        const FACTORY = state.settings.factory
        const WETH = state.settings.weth || DEFAULT_WETH
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
            if (![token0, token1].some(t => t.toLowerCase() === WETH.toLowerCase())) { lastReason = 'no-weth-in-pair'; continue }
            // liquidity check (WETH -> pair)
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
            const globalBlacklist = (ctx.runtime.blacklist?.global || []).map(x=>x.toLowerCase())
            const trackerBlacklist = (state.blacklist || []).map(x=>x.toLowerCase())
            const fromTo = [receipt.from, receipt.to].filter(Boolean)
            const candidates = [token0, token1, pair, ...fromTo].filter(Boolean).map(x=>x.toLowerCase())
            if (candidates.some(a => globalBlacklist.includes(a) || trackerBlacklist.includes(a))) { lastReason = 'blacklisted-address'; continue }
            const include = (state.include || []).map(x=>x.toLowerCase())
            if (include.length && !include.some(a=>candidates.includes(a))) { lastReason = 'not-in-include-list'; continue }
            // Honeypot check (optional)
            try {
              const tr2 = getTrading(state)
              if (!tr2.disableHoneypotCheck) {
                const chainId = 8453
                const { checkHoneypot } = require('./utils')
                const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0
                const hp = await checkHoneypot(tokenOut, chainId)
                if (hp) { lastReason = 'honeypot-detected'; continue }
              }
            } catch (_) {}
            try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'detect:match', tx: receipt.transactionHash, token0, token1, pair, wethIn: wethIn.toString() }) } catch (_) {}
            // Reserve trade before confirming detection (only if tracker is enabled)
            if (state.enabled) {
              try {
                const trading = getTrading(state)
                const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
                const { reserveTrade } = require('./utils')
                const res = reserveTrade(state, amountIn)
                if (!res.ok) {
                  const reason = res.reason || 'max_trades_reached'
                  state.io.emit('trade:skip', { dex: 'Aerodrome', reason, tokenOut: token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0 })
                  try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason }) } catch (_) {}
                  continue
                }
              } catch (_) {}
            }
            // Final balance check
            try {
              const trading = getTrading(state)
              const multRaw = process.env.BUY_BALANCE_MULTIPLIER || state.runtime?.trackerDefaults?.buyBalanceMultiplier || 10
              const mult = Math.max(1, Number(multRaw || 10))
              const needWei = ethers.utils.parseUnits(trading.buyEthAmount, 18).mul(ethers.BigNumber.from(mult))
              const { getEthBalanceWei } = require('./utils')
              const haveWei = getEthBalanceWei()
              if (haveWei.lt(needWei)) { lastReason = 'insufficient-eth-balance'; continue }
            } catch (_) {}
            return { token0, token1, pair }
          } catch (_) {}
        }
        if (!sawFactory) lastReason = 'no-factory-logs'
        if (options && options.wantReason) {
          try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: lastReason }) } catch (_) {}
          return { reason: lastReason || 'no-match' }
        }
      } catch (e) { logger.error(e, 'aerodrome detect error') }
      return null
    },
    process: async ({ token0, token1, pair }) => {
      const WETH = state.settings.weth || DEFAULT_WETH
      const ROUTER = state.settings.router
      const signer = state.signer
      if (!signer) return
      const me = await signer.getAddress()
      const tokenOut = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0
      const router = new ethers.Contract(ROUTER, ABI.Aerodrome.Router, state.signer || state.provider)
      await buyAndMonitor({ token0, token1, pair, router, state, WETH, ROUTER })
    }
  }

  async function buyAndMonitor({ token0, token1, pair, router, state, WETH, ROUTER }) {
    const signer = state.signer
    if (!signer) return
    const me = await signer.getAddress()
    const path = token0.toLowerCase() === WETH.toLowerCase() ? [WETH, token1] : [WETH, token0]
    const trading = getTrading(state)
    const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
    // Reservation and exposure limits already enforced in detect(); proceed without re-checking canBuy here
    const tokenOut = path[1]
  // Reservation already done in detect
  const { rollbackReservedTrade, closeTrade } = require('./utils')
    const buildTx = async () => ({
      to: ROUTER,
      data: router.interface.encodeFunctionData('swapExactETHForTokens', [0, path, me, Math.floor(Date.now()/1000)+3600]),
      value: amountIn
    })
    let trade = null
    try {
      const { newTrade } = require('../lib/trades')
      trade = await newTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'Aerodrome', token: tokenOut, pool: pair })
    } catch (_) {}
    let receiptBuy
    try {
      receiptBuy = await state.queue.enqueue({ signer, buildTx, label: 'aero-buy', trade: trade?.id, action: 'buy' })
    } catch (e) {
      rollbackReservedTrade(state)
      try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'buy:error', error: e.message, tokenOut, pair }) } catch (_) {}
      throw e
    }
    addActiveEth(state, amountIn)
    try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'buy:confirmed', tokenOut, pair, amountIn: trading.buyEthAmount }) } catch (_) {}
    state.io.emit('trade:buy', { dex: 'Aerodrome', tokenOut, amountIn: trading.buyEthAmount, pair })

  const baseAutoEth = parseFloat(trading.buyEthAmount)
  const sellLoss = trading.sellLossPct / 100
  const sellProfit = trading.sellProfitPct / 100
    const maxHoldMs = (trading.sellMaxHoldSeconds || 3600) * 1000
    const started = Date.now()
  let sold = false
  // Track previous PnL to detect threshold crossing for signed stop-loss
  let prevPnl = null
    while (!sold) {
      await sleep(8000)
      try {
        const bal = await new ethers.Contract(tokenOut, ABI.Aerodrome.ERC20, state.provider).balanceOf(me).catch(()=>null)
        if (!bal || bal.isZero()) break
        const amounts = await router.getAmountsOut(bal, [tokenOut, WETH]).catch(()=>null)
        if (!amounts) continue
        const outEth = parseFloat(ethers.utils.formatUnits(amounts[1], 18))
        let expWei = '0'
        try { expWei = await getManualExposure(state.redis, { trackerId: state.id, token: tokenOut }) } catch (_) {}
        const expEth = Number(expWei || '0') / 1e18
        const inEth = Math.max(1e-12, baseAutoEth + expEth)
        const pnl = (outEth - inEth) / inEth
        state.io.emit('trade:monitor', { dex: 'Aerodrome', tokenOut, outEth, pnl, trackerId: state.id, trackerName: state.name })
      // Manual mode: only stoploss when enabled; otherwise include profit/time
      let manual = null
      try { manual = await getManual(state.redis, { trackerId: state.id, token: tokenOut }) } catch (_) {}
      const effStopRaw = (manual && manual.enabled && manual.stopLossPct != null) ? Number(manual.stopLossPct)/100 : null
      // Manual semantics:
      //  - effStopRaw > 0 => take-profit threshold; sell when pnl crosses downward below +effStopRaw
      //  - effStopRaw < 0 => loss threshold; sell when pnl crosses upward above effStopRaw (a negative number)
      //  - null => fall back to configured auto stop (sellLoss)
      let shouldSell = false
      if (manual && manual.enabled) {
        if (effStopRaw == null || effStopRaw === 0) {
          // Only manual without threshold: do not auto sell here (no stop), skip time-based exit too
          shouldSell = false
        } else if (effStopRaw > 0) {
          const thr = effStopRaw
          if (prevPnl != null && prevPnl >= thr && pnl < thr) shouldSell = true
        } else { // effStopRaw < 0
          const thr = effStopRaw // negative
          if (prevPnl != null && prevPnl <= thr && pnl > thr) shouldSell = true
        }
      } else {
        shouldSell = (pnl >= sellProfit || pnl <= -sellLoss || (Date.now() - started) >= maxHoldMs)
      }
      prevPnl = pnl
      if (shouldSell) {
        // ensure approve
        const signerErc = new ethers.Contract(tokenOut, ABI.Aerodrome.ERC20, signer)
        const allowance = await signerErc.allowance(me, ROUTER)
        if (allowance.lt(bal)) {
          const buildApprove = async () => ({ to: tokenOut, data: signerErc.interface.encodeFunctionData('approve', [ROUTER, ethers.constants.MaxUint256]) })
          await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'aero-approve-sell' })
          try { const chainId = 8453; await setApproved(state.redis, { chainId, owner: me, token: tokenOut, spender: ROUTER, system: 'erc20' }) } catch (_) {}
        }
        const buildSell = async () => ({
          to: ROUTER,
            data: router.interface.encodeFunctionData('swapExactTokensForETH', [bal, 0, [tokenOut, WETH], me, Math.floor(Date.now()/1000)+3600])
        })
        const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'aero-sell', trade: trade?.id, action: 'sell' })
        state.io.emit('trade:sell', { dex: 'Aerodrome', tokenOut })
        try {
          const rx = await computeEthReceivedForTx(state.provider, me, receiptSell)
          const pnlWei = rx.sub(ethers.utils.parseUnits(trading.buyEthAmount, 18))
          addRealizedPnL(state, pnlWei)
          if (trade?.id) {
            const { completeTrade } = require('../lib/trades')
            await completeTrade(state.redis, trade.id, { status: 'closed', realizedEthWei: pnlWei.toString() })
          }
          try { await appendTrackerLog({ tracker: 'Aerodrome', trackerId: state.id, phase: 'sell:confirmed', tokenOut, pnlWei: pnlWei.toString() }) } catch (_) {}
        } catch (_) {}
        subActiveEth(state, ethers.utils.parseUnits(trading.buyEthAmount, 18))
        const { closeTrade } = require('./utils')
        closeTrade(state)
        sold = true
      }
  } catch (e) { const { logger } = require('../lib/logger'); logger.warn(e, 'Aerodrome monitor transient error') }
    }
  }

  try { attachManual(state) } catch (_) {}
  return state
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)) }

module.exports = { create }

// Manual methods for Aerodrome (V2-like)
function attachManual(state) {
  const { ethers } = require('ethers')
  const ABI = require('./abi')
  state.manualBuy = async ({ token, amountEth }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const ROUTER = state.settings.router
    const WETH = state.settings.weth || DEFAULT_WETH
    const { setManual } = require('../lib/manual')
    
    // Set token to manual mode to prevent automatic selling
    await setManual(state.redis, { trackerId: state.id, token, enabled: true })
    
    const router = new ethers.Contract(ROUTER, ABI.Aerodrome.Router, signer)
    const amountIn = ethers.utils.parseUnits(String(amountEth), 18)
    if (!canBuy(state, amountIn)) throw new Error('exposure-limit')
    const path = [WETH, token]
    const buildBuy = async () => ({ to: ROUTER, data: router.interface.encodeFunctionData('swapExactETHForTokens', [0, path, me, Math.floor(Date.now()/1000)+3600]), value: amountIn })
    const receipt = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'aero-manual-buy', priority: true, resolveOnSent: true })
    try {
      // Aerodrome manual buys are not attached to an explicit tradeId in current code; attach via ensureOpenTrade to get tradeId
      let ensureId = null
      try { const { ensureOpenTrade } = require('../lib/trades'); const tr = await ensureOpenTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'Aerodrome', token }); ensureId = tr?.id || null } catch(_) {}
      if (ensureId) {
        const { addBuyEthWei } = require('../lib/trades')
        await addBuyEthWei(state.redis, ensureId, amountIn.toString())
        const key = `trade:${ensureId}`
        const raw = await state.redis.get(key)
        if (raw && receipt?.transactionHash) { const t = JSON.parse(raw); t.buyTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) }
      }
    } catch (_) {}
    addActiveEth(state, amountIn)
    try { await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: amountIn.toString() }) } catch (_) {}
    state.io.emit('trade:buy', { dex: 'Aerodrome', tokenOut: token })
    return receipt
  }
  state.manualSell = async ({ token, amountPct }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const ROUTER = state.settings.router
    const WETH = state.settings.weth || DEFAULT_WETH
    const erc = new ethers.Contract(token, ABI.Aerodrome.ERC20, state.provider)
    const bal = await erc.balanceOf(me)
    if (bal.isZero()) throw new Error('no-balance')
  // Interpret amountPct as whole-number percent: 1=1%, 10=10%, 100=100%
  const pct100 = amountPct != null ? Math.max(0, Math.min(100, Math.floor(Number(amountPct)))) : 100
  const amountInTok = pct100 >= 100 ? bal : bal.mul(pct100).div(100)
    const signerErc = new ethers.Contract(token, ABI.Aerodrome.ERC20, signer)
    const chainId = 8453
    const alreadyApproved = await isApproved(state.redis, { chainId, owner: me, token, spender: ROUTER, system: 'erc20' })
    if (!alreadyApproved) {
      const buildApprove = async () => ({ to: token, data: signerErc.interface.encodeFunctionData('approve', [ROUTER, ethers.constants.MaxUint256]) })
  await state.queue.enqueue({ signer, buildTx: buildApprove, label: 'aero-manual-approve-sell', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner: me, token, spender: ROUTER, system: 'erc20' })
    }
    const router = new ethers.Contract(ROUTER, ABI.Aerodrome.Router, signer)
    const buildSell = async () => ({ to: ROUTER, data: router.interface.encodeFunctionData('swapExactTokensForETH', [amountInTok, 0, [token, WETH], me, Math.floor(Date.now()/1000)+3600]) })
  const receipt = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'aero-manual-sell', priority: true, resolveOnSent: true })
  try { let trId=null; try{ const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); trId = tr?.id || null } catch(_){}; if (trId && receipt?.transactionHash){ const key = `trade:${trId}`; const raw = await state.redis.get(key); if (raw) { const t = JSON.parse(raw); t.sellTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) } } } catch(_) {}
    try {
      const exp = await getManualExposure(state.redis, { trackerId: state.id, token })
      const expBN = BigInt(exp || '0')
  const delta = (expBN * BigInt(pct100)) / 100n
      subActiveEth(state, ethers.BigNumber.from(delta.toString()))
      await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: (-delta).toString() })
    } catch (_) {}
    state.io.emit('trade:sell', { dex: 'Aerodrome', tokenIn: token })
      // If 100% sold manually, close the trade and free the open slot
      try {
        const full = (amountPct == null) || (Number(amountPct) >= 100)
        if (full) {
          const { closeTrade } = require('./utils')
          closeTrade(state)
          ;(async () => {
            try {
              const { findOpenTrade, completeTrade, getTrade } = require('../lib/trades')
              const tr = await findOpenTrade(state.redis, { trackerId: state.id, token })
              if (tr && tr.id) {
                for (let i=0;i<15;i++) { await new Promise(r=>setTimeout(r,1000)) }
                const t = await getTrade(state.redis, tr.id)
                if (t && t.status !== 'closed') await completeTrade(state.redis, tr.id, { status: 'closed' })
              }
            } catch (_) {}
          })()
        }
      } catch (_) {}
    return receipt
  }
}
