const { ethers } = require('ethers')
const { v4: uuidv4 } = require('uuid')
const ABI = require('./abi')
const { logger, appendTrackerLog } = require('../lib/logger')
const { getTrading, canBuy, addActiveEth, subActiveEth, addRealizedPnL, computeEthReceivedForTx, canTrade, incTrades, isApproved, setApproved } = require('./utils')
const { setV4Params, getManual, addManualExposure, getManualExposure } = require('../lib/manual')
// Lazy-load ESM SDKs from CommonJS
let Actions, V4Planner, CommandType, RoutePlanner
async function loadUniswapV4Deps() {
  if (!Actions || !V4Planner) {
    const v4 = await import('@uniswap/v4-sdk')
    Actions = v4.Actions
    V4Planner = v4.V4Planner
  }
  if (!CommandType || !RoutePlanner) {
    const ur = await import('@uniswap/universal-router-sdk')
    CommandType = ur.CommandType
    RoutePlanner = ur.RoutePlanner
  }
}

const DEFAULT_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
const DEFAULT_UNIVERSAL_ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43'
const DEFAULT_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
// Base mainnet V4 Quoter
const DEFAULT_QUOTER_ADDRESS = '0x0d5e0f971ed27fbff6c2837bf31316121532048d'
const DEFAULT_WETH = '0x4200000000000000000000000000000000000006'

