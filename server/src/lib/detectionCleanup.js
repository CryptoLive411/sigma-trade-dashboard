const { logger } = require('./logger')

/**
 * Starts a periodic cleanup task that removes failed detections older than 1 hour
 * from the detections:events Redis list. Successful detections (pass: true) are kept.
 * 
 * @param {Object} redis - Redis client instance
 * @param {number} intervalMs - Cleanup interval in milliseconds (default: 1 hour)
 * @param {number} maxAgeMs - Max age for failed detections in milliseconds (default: 1 hour)
 */
function startDetectionCleanup(redis, intervalMs = 60 * 60 * 1000, maxAgeMs = 60 * 60 * 1000) {
  if (!redis) {
    logger.warn('Detection cleanup: Redis not available, skipping')
    return
  }

  const cleanupTask = async () => {
    try {
      const key = 'detections:events'
      const now = Date.now()
      const cutoff = now - maxAgeMs

      // Get all detections from Redis
      const arr = await redis.lrange(key, 0, -1)
      if (!arr || arr.length === 0) return

      // Parse and filter detections
      const parsed = arr
        .map((s) => {
          try {
            return JSON.parse(s)
          } catch (_) {
            return null
          }
        })
        .filter(Boolean)

      // Keep only:
      // 1. Successful detections (pass: true) - regardless of age
      // 2. Failed detections (pass: false) that are less than 1 hour old
      const filtered = parsed.filter((det) => {
        if (det.pass === true) return true // Keep all successful detections
        if (det.pass === false && det.ts && det.ts > cutoff) return true // Keep recent failures
        return false // Remove old failures
      })

      const removedCount = parsed.length - filtered.length

      if (removedCount > 0) {
        // Replace the entire list with filtered items
        // Use a transaction to ensure atomicity
        const multi = redis.multi()
        multi.del(key)
        if (filtered.length > 0) {
          // lpush in reverse order to maintain chronological order (newest first)
          for (let i = filtered.length - 1; i >= 0; i--) {
            multi.lpush(key, JSON.stringify(filtered[i]))
          }
        }
        await multi.exec()

        logger.info(
          {
            removedCount,
            remainingCount: filtered.length,
            cutoffAge: `${Math.floor(maxAgeMs / 1000 / 60)}m`,
          },
          'Detection cleanup: removed old failed detections'
        )
      } else {
        logger.debug('Detection cleanup: no old failed detections to remove')
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Detection cleanup error')
    }
  }

  // Run cleanup immediately on startup
  cleanupTask()

  // Schedule periodic cleanup
  const intervalId = setInterval(cleanupTask, intervalMs)
  logger.info(
    { intervalMs, maxAgeMs },
    'Detection cleanup: started periodic cleanup task'
  )

  // Return cleanup function for graceful shutdown
  return () => {
    clearInterval(intervalId)
    logger.info('Detection cleanup: stopped')
  }
}

module.exports = { startDetectionCleanup }
