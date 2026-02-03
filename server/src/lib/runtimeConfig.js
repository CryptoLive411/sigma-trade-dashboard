const { initRedis } = require('./redis')

const CHAIN_RPC_DEFAULT = process.env.CHAIN_RPC || 'https://rpc.ankr.com/base/13e95b625e746ac632c46cea310e1f0129f21f590951c9e4868fd59aae842176'
const DEFAULTS = {
  chainRpc: CHAIN_RPC_DEFAULT,
  // Optional WS endpoint for real-time log subscriptions (preferred); if not provided, we try to derive from chainRpc
  chainWs: process.env.CHAIN_WS || deriveWsFromHttp(CHAIN_RPC_DEFAULT),
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    // bcrypt hash handled in users.js
  },
  signer: {
    address: '',
    privateKey: process.env.PRIVATE_KEY || '',
  },
  // Buy/sell config defaults; editable via API
  trading: {
    weth: '0x4200000000000000000000000000000000000006',
    buyEthAmount: '0.00001',
    sellProfitPct: 200,
    sellLossPct: 10,
    sellMaxHoldSeconds: 600, // 1 hour
    minWethLiquidity: '0',
    gasLimit: '1000000',
    // Max gas price cap used by the tx queue (applied to maxFeePerGas/maxPriorityFeePerGas)
    gasPriceGweiMax: process.env.GAS_MAX_GWEI || '0.015',
    disableHoneypotCheck: true
  },
  // Per-tracker defaults (trackers can override these fields on their instance)
  trackerDefaults: {
    trading: {}, // partial overrides of trading
    maxActiveBuyEth: '0', // '0' = unlimited; otherwise caps sum of active buys in ETH per tracker
    maxTrades: 10,
    settings: {},
    // Require signer ETH balance to be at least N times buyEthAmount to consider a detection valid
    buyBalanceMultiplier: Number(process.env.BUY_BALANCE_MULTIPLIER || 10)
  },
  blacklist: {
    global: []
  },
  include: {
    // trackerName: [addresses]
  },
  priorities: {
    UniswapV2: 0,
    UniswapV3: 0,
    UniswapV4: 0,
    BaseSwapV2: 0,
    BaseSwapV3: 0,
    KingOfApes: 0,
    ApeStore: 0
  }
}

async function loadConfig(redis) {
  try {
    if (redis) {
      const raw = await redis.get('runtime')
      if (raw) return JSON.parse(raw)
      // seed defaults
      await redis.set('runtime', JSON.stringify(DEFAULTS))
    }
  } catch (_) { }
  return DEFAULTS
}

async function saveConfig(redis, obj) {
  try {
    try { if (redis) await redis.set('runtime', JSON.stringify(obj)) } catch (_) { }
  } catch (_) { }
  return obj
}

module.exports = { loadConfig, saveConfig, DEFAULTS }

function deriveWsFromHttp(httpUrl) {
  try {
    if (!httpUrl) return ''
    const u = new URL(httpUrl)
    if (u.protocol === 'http:') u.protocol = 'ws:'
    if (u.protocol === 'https:') u.protocol = 'wss:'
    return u.toString()
  } catch (_) {
    return ''
  }
}