function create(ctx) {
  const id = 'univ4-' + uuidv4()
  const iface = new ethers.utils.Interface([ABI.UniswapV4.PoolManagerInitialize])

  const state = {
    id,
    name: 'UniswapV4',
    type: 'dex',
    enabled: true,
    priority: ctx.runtime?.priorities?.UniswapV4 ?? 0,
    include: [],
    blacklist: [],
    settings: { poolManager: DEFAULT_POOL_MANAGER, universalRouter: DEFAULT_UNIVERSAL_ROUTER, permit2: DEFAULT_PERMIT2_ADDRESS, quoter: DEFAULT_QUOTER_ADDRESS, weth: DEFAULT_WETH },
    trading: {},
    maxActiveBuyEth: '0',
    maxTrades: 0,
    metrics: { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 },
    provider: ctx.provider,
    signer: ctx.signer,
    redis: ctx.redis,
    io: ctx.io,
    queue: ctx.queue,
    runtime: ctx.runtime,
    // Precise log filters for fast detection
    getLogFilters: () => {
      const PM = state.settings?.poolManager || DEFAULT_POOL_MANAGER
      const topic = ethers.utils.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
      return [{ address: PM, topics: [topic] }]
    },
    onReceipt: async (receipt) => {
      const det = await state.detect(receipt)
      if (det) await state.process(det)
    },
    detect: async (receipt, options) => {
      let lastReason = 'no-poolmanager-logs'
      let sawPoolManager = false
      try {
        const POOL_MANAGER = state.settings.poolManager
        const WETH = state.settings.weth || DEFAULT_WETH
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
            // Default UniswapV4 tracker: skip pools that specify a hooks address
            if (hooks && hooks.toLowerCase() !== ethers.constants.AddressZero.toLowerCase()) {
              lastReason = 'hooks-present'
              if (options && options.wantReason) return { reason: lastReason }
              return null
            }
            // Treat native as either WETH or zero address (per updated example)
            const isNative = (addr) => addr.toLowerCase() === WETH.toLowerCase() || addr.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
            if (![currency0, currency1].some((t) => isNative(t))) {
              lastReason = 'no-native-in-pair'
              if (options && options.wantReason) return { reason: lastReason }
              return null
            }
            // lists
            const globalBlacklist = (ctx.runtime.blacklist?.global || []).map((x) => x.toLowerCase())
            const trackerBlacklist = (state.blacklist || []).map((x) => x.toLowerCase())
            const fromTo = [receipt.from, receipt.to].filter(Boolean)
            const candidates = [currency0, currency1, ...fromTo]
              .filter(Boolean)
              .map((x) => x.toLowerCase())
            if (candidates.some((a) => globalBlacklist.includes(a) || trackerBlacklist.includes(a))) {
              lastReason = 'blacklisted-address'
              if (options && options.wantReason) return { reason: lastReason }
              return null
            }
            const include = (state.include || []).map((x) => x.toLowerCase())
            if (include.length && !include.some((a) => candidates.includes(a))) {
              lastReason = 'not-in-include-list'
              if (options && options.wantReason) return { reason: lastReason }
              return null
            }
            // Honeypot check via Uniswap interface API (skip if disabled)
            try {
              const tr2 = getTrading(state)
              if (!tr2.disableHoneypotCheck) {
                const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
                const { checkHoneypot } = require('./utils')
                const tokenOut = isNative(currency0) ? currency1 : currency0
                const hp = await checkHoneypot(tokenOut, chainId)
                if (hp) { lastReason = 'honeypot-detected'; if (options && options.wantReason) return { reason: lastReason }; return null }
              }
            } catch (_) { }
            // liquidity heuristic: WETH transfer to pool manager is not reliable; skip check
            try { await appendTrackerLog({ tracker: 'UniswapV4', trackerId: state.id, phase: 'detect:match', tx: receipt.transactionHash, currency0, currency1, fee: String(fee), tickSpacing: String(tickSpacing), hooks }) } catch (_) { }
            // Reserve trade before confirming detection (only if tracker is enabled)
            if (state.enabled) {
              try {
                const trading = getTrading(state)
                const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
                const { reserveTrade } = require('./utils')
                const res = reserveTrade(state, amountIn)
                if (!res.ok) {
                  const reason = res.reason || 'max_trades_reached'
                  state.io.emit('trade:skip', { dex: 'UniswapV4', reason, token: ((addr) => (addr.toLowerCase() === state.settings.weth.toLowerCase() || addr === '0x0000000000000000000000000000000000000000') ? currency1 : currency0)(currency0) })
                  try { await appendTrackerLog({ tracker: 'UniswapV4', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason }) } catch (_) { }
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
              if (haveWei.lt(needWei)) { if (options && options.wantReason) return { reason: 'insufficient-eth-balance' }; return null }
            } catch (_) { }
            return { currency0, currency1, fee, tickSpacing, hooks }
          } catch (_) { }
        }
      } catch (e) {
        logger.error(e, 'uniswapV4 detect error')
      }
      if (options && options.wantReason) { try { await appendTrackerLog({ tracker: 'UniswapV4', trackerId: state.id, phase: 'detect:skip', tx: receipt.transactionHash, reason: sawPoolManager ? (lastReason || 'no-match') : 'no-poolmanager-logs' }) } catch (_) { }; return { reason: sawPoolManager ? (lastReason || 'no-match') : 'no-poolmanager-logs' } }
      return null
    },
    process: async ({ currency0, currency1, fee, tickSpacing, hooks }) => {
      logger.debug(`UniswapV4 detected new pool (${currency0}/${currency1} fee ${fee} hooks ${hooks})`)
      await loadUniswapV4Deps()
      const signer = state.signer
      if (!signer) return
      const me = await signer.getAddress()
      const UNIVERSAL_ROUTER = state.settings.universalRouter
      const PERMIT2_ADDRESS = state.settings.permit2
      const QUOTER_ADDRESS = state.settings.quoter
      const WETH = state.settings.weth || DEFAULT_WETH
      const ur = new ethers.Contract(UNIVERSAL_ROUTER, ABI.UniswapV4.UniversalRouter, state.signer || state.provider)
      const permit2 = new ethers.Contract(PERMIT2_ADDRESS, [{ "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "address", "name": "spender", "type": "address" }, { "internalType": "uint160", "name": "amount", "type": "uint160" }, { "internalType": "uint48", "name": "expiration", "type": "uint48" }], "name": "approve", "outputs": [], "stateMutability": "nonpayable", "type": "function" }], state.signer || state.provider)
      const isZero = (addr) => addr.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
      const isWETH = (addr) => addr.toLowerCase() === WETH.toLowerCase()
      let zeroForOne = false
      let inCurrency = currency0
      let outCurrency = currency1
      // Determine direction: input is the side that is native (0x0) or WETH
      if (isZero(currency0) || isWETH(currency0)) {
        zeroForOne = true
      } else if (isZero(currency1) || isWETH(currency1)) {
        zeroForOne = false
      }

      const deadline = Math.floor(Date.now() / 1000) + 3600
      const trading = getTrading(state)
      const amountIn = ethers.utils.parseUnits(trading.buyEthAmount, 18)
      // Reservation and exposure limits already enforced in detect(); proceed without re-checking canBuy here
      // trade limit already enforced via reservation in detect
      const CurrentConfig = {
        poolKey: {
          currency0: currency0,
          currency1: currency1,
          fee,
          tickSpacing,
          hooks: hooks || ethers.constants.AddressZero
        },
        zeroForOne: zeroForOne,
        amountIn: amountIn.toString(),
        amountOutMinimum: '0',
        hookData: '0x',
      }
      const v4Planner = new V4Planner()
      const routePlanner = new RoutePlanner()
      v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [CurrentConfig])
      if (zeroForOne) {
        v4Planner.addAction(Actions.SETTLE_ALL, [CurrentConfig.poolKey.currency0, CurrentConfig.amountIn])
        v4Planner.addAction(Actions.TAKE_ALL, [CurrentConfig.poolKey.currency1, CurrentConfig.amountOutMinimum])
      } else {
        v4Planner.addAction(Actions.SETTLE_ALL, [CurrentConfig.poolKey.currency1, CurrentConfig.amountIn])
        v4Planner.addAction(Actions.TAKE_ALL, [CurrentConfig.poolKey.currency0, CurrentConfig.amountOutMinimum])
      }
      const encodedActions = v4Planner.finalize()
      routePlanner.addCommand(CommandType.V4_SWAP, [v4Planner.actions, v4Planner.params])
      // Only send ETH when the actual input currency is the zero address
      const inputIsZero = zeroForOne ? isZero(currency0) : isZero(currency1)
      const inputIsWeth = zeroForOne ? isWETH(currency0) : isWETH(currency1)
      const txValue = inputIsZero ? amountIn : 0
      // If input is WETH (ERC20), wrap ETH first then enqueue approvals via queue before buying
      if (inputIsWeth) {
        try {
          const wethAddr = zeroForOne ? currency0 : currency1
          const ercW = new ethers.Contract(wethAddr, ABI.UniswapV4.ERC20, state.signer || state.provider)
          // Wrap ETH -> WETH for the input amount
          const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, state.signer || state.provider)
          const buildWrap = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
          await state.queue.enqueue({ signer, buildTx: buildWrap, label: 'univ4-wrap' })
          const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
          const owner = me
          const spender = PERMIT2_ADDRESS
          const spender2 = UNIVERSAL_ROUTER
          const { isApproved, setApproved } = require('./utils')
          const alreadyErc = await isApproved(state.redis, { chainId, owner, token: wethAddr, spender, system: 'erc20' })
          if (!alreadyErc) {
            const buildApproveErc = async () => ({
              to: wethAddr,
              data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256])
            })
            await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-approve-erc20' })
            await setApproved(state.redis, { chainId, owner, token: wethAddr, spender, system: 'erc20' })
          }
          const alreadyP2 = await isApproved(state.redis, { chainId, owner, token: wethAddr, spender: spender2, system: 'permit2' })
          if (!alreadyP2) {
            const buildApproveP2 = async () => ({
              to: PERMIT2_ADDRESS,
              data: permit2.interface.encodeFunctionData('approve', [wethAddr, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600'])
            })
            await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-approve-permit2' })
            await setApproved(state.redis, { chainId, owner, token: wethAddr, spender: spender2, system: 'permit2' })
          }
        } catch (_) {
          logger.debug('UniswapV4 buy: error during wrap/approve, skipping buy')
        }
      }
      const buildBuy = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlanner.commands, [encodedActions], deadline]), value: txValue })
      const { rollbackReservedTrade, closeTrade } = require('./utils')
      // Create trade record
      let trade = null
      try {
        const { newTrade } = require('../lib/trades')
        const tokenOut = (zeroForOne ? currency1 : currency0)
        trade = await newTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV4', token: tokenOut, pool: null })
      } catch (_) { }
      let receiptBuy
      try {
        receiptBuy = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'univ4-buy', trade: trade?.id, action: 'buy' })
      } catch (e) {
        rollbackReservedTrade(state)
        try { await appendTrackerLog({ tracker: 'UniswapV4', trackerId: state.id, phase: 'buy:error', error: e.message }) } catch (_) { }
        throw e
      }
      addActiveEth(state, amountIn)
      // persist V4 params for manual ops
      try { await setV4Params(state.redis, { trackerId: state.id, token: (zeroForOne ? currency1 : currency0), currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: hooks || ethers.constants.AddressZero }) } catch (_) { }
      try { await appendTrackerLog({ tracker: 'UniswapV4', trackerId: state.id, phase: 'buy:confirmed', amountIn: trading.buyEthAmount, token: (zeroForOne ? currency1 : currency0) }) } catch (_) { }

      // Monitor using V4 Quoter and sell on profit/loss or max hold
      const sellToken = (isZero(currency0) || isWETH(currency0)) ? currency1 : currency0
      const erc = new ethers.Contract(sellToken, ABI.UniswapV4.ERC20, state.provider)
      const quoter = new ethers.Contract(QUOTER_ADDRESS, ABI.UniswapV4.Quoter, state.provider)

      const maxHoldMs = (trading.sellMaxHoldSeconds || 3600) * 1000
      const sellLoss = trading.sellLossPct / 100
      const sellProfit = trading.sellProfitPct / 100
      const start = Date.now()
      const MAX_UINT128 = ethers.BigNumber.from('0xffffffffffffffffffffffffffffffff')

      // Build poolKey keeping original addresses (no substitution)
      const poolKey = {
        currency0: currency0,
        currency1: currency1,
        fee,
        tickSpacing,
        hooks: hooks || ethers.constants.AddressZero
      }
      // Direction for selling (token -> ETH)
      const sellZeroForOne = !zeroForOne

      let decimals = 18
      try { decimals = await new ethers.Contract(sellToken, ABI.UniswapV4.ERC20, state.provider).decimals() } catch (_) { }

      let sold = false
      let prevPnl = null
      while (!sold) {
        // Time exit only when not in manual mode (checked later per-iteration)
        // Use 8s cadence to match other trackers and UI expectations
        await sleep(8000)
        try {
          const bal = await erc.balanceOf(me).catch(() => null)
          // If balance fetch fails transiently, continue monitoring instead of stopping the loop
          if (!bal) { continue }
          // In V4 flows, token balances can be zero briefly after buy; continue monitoring rather than exiting
          if (bal.isZero()) { continue }

          // quote potential ETH out
          const quoteIn = bal.gt(MAX_UINT128) ? MAX_UINT128 : bal
          let amountOutWei = ethers.BigNumber.from(0)
          try {
            const res = await quoter.callStatic.quoteExactInputSingle({
              poolKey,
              zeroForOne: sellZeroForOne,
              exactAmount: quoteIn,
              hookData: '0x'
            })
            amountOutWei = res.amountOut || res[0]
          } catch (e) {
            // emit error once per loop iteration; if manual is OFF and time exceeded, force sell even without quote
            const elapsed = Date.now() - start
            const timeLeftMs = Math.max(0, maxHoldMs - elapsed)
            state.io.emit('trade:monitor', { dex: 'UniswapV4', token: sellToken, error: 'quote-failed', startedAt: start, maxHoldMs, timeLeftMs, trackerId: state.id, trackerName: state.name })
            let manualNow = null
            try { manualNow = await getManual(state.redis, { trackerId: state.id, token: sellToken }) } catch (_) { }
            if (!(manualNow && manualNow.enabled) && elapsed >= maxHoldMs) {
              try {
                const ercW = new ethers.Contract(sellToken, ABI.UniswapV4.ERC20, state.signer || state.provider)
                const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
                const owner = me
                const spender = PERMIT2_ADDRESS
                const spender2 = UNIVERSAL_ROUTER
                const { isApproved, setApproved } = require('./utils')
                const alreadyErc = await isApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
                if (!alreadyErc) {
                  const buildApproveErc = async () => ({ to: sellToken, data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256]) })
                  await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-approve-erc20' })
                  await setApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
                }
                const alreadyP2 = await isApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
                if (!alreadyP2) {
                  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, [{ "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "address", "name": "spender", "type": "address" }, { "internalType": "uint160", "name": "amount", "type": "uint160" }, { "internalType": "uint48", "name": "expiration", "type": "uint48" }], "name": "approve", "outputs": [], "stateMutability": "nonpayable", "type": "function" }], state.signer || state.provider)
                  const buildApproveP2 = async () => ({ to: PERMIT2_ADDRESS, data: permit2.interface.encodeFunctionData('approve', [sellToken, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600']) })
                  await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-approve-permit2' })
                  await setApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
                }

                const amountBal = await erc.balanceOf(me)
                if (!amountBal.isZero()) {
                  const SellConfig = { poolKey, zeroForOne: sellZeroForOne, amountIn: amountBal.toString(), amountOutMinimum: '0', hookData: '0x' }
                  const v4PlannerS = new V4Planner()
                  const routePlannerS = new RoutePlanner()
                  v4PlannerS.addAction(Actions.SWAP_EXACT_IN_SINGLE, [SellConfig])
                  if (SellConfig.zeroForOne) {
                    v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountIn])
                    v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountOutMinimum])
                  } else {
                    v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountIn])
                    v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountOutMinimum])
                  }
                  const encS = v4PlannerS.finalize()
                  routePlannerS.addCommand(CommandType.V4_SWAP, [v4PlannerS.actions, v4PlannerS.params])
                  const buildSell = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlannerS.commands, [encS], Math.floor(Date.now() / 1000) + 3600]) })
                  const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ4-sell', trade: trade?.id, action: 'sell' })
                  try {
                    const meAddr = await signer.getAddress()
                    const rx = await computeEthReceivedForTx(state.provider, meAddr, receiptSell)
                    const pnlWei = rx.sub(ethers.utils.parseUnits(trading.buyEthAmount, 18))
                    addRealizedPnL(state, pnlWei)
                    try { if (trade?.id) { const { completeTrade } = require('../lib/trades'); await completeTrade(state.redis, trade.id, { status: 'closed', realizedEthWei: pnlWei.toString() }) } } catch (_) { }
                  } catch (_) { }
                  const { closeTrade } = require('./utils')
                  subActiveEth(state, ethers.utils.parseUnits(trading.buyEthAmount, 18))
                  closeTrade(state)
                  sold = true
                }
              } catch (_) { }
            }
            if (!sold) continue
          }

          const inWei = amountIn
          const outEth = parseFloat(ethers.utils.formatUnits(amountOutWei, 18))
          // Include manual exposure baseline if any
          let expWei = '0'
          try { expWei = await getManualExposure(state.redis, { trackerId: state.id, token: sellToken }) } catch (_) { }
          const expEth = Number(expWei || '0') / 1e18
          const baseEth = parseFloat(ethers.utils.formatUnits(inWei, 18)) + expEth
          const inEth = Math.max(1e-12, baseEth)
          const pnlPct = inEth > 0 ? (outEth - inEth) / inEth : 0

          const elapsed = Date.now() - start
          const timeLeftMs = Math.max(0, maxHoldMs - elapsed)
          state.io.emit('trade:monitor', {
            dex: 'UniswapV4',
            token: sellToken,
            balance: bal.toString(),
            quotedEthOut: amountOutWei.toString(),
            pnlPct,
            startedAt: start,
            maxHoldMs,
            timeLeftMs,
            trackerId: state.id,
            trackerName: state.name
          })

          // Decide to sell; if manual, only signed threshold applies; include time-based exit when not manual
          let manual = null
          try { manual = await getManual(state.redis, { trackerId: state.id, token: sellToken }) } catch (_) { }
          const effStopRaw = (manual && manual.enabled && manual.stopLossPct != null) ? Number(manual.stopLossPct) / 100 : null
          let sellSignal = false
          if (manual && manual.enabled) {
            if (effStopRaw == null || effStopRaw === 0) {
              sellSignal = false
            } else if (effStopRaw > 0) {
              const thr = effStopRaw
              if (prevPnl != null && prevPnl >= thr && pnlPct < thr) sellSignal = true
            } else {
              const thr = effStopRaw
              if (prevPnl != null && prevPnl <= thr && pnlPct > thr) sellSignal = true
            }
          } else {
            sellSignal = (pnlPct >= sellProfit || pnlPct <= -sellLoss)
          }
          const shouldForceSell = !(manual && manual.enabled) && (elapsed >= maxHoldMs)
          prevPnl = pnlPct
          if (sellSignal || shouldForceSell) {
            // approve permit2 and router using queue
            const ercW = new ethers.Contract(sellToken, ABI.UniswapV4.ERC20, state.signer || state.provider)
            const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
            const owner = me
            const spender = PERMIT2_ADDRESS
            const spender2 = UNIVERSAL_ROUTER
            const { isApproved, setApproved } = require('./utils')
            const alreadyErc = await isApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
            if (!alreadyErc) {
              const buildApproveErc = async () => ({
                to: sellToken,
                data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256])
              })
              await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-approve-erc20' })
              await setApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
            }
            const alreadyP2 = await isApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
            if (!alreadyP2) {
              const buildApproveP2 = async () => ({
                to: PERMIT2_ADDRESS,
                data: permit2.interface.encodeFunctionData('approve', [sellToken, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600'])
              })
              await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-approve-permit2' })
              await setApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
            }

            const amountBal = await erc.balanceOf(me)
            const SellConfig = {
              poolKey,
              zeroForOne: sellZeroForOne,
              amountIn: amountBal.toString(),
              amountOutMinimum: '0',
              hookData: '0x',
            }
            const v4PlannerS = new V4Planner()
            const routePlannerS = new RoutePlanner()
            v4PlannerS.addAction(Actions.SWAP_EXACT_IN_SINGLE, [SellConfig])
            if (SellConfig.zeroForOne) {
              v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountIn])
              v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountOutMinimum])
            } else {
              v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountIn])
              v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountOutMinimum])
            }
            const encS = v4PlannerS.finalize()
            routePlannerS.addCommand(CommandType.V4_SWAP, [v4PlannerS.actions, v4PlannerS.params])
            const buildSell = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlannerS.commands, [encS], Math.floor(Date.now() / 1000) + 3600]) })
            const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ4-sell', trade: trade?.id, action: 'sell' })
            try {
              const me = await signer.getAddress()
              const rx = await computeEthReceivedForTx(state.provider, me, receiptSell)
              const pnlWei = rx.sub(ethers.utils.parseUnits(trading.buyEthAmount, 18))
              addRealizedPnL(state, pnlWei)
              try {
                if (trade?.id) {
                  const { completeTrade } = require('../lib/trades')
                  await completeTrade(state.redis, trade.id, { status: 'closed', realizedEthWei: pnlWei.toString() })
                }
              } catch (_) { }
            } catch (_) { }
            const { closeTrade } = require('./utils')
            subActiveEth(state, ethers.utils.parseUnits(trading.buyEthAmount, 18))
            closeTrade(state)
            sold = true
          }
        } catch (e) { const { logger } = require('../lib/logger'); logger.warn(e, 'UniswapV4 monitor transient error') }
      }

      // If not sold yet and time exceeded, force sell (only when NOT manual)
      let manualFinal = null
      try { manualFinal = await getManual(state.redis, { trackerId: state.id, token: sellToken }) } catch (_) { }
      if (!sold && !(manualFinal && manualFinal.enabled) && (Date.now() - start >= maxHoldMs)) {
        const ercW = new ethers.Contract(sellToken, ABI.UniswapV4.ERC20, state.signer || state.provider)
        const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
        const owner = me
        const spender = PERMIT2_ADDRESS
        const spender2 = UNIVERSAL_ROUTER
        const { isApproved, setApproved } = require('./utils')
        const alreadyErc = await isApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
        if (!alreadyErc) {
          const buildApproveErc = async () => ({
            to: sellToken,
            data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256])
          })
          await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-approve-erc20' })
          await setApproved(state.redis, { chainId, owner, token: sellToken, spender, system: 'erc20' })
        }
        const alreadyP2 = await isApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
        if (!alreadyP2) {
          const buildApproveP2 = async () => ({
            to: PERMIT2_ADDRESS,
            data: permit2.interface.encodeFunctionData('approve', [sellToken, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600'])
          })
          await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-approve-permit2' })
          await setApproved(state.redis, { chainId, owner, token: sellToken, spender: spender2, system: 'permit2' })
        }

        const amountBal = await erc.balanceOf(me)
        if (!amountBal.isZero()) {
          const SellConfig = {
            poolKey,
            zeroForOne: sellZeroForOne,
            amountIn: amountBal.toString(),
            amountOutMinimum: '0',
            hookData: '0x',
          }
          const v4PlannerS = new V4Planner()
          const routePlannerS = new RoutePlanner()
          v4PlannerS.addAction(Actions.SWAP_EXACT_IN_SINGLE, [SellConfig])
          if (SellConfig.zeroForOne) {
            v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountIn])
            v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountOutMinimum])
          } else {
            v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountIn])
            v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountOutMinimum])
          }
          const encS = v4PlannerS.finalize()
          routePlannerS.addCommand(CommandType.V4_SWAP, [v4PlannerS.actions, v4PlannerS.params])
          const buildSell = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlannerS.commands, [encS], Math.floor(Date.now() / 1000) + 3600]) })
          const receiptSell = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ4-sell', trade: trade?.id, action: 'sell' })
          try {
            const me = await signer.getAddress()
            const rx = await computeEthReceivedForTx(state.provider, me, receiptSell)
            const pnlWei = rx.sub(ethers.utils.parseUnits(trading.buyEthAmount, 18))
            addRealizedPnL(state, pnlWei)
            try {
              if (trade?.id) {
                const { completeTrade } = require('../lib/trades')
                await completeTrade(state.redis, trade.id, { status: 'closed', realizedEthWei: pnlWei.toString() })
              }
            } catch (_) { }
          } catch (_) { }
          const { closeTrade } = require('./utils')
          subActiveEth(state, ethers.utils.parseUnits(trading.buyEthAmount, 18))
          closeTrade(state)
        }
      }
    }
  }

  try { attachManual(state) } catch (_) { }
  return state
}

