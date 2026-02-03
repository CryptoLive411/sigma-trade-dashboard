const pino = require('pino')

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

function expressLogger(req, _res, next) {
  logger.debug({ method: req.method, path: req.path, ip: req.ip }, 'req')
  next()
}

// Lightweight tracker event log stored in Redis list "trackerlog"
async function appendTrackerLog(entry) {
  try {
    const payload = JSON.stringify({ time: Date.now(), ...entry })
    const { initRedis } = require('./redis')
    const r = await initRedis()
    await r.rpush('trackerlog', payload)
    await r.ltrim('trackerlog', -500, -1)
  } catch (_) {}
}

module.exports = { logger, expressLogger, appendTrackerLog }
