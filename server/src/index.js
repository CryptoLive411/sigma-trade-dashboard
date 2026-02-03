// Main server entry: Express + Socket.IO + Redis + Trackers orchestrator
require('dotenv').config()
const express = require('express')
const http = require('http')
const cors = require('cors')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const { Server } = require('socket.io')
const { initRedis } = require('./lib/redis')
const { logger, expressLogger } = require('./lib/logger')
const { ensureAdminUser } = require('./lib/users')
const { loadConfig } = require('./lib/runtimeConfig')
const { OutgoingTxQueue } = require('./lib/txQueue')
const { initTrackers } = require('./trackers')
const { startLogSubscriber } = require('./lib/logSubscriber')
const { configureEthBalancePoller } = require('./lib/ethBalance')
const { startDetectionCleanup } = require('./lib/detectionCleanup')
const { cleanupPendingTxs } = require('./lib/pendingTxCleanup')

async function main() {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST','PUT','DELETE'] } })

  // Middleware
  app.use(cors({ origin: '*', credentials: true }))
  app.use(helmet())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use(cookieParser())
  app.use(expressLogger)
  app.set('trust proxy', 1)
  const limiter = rateLimit({ windowMs: 60 * 1000, max: 120 })
  app.use(limiter)

  // Redis
  const redis = await initRedis()

  // Ensure admin user exists
  await ensureAdminUser()

  // Runtime config
  const runtime = await loadConfig(redis)
  app.set('runtime', runtime)
  app.set('redis', redis)

  // Socket.IO
  io.on('connection', (socket) => {
    logger.info({ id: socket.id }, 'client connected')
    socket.emit('hello', { ok: true })
    socket.on('disconnect', () => logger.info({ id: socket.id }, 'client disconnected'))
  })
  app.set('io', io)

  // Outgoing tx queue (per signer)
  const queue = new OutgoingTxQueue(redis, io)
  app.set('txQueue', queue)

  // Routes
  app.use('/api/auth', require('./routes/auth'))
  app.use('/api/runtime', require('./routes/runtime'))
  app.use('/api/trackers', require('./routes/trackers'))
  app.use('/api/tx', require('./routes/tx'))
  app.use('/api/stats', require('./routes/stats'))
  app.use('/api/account', require('./routes/account'))
  app.use('/api/trades', require('./routes/trades'))
  app.use('/api/tokens', require('./routes/tokens'))
  app.use('/api/detections', require('./routes/detections'))
  app.use('/api/trackerlog', require('./routes/trackerlog'))

  app.get('/health', (req, res) => res.json({ ok: true }))

  // Trackers and chain watchers
  const { provider, signer } = await initTrackers({ redis, io, runtime, queue })
  app.set('provider', provider)
  // Prewarm nonce for the configured signer to avoid initial nonce races
  if (signer) {
    // First, clear any stuck pending txs for our signer to ensure clean nonce state
    try {
      const res = await cleanupPendingTxs({ provider, signer })
      if (res && res.ok) {
        logger.info({ cleared: res.cleared, remaining: res.remaining }, 'startup: pending tx cleanup done')
      }
    } catch (e) {
      logger.warn(e, 'startup: pending tx cleanup failed')
    }
    try { await queue.prewarmNonce(signer) } catch (_) {}
    try {
      const addr = await signer.getAddress()
      const weth = (runtime?.trading?.weth) || process.env.WETH || '0x4200000000000000000000000000000000000006'
      configureEthBalancePoller({ provider, address: addr, io, intervalMs: 30000, weth, signer, queue })
    } catch (_) {}
  }
  if (String(process.env.DISABLE_WATCHER || '').toLowerCase() !== 'true') {
    // Prefer WebSocket-based log subscription for real-time, low-latency events
    await startLogSubscriber({ httpProvider: provider, redis, io, runtime })
  } else {
    logger.info('log watcher disabled via DISABLE_WATCHER=true')
  }

  // Start periodic cleanup of old failed detections (runs every hour)
  startDetectionCleanup(redis)

  const port = process.env.PORT || 4000
  server.listen(port, () => logger.info(`server listening on :${port}`))
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
