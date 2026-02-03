const { logger } = require('./logger')

const REDIS_KEY = 'creator:stats' // Hash: creator address -> token count

/**
 * Increment the token creation count for a creator
 * @param {Object} redis - Redis client
 * @param {string} creator - Creator address (lowercase)
 */
async function incrementCreatorTokens(redis, creator) {
  if (!redis || !creator) return
  
  try {
    const addr = creator.toLowerCase()
    await redis.hincrby(REDIS_KEY, addr, 1)
    //logger.debug({ creator: addr }, 'Incremented creator token count')
  } catch (err) {
    logger.error({ err: err.message, creator }, 'Failed to increment creator token count')
  }
}

/**
 * Get the token creation count for a specific creator
 * @param {Object} redis - Redis client
 * @param {string} creator - Creator address
 * @returns {Promise<number>} Token count
 */
async function getCreatorTokenCount(redis, creator) {
  if (!redis || !creator) return 0
  
  try {
    const addr = creator.toLowerCase()
    const count = await redis.hget(REDIS_KEY, addr)
    return count ? parseInt(count, 10) : 0
  } catch (err) {
    logger.error({ err: err.message, creator }, 'Failed to get creator token count')
    return 0
  }
}

/**
 * Get token counts for multiple creators (batch operation)
 * @param {Object} redis - Redis client
 * @param {string[]} creators - Array of creator addresses
 * @returns {Promise<Object>} Map of creator address -> token count
 */
async function getCreatorTokenCounts(redis, creators) {
  if (!redis || !creators || !creators.length) return {}
  
  try {
    const addrs = creators.map(c => c.toLowerCase())
    const pipeline = redis.pipeline()
    
    addrs.forEach(addr => {
      pipeline.hget(REDIS_KEY, addr)
    })
    
    const results = await pipeline.exec()
    const counts = {}
    
    addrs.forEach((addr, idx) => {
      const result = results[idx]
      // pipeline.exec returns [[err, value], ...]
      const count = result && result[1] ? parseInt(result[1], 10) : 0
      counts[addr] = count
    })
    
    return counts
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get creator token counts')
    return {}
  }
}

/**
 * Get all creators sorted by token count (top creators)
 * @param {Object} redis - Redis client
 * @param {number} limit - Maximum number of results to return
 * @returns {Promise<Array>} Array of {creator, count} objects
 */
async function getTopCreators(redis, limit = 100) {
  if (!redis) return []
  
  try {
    const all = await redis.hgetall(REDIS_KEY)
    if (!all) return []
    
    const creators = Object.entries(all)
      .map(([creator, count]) => ({
        creator,
        count: parseInt(count, 10)
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
    
    return creators
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get top creators')
    return []
  }
}

/**
 * Get total number of unique creators
 * @param {Object} redis - Redis client
 * @returns {Promise<number>} Total creator count
 */
async function getTotalCreatorCount(redis) {
  if (!redis) return 0
  
  try {
    const count = await redis.hlen(REDIS_KEY)
    return count || 0
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to get total creator count')
    return 0
  }
}

module.exports = {
  incrementCreatorTokens,
  getCreatorTokenCount,
  getCreatorTokenCounts,
  getTopCreators,
  getTotalCreatorCount
}
