const { v4: uuidv4 } = require('uuid')
const { initRedis } = require('../lib/redis')

const REGISTRY = {}

function getRegistry() { return REGISTRY }
function getActiveTrackers() { return Object.values(REGISTRY).filter(t => t.enabled) }
function getAllTrackers() { return Object.values(REGISTRY) }

async function initRegistry(ctx) {
  const redis = ctx.redis || (await initRedis())
  let saved = null
  try {
    const raw = await redis.get('trackers')
    saved = raw ? JSON.parse(raw) : null
  } catch (_) { saved = null }
  if (saved && Array.isArray(saved) && saved.length) {
    // Rehydrate saved trackers using their module factories so methods (detect/process) exist
    const factories = {
      UniswapV2: require('./uniswapV2'),
      UniswapV3: require('./uniswapV3'),
      UniswapV4: require('./uniswapV4'),
      BaseSwapV2: require('./baseSwapV2'),
      BaseSwapV3: require('./baseSwapV3'),
      ApeStore: require('./apeStore'),
      KingOfApes: require('./kingOfApes'),
      ContentCoin: require('./contentCoinLaunchpad'),
      Zora: require('./zoraLaunchpad'),
      ClankerV4: require('./clankerV4'),
      Aerodrome: require('./aerodrome'),
    }

    const pickFactoryKey = (t) => {
      const nm = (t.name || '').toLowerCase()
      if (nm.startsWith('uniswapv2')) return 'UniswapV2'
      if (nm.startsWith('uniswapv3')) return 'UniswapV3'
      if (nm.startsWith('uniswapv4')) return 'UniswapV4'
      if (nm.startsWith('baseswapv2')) return 'BaseSwapV2'
      if (nm.startsWith('baseswapv3')) return 'BaseSwapV3'
      if (nm.startsWith('apestore')) return 'ApeStore'
      if (nm.startsWith('kingofapes')) return 'KingOfApes'
      if (nm.startsWith('contentcoin')) return 'ContentCoin'
      if (nm.startsWith('zora')) return 'Zora'
      if (nm.startsWith('clankerv4') || nm.startsWith('clanker')) return 'ClankerV4'
      if (nm.startsWith('aerodrome')) return 'Aerodrome'
      // Fallback by settings shape
      const s = t.settings || {}
      if (s.poolManager && s.universalRouter) return 'UniswapV4'
      if (s.factory && s.router) {
        // Default to V3 if ambiguous; ApeStore is a V3 variant but named accordingly above
        return 'UniswapV3'
      }
      // Last resort: V3
      return 'UniswapV3'
    }

    for (const t of saved) {
      const key = pickFactoryKey(t)
      const base = factories[key]?.create(ctx)
      if (!base) continue
      // Mutate the created instance so method closures keep referencing the same object
      // apply runtime tracker defaults for missing fields
      const withDefaults = applyTrackerDefaults(t, ctx)
      Object.assign(base, withDefaults, ctxRefs(ctx))
      // Respect saved enabled flag if present; otherwise default to false
      if (typeof withDefaults.enabled === 'boolean') {
        base.enabled = !!withDefaults.enabled
      } else {
        base.enabled = false
      }
      REGISTRY[base.id] = base
    }
    // Append any newly supported trackers that weren't in saved state
    const haveNames = new Set(Object.values(REGISTRY).map(t => (t.name || '').toLowerCase()))
    if (!haveNames.has('baseswapv2')) {
      const bs2 = require('./baseSwapV2').create(ctx)
      Object.assign(bs2, applyTrackerDefaults(bs2, ctx))
      bs2.enabled = false
      REGISTRY[bs2.id] = bs2
    }
    if (!haveNames.has('baseswapv3')) {
      const bs3 = require('./baseSwapV3').create(ctx)
      Object.assign(bs3, applyTrackerDefaults(bs3, ctx))
      bs3.enabled = false
      REGISTRY[bs3.id] = bs3
    }
    if (!haveNames.has('contentcoin launchpad')) {
      const cc = require('./contentCoinLaunchpad').create(ctx)
      Object.assign(cc, applyTrackerDefaults(cc, ctx))
      cc.enabled = false
      REGISTRY[cc.id] = cc
    }
    if (!haveNames.has('zora launchpad')) {
      const zr = require('./zoraLaunchpad').create(ctx)
      Object.assign(zr, applyTrackerDefaults(zr, ctx))
      zr.enabled = false
      REGISTRY[zr.id] = zr
    }
    if (!haveNames.has('clankerv4')) {
      const ck = require('./clankerV4').create(ctx)
      Object.assign(ck, applyTrackerDefaults(ck, ctx))
      ck.enabled = false
      REGISTRY[ck.id] = ck
    }
    if (!haveNames.has('aerodrome')) {
      const ad = require('./aerodrome').create(ctx)
      Object.assign(ad, applyTrackerDefaults(ad, ctx))
      ad.enabled = false
      REGISTRY[ad.id] = ad
    }
  } else {
    // default trackers (disabled on startup by default)
    const defaults = [
      require('./uniswapV2'),
      require('./uniswapV3'),
      require('./uniswapV4'),
      require('./baseSwapV2'),
      require('./baseSwapV3'),
      require('./apeStore'),
      require('./kingOfApes'),
      require('./contentCoinLaunchpad'),
      require('./zoraLaunchpad'),
      require('./clankerV4'),
      require('./aerodrome'),
    ]
    for (const def of defaults) {
      const inst = def.create(ctx)
      Object.assign(inst, applyTrackerDefaults(inst, ctx))
      inst.enabled = false
      REGISTRY[inst.id] = inst
    }
    await persist()
  }
}

