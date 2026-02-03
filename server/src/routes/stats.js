const router = require('express').Router()
const os = require('os')
const { requireAuth } = require('../middleware/auth')
const { getRegistry } = require('../trackers/registry')
const { ethers } = require('ethers')

router.get('/', requireAuth, (req, res) => {
  const mem = process.memoryUsage()
  res.json({
    uptime: process.uptime(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    load: os.loadavg(),
  })
})

router.get('/pnl', requireAuth, (req, res) => {
  const reg = getRegistry()
  const items = Object.values(reg)
  const sum = (arr, key) => arr.reduce((a, t) => a.add(ethers.BigNumber.from((t.metrics && t.metrics[key]) || '0')), ethers.BigNumber.from(0))
  res.json({
    activeEthWei: sum(items, 'activeEthWei').toString(),
    realizedPnLEthWei: sum(items, 'realizedPnLEthWei').toString(),
    perTracker: items.map(t => ({ id: t.id, name: t.name, metrics: t.metrics || { activeEthWei: '0', realizedPnLEthWei: '0' } }))
  })
})

module.exports = router
