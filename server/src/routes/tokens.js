const express = require('express')
const { ethers } = require('ethers')
const { ensureTokenMeta } = require('../trackers/tokens')

const router = express.Router()

router.get('/:address', async (req, res) => {
  try {
    const addrRaw = String(req.params.address || '')
    let checksum
    try {
      checksum = ethers.utils.getAddress(addrRaw)
    } catch (_) {
      return res.status(400).json({ error: 'invalid address' })
    }
    const provider = req.app.get('provider')
    if (!provider) return res.status(503).json({ error: 'provider not ready' })
    const meta = await ensureTokenMeta(provider, checksum)
    return res.json({ address: checksum, ...meta })
  } catch (e) {
    return res.status(500).json({ error: 'failed to load token meta' })
  }
})

module.exports = router