function ctxRefs(ctx) {
  return { provider: ctx.provider, signer: ctx.signer, redis: ctx.redis, io: ctx.io, queue: ctx.queue, runtime: ctx.runtime }
}

function reattachCtx(ctx) {
  for (const t of Object.values(REGISTRY)) {
    Object.assign(t, ctxRefs(ctx))
  }
}

async function persist() {
  try {
    const arr = Object.values(REGISTRY).map(({ provider, signer, redis, io, queue, runtime, ...pure }) => pure)
    const redis = await initRedis()
    await redis.set('trackers', JSON.stringify(arr))
  } catch (_) { }
}

function cloneTracker(id, { newId, name, settings }) {
  const t = REGISTRY[id]
  if (!t) throw new Error('tracker not found')
  const clone = { ...t, id: newId || uuidv4(), name: name || `${t.name}-clone`, settings: { ...t.settings, ...(settings || {}) }, enabled: false }
  REGISTRY[clone.id] = clone
  persist()
  return clone
}

function updateTrackerSettings(id, partial) {
  const t = REGISTRY[id]
  if (!t) throw new Error('tracker not found')
  Object.assign(t, partial)
  persist()
  return t
}

function setTrackerEnabled(id, enabled) {
  const t = REGISTRY[id]
  if (!t) throw new Error('tracker not found')
  t.enabled = enabled
  persist()
  return t
}

async function ingestReceipt(tracker, receipt) {
  if (!tracker.enabled) return
  await tracker.onReceipt(receipt)
}

module.exports = { initRegistry, getRegistry, getActiveTrackers, getAllTrackers, cloneTracker, updateTrackerSettings, setTrackerEnabled, ingestReceipt, reattachCtx, persist }

function applyTrackerDefaults(obj, ctx) {
  const def = (ctx.runtime && ctx.runtime.trackerDefaults) || {}
  const merged = { ...obj }
  // Seed trading defaults from runtime.trading first, then override with trackerDefaults.trading, then tracker-specific overrides
  const runtimeTrading = (ctx.runtime && ctx.runtime.trading) || {}
  merged.trading = { ...runtimeTrading, ...(def.trading || {}), ...(merged.trading || {}) }
  if (merged.maxActiveBuyEth == null) merged.maxActiveBuyEth = def.maxActiveBuyEth || '0'
  if (merged.maxTrades == null) merged.maxTrades = def.maxTrades || 0
  // merge settings so that factory/router/etc default from runtime if present
  merged.settings = { ...(def.settings || {}), ...(merged.settings || {}) }
  if (!merged.metrics) merged.metrics = { activeEthWei: '0', realizedPnLEthWei: '0', tradesCount: 0 }
  return merged
}