// Manual methods for V4
function attachManual(state) {
  state.manualBuy = async ({ token, amountEth }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    const me = await signer.getAddress()
    const UNIVERSAL_ROUTER = state.settings.universalRouter
    const PERMIT2_ADDRESS = state.settings.permit2
    const WETH = state.settings.weth || DEFAULT_WETH
    const { getV4Params, setManual } = require('../lib/manual')
    const cfg = await getV4Params(state.redis, { trackerId: state.id, token })
    if (!cfg) throw new Error('missing-v4-params')

    // Set token to manual mode to prevent automatic selling
    await setManual(state.redis, { trackerId: state.id, token, enabled: true })

    await loadUniswapV4Deps()
    const ur = new ethers.Contract(UNIVERSAL_ROUTER, ABI.UniswapV4.UniversalRouter, state.signer || state.provider)
    const isZero = (addr) => addr.toLowerCase() === ethers.constants.AddressZero.toLowerCase()
    const isWETH = (addr) => addr.toLowerCase() === WETH.toLowerCase()
    const zeroForOne = (isZero(cfg.currency0) || isWETH(cfg.currency0))
    const amountIn = ethers.utils.parseUnits(String(amountEth), 18)
    if (!canBuy(state, amountIn)) throw new Error('exposure-limit')
    // Approvals/wrap if WETH input
    const inputIsWeth = zeroForOne ? isWETH(cfg.currency0) : isWETH(cfg.currency1)
    if (inputIsWeth) {
      const weth9 = new ethers.Contract(WETH, ABI.UniswapV3.WETH, signer)
      const buildWrap = async () => ({ to: WETH, data: weth9.interface.encodeFunctionData('deposit', []), value: amountIn })
      await state.queue.enqueue({ signer, buildTx: buildWrap, label: 'univ4-manual-wrap', priority: true, resolveOnSent: true })
      const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
      const owner = me
      const spender = PERMIT2_ADDRESS
      const spender2 = UNIVERSAL_ROUTER
      const { isApproved, setApproved } = require('./utils')
      const ercW = new ethers.Contract(WETH, ABI.UniswapV4.ERC20, signer)
      const alreadyErc = await isApproved(state.redis, { chainId, owner, token: WETH, spender, system: 'erc20' })
      if (!alreadyErc) {
        const buildApproveErc = async () => ({ to: WETH, data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256]) })
        await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-manual-approve-erc20', priority: true, resolveOnSent: true })
        await setApproved(state.redis, { chainId, owner, token: WETH, spender, system: 'erc20' })
      }
      const alreadyP2 = await isApproved(state.redis, { chainId, owner, token: WETH, spender: spender2, system: 'permit2' })
      if (!alreadyP2) {
        const permit2 = new ethers.Contract(PERMIT2_ADDRESS, [{ "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "address", "name": "spender", "type": "address" }, { "internalType": "uint160", "name": "amount", "type": "uint160" }, { "internalType": "uint48", "name": "expiration", "type": "uint48" }], "name": "approve", "outputs": [], "stateMutability": "nonpayable", "type": "function" }], signer)
        const buildApproveP2 = async () => ({ to: PERMIT2_ADDRESS, data: permit2.interface.encodeFunctionData('approve', [WETH, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600']) })
        await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-manual-approve-permit2', priority: true, resolveOnSent: true })
        await setApproved(state.redis, { chainId, owner, token: WETH, spender: spender2, system: 'permit2' })
      }
    }
    const CurrentConfig = {
      poolKey: { currency0: cfg.currency0, currency1: cfg.currency1, fee: cfg.fee, tickSpacing: cfg.tickSpacing, hooks: cfg.hooks || ethers.constants.AddressZero },
      zeroForOne,
      amountIn: amountIn.toString(),
      amountOutMinimum: '0',
      hookData: '0x',
    }
    const v4Planner = new V4Planner()
    const routePlanner = new RoutePlanner()
    v4Planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [CurrentConfig])
    if (zeroForOne) {
      v4Planner.addAction(Actions.SETTLE_ALL, [CurrentConfig.poolKey.currency0, CurrentConfig.amountIn])
      v4Planner.addAction(Actions.TAKE_ALL, [CurrentConfig.poolKey.currency1, CurrentConfig.amountOutMinimum])
    } else {
      v4Planner.addAction(Actions.SETTLE_ALL, [CurrentConfig.poolKey.currency1, CurrentConfig.amountIn])
      v4Planner.addAction(Actions.TAKE_ALL, [CurrentConfig.poolKey.currency0, CurrentConfig.amountOutMinimum])
    }
    const enc = v4Planner.finalize()
    routePlanner.addCommand(CommandType.V4_SWAP, [v4Planner.actions, v4Planner.params])
    const value = (zeroForOne && (cfg.currency0.toLowerCase() === ethers.constants.AddressZero.toLowerCase())) ? amountIn : 0
    const buildBuy = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlanner.commands, [enc], Math.floor(Date.now() / 1000) + 3600]), value })
    // Attach to an existing open trade or create one for this token
    let tradeId = null
    try { const { ensureOpenTrade } = require('../lib/trades'); const tr = await ensureOpenTrade(state.redis, { trackerId: state.id, trackerName: state.name, dex: 'UniswapV4', token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildBuy, label: 'univ4-manual-buy', trade: tradeId, action: 'buy', priority: true, resolveOnSent: true })
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
    state.io.emit('trade:buy', { dex: 'UniswapV4', token })
    // Start a lightweight monitor loop for manual positions to keep UI PnL current
    try {
      const { getV4Params } = require('../lib/manual')
      const p = await getV4Params(state.redis, { trackerId: state.id, token })
      if (p) {
        ; (async () => {
          const me = await signer.getAddress()
          const erc = new ethers.Contract(token, ABI.UniswapV4.ERC20, state.provider)
          const start = Date.now()
          while (true) {
            await sleep(8000)
            const bal = await erc.balanceOf(me).catch(() => null)
            if (!bal || bal.isZero()) break
            // Without a universal router quote, emit baseline-only updates; frontend can still display exposure/time
            let outEth = null
            let inEth = 0
            try { const { getManualExposure } = require('../lib/manual'); const expWei = await getManualExposure(state.redis, { trackerId: state.id, token }); const expEth = Number(expWei || '0') / 1e18; if (expEth > 0) inEth = expEth } catch (_) { }
            if (inEth <= 0) { try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); if (tr?.buyEthWei) inEth = Number(tr.buyEthWei) / 1e18 } catch (_) { } }
            if (inEth <= 0) inEth = 1e-12
            const pnl = outEth != null ? (outEth - inEth) / inEth : null
            state.io.emit('trade:monitor', { dex: 'UniswapV4', token, outEth, pnl, trackerId: state.id, trackerName: state.name, startedAt: start, manual: true })
          }
        })()
      }
    } catch (_) { }
    return receipt
  }
  state.manualSell = async ({ token, amountPct }) => {
    const signer = state.signer
    if (!signer) throw new Error('no-signer')
    await loadUniswapV4Deps()
    const me = await signer.getAddress()
    const UNIVERSAL_ROUTER = state.settings.universalRouter
    const PERMIT2_ADDRESS = state.settings.permit2
    const WETH = state.settings.weth || DEFAULT_WETH
    const erc = new ethers.Contract(token, ABI.UniswapV4.ERC20, state.provider)
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
    const chainId = await state.provider.getNetwork().then(n => n.chainId).catch(() => 8453)
    const owner = me
    const spender = PERMIT2_ADDRESS
    const spender2 = UNIVERSAL_ROUTER
    const { isApproved, setApproved } = require('./utils')
    const ercW = new ethers.Contract(token, ABI.UniswapV4.ERC20, signer)
    const alreadyErc = await isApproved(state.redis, { chainId, owner, token, spender, system: 'erc20' })
    if (!alreadyErc) {
      const buildApproveErc = async () => ({ to: token, data: ercW.interface.encodeFunctionData('approve', [PERMIT2_ADDRESS, ethers.constants.MaxUint256]) })
      await state.queue.enqueue({ signer, buildTx: buildApproveErc, label: 'univ4-manual-approve-erc20', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner, token, spender, system: 'erc20' })
    }
    const alreadyP2 = await isApproved(state.redis, { chainId, owner, token, spender: spender2, system: 'permit2' })
    if (!alreadyP2) {
      const permit2 = new ethers.Contract(PERMIT2_ADDRESS, [{ "inputs": [{ "internalType": "address", "name": "token", "type": "address" }, { "internalType": "address", "name": "spender", "type": "address" }, { "internalType": "uint160", "name": "amount", "type": "uint160" }, { "internalType": "uint48", "name": "expiration", "type": "uint48" }], "name": "approve", "outputs": [], "stateMutability": "nonpayable", "type": "function" }], signer)
      const buildApproveP2 = async () => ({ to: PERMIT2_ADDRESS, data: permit2.interface.encodeFunctionData('approve', [token, UNIVERSAL_ROUTER, '0xffffffffffffffffffffffffffffffffffffffff', '2757489600']) })
      await state.queue.enqueue({ signer, buildTx: buildApproveP2, label: 'univ4-manual-approve-permit2', priority: true, resolveOnSent: true })
      await setApproved(state.redis, { chainId, owner, token, spender: spender2, system: 'permit2' })
    }
    const { getV4Params } = require('../lib/manual')
    const cfg = await getV4Params(state.redis, { trackerId: state.id, token })
    if (!cfg) throw new Error('missing-v4-params')
    // In V4, zeroForOne=true means selling currency0 for currency1. Since we're selling `token`,
    // set zeroForOne based on whether token is currency0.
    const sellZeroForOne = (cfg.currency0.toLowerCase() === token.toLowerCase())
    const SellConfig = {
      poolKey: { currency0: cfg.currency0, currency1: cfg.currency1, fee: cfg.fee, tickSpacing: cfg.tickSpacing, hooks: cfg.hooks || ethers.constants.AddressZero },
      zeroForOne: sellZeroForOne,
      amountIn: amountInTok.toString(),
      amountOutMinimum: '0',
      hookData: '0x',
    }
    const v4PlannerS = new V4Planner()
    const routePlannerS = new RoutePlanner()
    v4PlannerS.addAction(Actions.SWAP_EXACT_IN_SINGLE, [SellConfig])
    if (SellConfig.zeroForOne) {
      v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountIn])
      v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountOutMinimum])
    } else {
      v4PlannerS.addAction(Actions.SETTLE_ALL, [SellConfig.poolKey.currency1, SellConfig.amountIn])
      v4PlannerS.addAction(Actions.TAKE_ALL, [SellConfig.poolKey.currency0, SellConfig.amountOutMinimum])
    }
    const encS = v4PlannerS.finalize()
    routePlannerS.addCommand(CommandType.V4_SWAP, [v4PlannerS.actions, v4PlannerS.params])
    const ur = new ethers.Contract(UNIVERSAL_ROUTER, ABI.UniswapV4.UniversalRouter, signer)
    const buildSell = async () => ({ to: UNIVERSAL_ROUTER, data: ur.interface.encodeFunctionData('execute', [routePlannerS.commands, [encS], Math.floor(Date.now() / 1000) + 30000000600]) })
    // Associate with open trade if present
    let tradeId = null
    try { const { findOpenTrade } = require('../lib/trades'); const tr = await findOpenTrade(state.redis, { trackerId: state.id, token }); tradeId = tr?.id || null } catch (_) { }
    const receipt = await state.queue.enqueue({ signer, buildTx: buildSell, label: 'univ4-manual-sell', trade: tradeId, action: 'sell', priority: true, resolveOnSent: true })
    try { if (tradeId && receipt?.transactionHash) { const key = `trade:${tradeId}`; const raw = await state.redis.get(key); if (raw) { const t = JSON.parse(raw); t.sellTxHash = receipt.transactionHash; await state.redis.set(key, JSON.stringify(t)) } } } catch (_) { }
    try {
      const exp = await getManualExposure(state.redis, { trackerId: state.id, token })
      const expBN = BigInt(exp || '0')
      const delta = (expBN * BigInt(pct100)) / 100n
      subActiveEth(state, ethers.BigNumber.from(delta.toString()))
      await addManualExposure(state.redis, { trackerId: state.id, token, deltaWei: (-delta).toString() })
    } catch (_) { }
    state.io.emit('trade:sell', { dex: 'UniswapV4', token })
    // If user sold 100%, treat the trade as closed and free the open slot
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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = { create }
