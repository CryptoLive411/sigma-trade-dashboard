const { ethers } = require('ethers')
const { logger } = require('./logger')

/**
 * Clear pending transactions for the given signer by replacing each pending nonce
 * with a zero-value self-transfer at a bumped gas price. Intended to run once on startup
 * before we initialize nonce state in the tx queue.
 *
 * Strategy:
 * - Compare latest vs pending nonce. If pending > latest, there are (pending-latest) slots stuck.
 * - For each nonce in [latest, pending-1], broadcast a type-2 (EIP-1559) self-transfer with
 *   aggressive but bounded fees to outbid the stale tx, retrying with incremental bumps on underpriced errors.
 * - Optionally wait briefly for the gap to close, up to a small timeout.
 */
async function cleanupPendingTxs({ provider, signer, maxAttempts = 3, waitMs = 15000, waitBetweenMs = 2500, maxRounds = 6 }) {
  if (!signer || !provider) return { ok: false, reason: 'no-signer' }
  const address = await signer.getAddress()

  // Fee config (with env overrides). Defaults chosen for Base low-fee chain.
  const bumpMult = Number(process.env.CLEANUP_BUMP_MULTIPLIER || 1.25)
  const minPriorityGwei = Number(process.env.CLEANUP_MIN_PRIORITY_GWEI || 0.01) // 0.01 gwei tip minimum
  const softMaxGwei = Number(process.env.CLEANUP_MAX_FEE_GWEI || 0.2) // soft cap; still ensure fee >= priority

  const toWei = (g) => ethers.utils.parseUnits(String(g), 'gwei')

  // Build a replacement tx for a given nonce and attempt index
  const buildReplacementTx = async (nonce, attemptIdx) => {
    const fee = await provider.getFeeData().catch(() => ({}))
    // Fallbacks: if provider returns nulls, pick tiny defaults that are safe on Base
    let maxPriority = fee.maxPriorityFeePerGas || toWei(minPriorityGwei)
    let maxFee = fee.maxFeePerGas || toWei(Math.max(minPriorityGwei * 2, 0.02))

    // Apply bump for retries
    const bump = Math.pow(bumpMult, attemptIdx)
    maxPriority = ethers.BigNumber.from(maxPriority).mul(Math.floor(bump * 100)).div(100)
    maxFee = ethers.BigNumber.from(maxFee).mul(Math.floor(bump * 100)).div(100)

    // Respect soft cap but keep maxFee >= maxPriority
    const cap = toWei(softMaxGwei)
    if (maxFee.gt(cap)) maxFee = cap
    if (maxPriority.gt(maxFee)) maxPriority = maxFee

    // Ensure we never go below minimum priority
    const minPrioWei = toWei(minPriorityGwei)
    if (maxPriority.lt(minPrioWei)) {
      maxPriority = minPrioWei
      if (maxFee.lt(maxPriority)) maxFee = maxPriority
    }

    return {
      to: address,
      value: ethers.constants.Zero,
      nonce,
      type: 2,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxPriority,
      gasLimit: ethers.BigNumber.from(21000),
    }
  }

  const results = []

  let rounds = 0
  let totalCleared = 0
  while (rounds < maxRounds) {
    rounds += 1
    // Figure out nonce gap for this round
    let latest
    let pending
    try {
      latest = await provider.getTransactionCount(address, 'latest')
      pending = await provider.getTransactionCount(address, 'pending')
    } catch (e) {
      logger.warn(e, 'pending cleanup: failed to fetch nonces')
      return { ok: false, reason: 'nonce-fetch-failed', rounds: rounds - 1, replacements: results }
    }

    const gap = Math.max(0, pending - latest)
    if (gap === 0) {
      logger.info({ address, latest, pending, rounds }, 'pending cleanup: nothing to do')
      break
    }

    logger.warn({ address, latest, pending, gap, round: rounds }, 'pending cleanup: replacing stuck transactions via self-transfer')

    for (let n = latest; n <= pending - 1; n++) {
      let sent = false
      let lastError = null
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const txReq = await buildReplacementTx(n, attempt)
          const tx = await signer.sendTransaction(txReq)
          logger.warn({ address, nonce: n, hash: tx.hash, round: rounds, attempt }, 'pending cleanup: replacement sent')
          results.push({ nonce: n, hash: tx.hash })
          sent = true
          break
        } catch (e) {
          lastError = e
          const msg = (e && (e.message || e.reason || '')).toLowerCase()
          // Handle common conditions: underpriced, already known, nonce too low (mined during loop)
          if (msg.includes('already known') || msg.includes('nonce too low') || e.code === 'NONCE_EXPIRED') {
            logger.info({ nonce: n, round: rounds }, 'pending cleanup: nonce no longer needs replacement')
            sent = true
            break
          }
          if (msg.includes('underpriced') || msg.includes('fee too low') || msg.includes('replacement')) {
            // bump and retry
            continue
          }
          if (msg.includes('insufficient funds')) {
            logger.error(e, 'pending cleanup: insufficient funds to replace')
            // No point continuing further nonces
            return { ok: false, cleared: totalCleared + results.length, reason: 'insufficient-funds', rounds, replacements: results }
          }
          // Unknown error: try next attempt with bump, else log and continue to next nonce
        }
      }
      if (!sent) {
        logger.error({ nonce: n, error: lastError && lastError.message, round: rounds }, 'pending cleanup: failed to replace pending tx')
      }
    }

    // After sending replacements for current visible gap, briefly wait for inclusion and for additional hidden pending nonces to show up
    const start = Date.now()
    try {
      while (Date.now() - start < waitMs) {
        const l = await provider.getTransactionCount(address, 'latest')
        const p = await provider.getTransactionCount(address, 'pending')
        if (p <= l) break
        await sleep(1000)
      }
    } catch (_) {}

    const latestAfter = await provider.getTransactionCount(address, 'latest').catch(()=>null)
    const pendingAfter = await provider.getTransactionCount(address, 'pending').catch(()=>null)
    const remaining = (latestAfter != null && pendingAfter != null) ? Math.max(0, pendingAfter - latestAfter) : 0
    const clearedThisRound = gap - remaining
    totalCleared += Math.max(0, clearedThisRound)

    // If there are still pending after this round, wait a bit and loop again to catch sequentially revealed pending txs
    if (remaining > 0) {
      await sleep(waitBetweenMs)
      continue
    }
    // All clear
    break
  }

  // Final status
  let latestFinal = null, pendingFinal = null
  try { latestFinal = await provider.getTransactionCount(address, 'latest') } catch (_) {}
  try { pendingFinal = await provider.getTransactionCount(address, 'pending') } catch (_) {}
  const remainingFinal = (latestFinal != null && pendingFinal != null) ? Math.max(0, pendingFinal - latestFinal) : 0
  logger.info({ address, rounds, latestFinal, pendingFinal, remaining: remainingFinal }, 'pending cleanup: completed')
  return { ok: true, cleared: totalCleared, remaining: remainingFinal, rounds, replacements: results }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

module.exports = { cleanupPendingTxs }
