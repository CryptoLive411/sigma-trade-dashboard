const router = require('express').Router()
const { requireAuth } = require('../middleware/auth')
const { saveConfig } = require('../lib/runtimeConfig')

router.get('/', requireAuth, async (req, res) => {
  const r = { ...req.app.get('runtime') }
  if (r && r.signer) r.signer = { ...r.signer, privateKey: undefined }
  res.json(r)
})

router.put('/', requireAuth, async (req, res) => {
  const allowed = ['chainRpc', 'trading', 'blacklist', 'include', 'priorities', 'trackerDefaults']
  const body = req.body || {}
  const runtime = { ...req.app.get('runtime') }
  for (const k of allowed) if (body[k] != null) runtime[k] = body[k]
  const saved = await saveConfig(req.app.get('redis'), runtime)
  req.app.set('runtime', saved)
  const safe = { ...saved, signer: { address: saved.signer?.address || '' } }
  res.json(safe)
})

router.put('/lists', requireAuth, async (req, res) => {
  const runtime = req.app.get('runtime')
  runtime.blacklist = req.body.blacklist || runtime.blacklist
  runtime.include = req.body.include || runtime.include
  const saved = await saveConfig(req.app.get('redis'), runtime)
  req.app.set('runtime', saved)
  res.json(saved)
})

module.exports = router
