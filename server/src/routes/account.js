const router = require('express').Router()
const { ethers } = require('ethers')
const { requireAuth } = require('../middleware/auth')
const { saveConfig } = require('../lib/runtimeConfig')
const { changeCredentials } = require('../lib/users')

// Update private key (write-only). Never returns the key.
router.post('/signer', requireAuth, async (req, res) => {
  const { privateKey } = req.body || {}
  if (typeof privateKey !== 'string' || privateKey.trim().length < 16) {
    return res.status(400).json({ error: 'invalid private key' })
  }
  const runtime = req.app.get('runtime')
  // Only store in runtime; do not echo back
  runtime.signer = runtime.signer || {}
  runtime.signer.privateKey = privateKey.trim()
  try {
    const provider = new ethers.providers.JsonRpcProvider(runtime.chainRpc)
    const wallet = new ethers.Wallet(privateKey.trim(), provider)
    runtime.signer.address = await wallet.getAddress()
  } catch (_) {
    // keep address empty on failure
    runtime.signer.address = ''
  }
  const saved = await saveConfig(req.app.get('redis'), runtime)
  req.app.set('runtime', saved)

  // Rewire provider/signer in trackers and txQueue
  try {
    const { reattachCtx } = require('../trackers/registry')
    const { configureEthBalancePoller } = require('../lib/ethBalance')
    const provider = new ethers.providers.JsonRpcProvider(saved.chainRpc)
    const signer = saved.signer.privateKey ? new ethers.Wallet(saved.signer.privateKey, provider) : null
    const io = req.app.get('io')
    const redis = req.app.get('redis')
    const queue = req.app.get('txQueue')
    reattachCtx({ provider, signer, redis, io, queue, runtime: saved })
    if (signer && queue && queue.prewarmNonce) {
      try { await queue.prewarmNonce(signer) } catch (_) {}
    }
    if (signer) {
      try {
        const addr = await signer.getAddress()
        const weth = saved?.trading?.weth || process.env.WETH || '0x4200000000000000000000000000000000000006'
        configureEthBalancePoller({ provider, address: addr, io, intervalMs: 30000, weth, signer, queue })
      } catch (_) {}
    }
  } catch (_) {}

  return res.json({ ok: true, address: runtime.signer.address })
})

// Get current signer address
router.get('/signer', requireAuth, async (req, res) => {
  const runtime = req.app.get('runtime')
  try {
    // If privateKey exists but address is missing (e.g., set via env), derive it lazily
    if (!runtime?.signer?.address && runtime?.signer?.privateKey) {
      try {
        const wallet = new ethers.Wallet(runtime.signer.privateKey)
        runtime.signer.address = await wallet.getAddress()
        const saved = await saveConfig(req.app.get('redis'), runtime)
        req.app.set('runtime', saved)
      } catch (_) {
        // ignore derivation errors; fall through with empty address
      }
    }
  } catch (_) {}
  return res.json({ address: runtime?.signer?.address || '' })
})

// Get balances for signer (ETH and optional ERC20 list)
router.get('/balances', requireAuth, async (req, res) => {
  try {
    const runtime = req.app.get('runtime')
    const provider = new ethers.providers.JsonRpcProvider(runtime.chainRpc)
    const address = runtime?.signer?.address
    if (!address) return res.status(400).json({ error: 'no signer address' })
    const ethWei = await provider.getBalance(address)
    const tokens = Array.isArray(req.query.tokens) ? req.query.tokens : (req.query.tokens ? [req.query.tokens] : [])
    const balances = {}
    for (const t of tokens) {
      try {
        const erc = new ethers.Contract(t, ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"], provider)
        const [raw, dec] = await Promise.all([erc.balanceOf(address), erc.decimals().catch(()=>18)])
        balances[t] = { raw: raw.toString(), decimals: Number(dec) }
      } catch (_) {}
    }
    return res.json({ address, eth: ethWei.toString(), tokens: balances })
  } catch (e) {
    return res.status(500).json({ error: 'failed to fetch balances' })
  }
})

module.exports = router
// Update username and/or password for logged-in user
router.post('/credentials', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newUsername, newPassword } = req.body || {}
    if (!currentPassword || (typeof currentPassword !== 'string')) {
      return res.status(400).json({ error: 'current password required' })
    }
    if (newUsername && (typeof newUsername !== 'string' || newUsername.trim().length < 3)) {
      return res.status(400).json({ error: 'username too short' })
    }
    if (newPassword && (typeof newPassword !== 'string' || newPassword.length < 8)) {
      return res.status(400).json({ error: 'password too short' })
    }
    const result = await changeCredentials(req.user.sub, currentPassword, { newUsername, newPassword })
    if (!result) return res.status(401).json({ error: 'invalid password' })
    return res.json(result)
  } catch (e) {
    if (e && e.code === 'USERNAME_TAKEN') return res.status(409).json({ error: 'username already taken' })
    return res.status(500).json({ error: 'failed to update credentials' })
  }
})
