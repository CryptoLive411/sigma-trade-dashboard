const Redis = require('ioredis')
const { logger } = require('./logger')

let client
async function initRedis() {
  if (client) return client
  const url = process.env.REDIS_URL || 'redis://localhost:6379'
  client = new Redis(url)
  client.on('error', (e) => logger.error(e, 'redis error'))
  client.on('connect', () => logger.info('redis connected'))
  return client
}

module.exports = { initRedis }
