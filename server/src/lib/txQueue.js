const { ethers } = require('ethers')
const { logger } = require('./logger')

class OutgoingTxQueue {
  constructor(redis, io) {
    this.redis = redis
    this.io = io
    this.queues = new Map() // address => Promise chain
    this.nonces = new Map() // address => { next: number, initialized: boolean }
  }

  async _ensureNonce(provider, address) {
    let entry = this.nonces.get(address)
    if (!entry || !entry.initialized) {
      const next = await provider.getTransactionCount(address, 'pending')
      entry = { next, initialized: true }
      this.nonces.set(address, entry)
    }
    return entry
  }

  async _consumeNonce(provider, address) {
    const entry = await this._ensureNonce(provider, address)
    const n = entry.next
    entry.next += 1
    return n
  }

  async enqueue({ signer, buildTx, label, trade, action, waitForConfirm = false, priority = false, resolveOnSent = false }) {
    const address = await signer.getAddress()
    // Priority transactions skip the queue and start immediately
    const current = priority ? Promise.resolve() : (this.queues.get(address) || Promise.resolve())
    // We previously awaited tx confirmations inside the queue chain.
    // This blocked later transactions (same address) from broadcasting until earlier ones were mined.
    // New behavior: the chain only waits for the broadcast (nonce reservation + sendTransaction).
    // Confirmation (tx.wait) happens in a detached async task; the returned promise still resolves to the receipt
    // so callers awaiting enqueue() retain old semantics, but other enqueued txs aren't delayed by mining time.
  let externalResolve, externalReject
  let settled = false
  const resolveOnce = (v) => { if (!settled) { settled = true; externalResolve(v) } }
  const rejectOnce = (e) => { if (!settled) { settled = true; externalReject(e) } }
  const receiptPromise = new Promise((res, rej) => { externalResolve = res; externalReject = rej })

    const broadcastStep = current.then(async () => {
      const provider = signer.provider
      // Reserve nonce sequentially
      let nonce = await this._consumeNonce(provider, address)
      let txRequest = await buildTx({ nonce })
      if (txRequest.nonce == null) txRequest.nonce = nonce
      if (!txRequest.gasLimit) txRequest.gasLimit = ethers.BigNumber.from(process.env.GAS_LIMIT || '1000000')

      const applyGasCap = async () => {
        try {
          if (this.redis) {
            const runtimeRaw = await this.redis.get('runtime')
            if (runtimeRaw) {
              const runtime = JSON.parse(runtimeRaw)
              const capGwei = runtime?.trading?.gasPriceGweiMax
              if (capGwei != null) {
                const capWei = ethers.utils.parseUnits(String(capGwei), 'gwei')
                // Priority fee target = 10% of cap
                const priorityWei = capWei.div(10)
                // Cap maxFeePerGas at cap
                if (!txRequest.maxFeePerGas || ethers.BigNumber.from(txRequest.maxFeePerGas).gt(capWei)) {
                  txRequest.maxFeePerGas = capWei
                }
                // Cap maxPriorityFeePerGas at 10% of cap (small priority)
                if (!txRequest.maxPriorityFeePerGas || ethers.BigNumber.from(txRequest.maxPriorityFeePerGas).gt(priorityWei)) {
                  txRequest.maxPriorityFeePerGas = priorityWei
                }
                // Ensure EIP-1559 consistency: maxFeePerGas >= maxPriorityFeePerGas
                if (txRequest.maxFeePerGas && txRequest.maxPriorityFeePerGas) {
                  const mf = ethers.BigNumber.from(txRequest.maxFeePerGas)
                  const mp = ethers.BigNumber.from(txRequest.maxPriorityFeePerGas)
                  if (mf.lt(mp)) txRequest.maxFeePerGas = mp
                }
                if (txRequest.gasPrice && ethers.BigNumber.from(txRequest.gasPrice).gt(capWei)) {
                  txRequest.gasPrice = capWei
                }
              }
            }
          }
        } catch (_) {}
      }
      await applyGasCap()

      const sendWithRetry = async () => {
        const MAX_ATTEMPTS = Number(process.env.TX_MAX_RETRIES || 5)
        const BASE_DELAY_MS = Number(process.env.TX_RETRY_BASE_MS || 500)
        const JITTER_MS = 200
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

        const isTransientRpcError = (err) => {
          try {
            const code = err && (err.code || err.error?.code)
            const msg = ((err && (err.message || err.reason || err.error?.message)) || '').toLowerCase()
            // Common transient indicators
            if (
              code === 'NETWORK_ERROR' ||
              code === 'SERVER_ERROR' ||
              code === 'ECONNRESET' ||
              code === 'ETIMEDOUT' ||
              code === 'ETIMEOUT' ||
              code === 'EHOSTUNREACH' ||
              code === 'ENETUNREACH'
            ) return true
            if (
              msg.includes('could not detect network') ||
              msg.includes('network not found') ||
              msg.includes('network unavailable') ||
              msg.includes('missing response') ||
              msg.includes('failed to meet quorum') ||
              msg.includes('timeout') ||
              msg.includes('timed out') ||
              msg.includes('socket hang up') ||
              msg.includes('connect') ||
              msg.includes('502') || msg.includes('503') || msg.includes('504')
            ) return true
          } catch (_) {}
          return false
        }

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            // Lightweight connectivity probe on retries
            if (attempt > 1) {
              try { await provider.getBlockNumber() } catch (_) {}
            }
            const tx = await signer.sendTransaction(txRequest)
            this.io.emit('tx:sent', { address, hash: tx.hash, label })
            appendTxLog({ phase: 'sent', label, address, hash: tx.hash, request: txRequest })
            try { if (trade) { const { appendTradeTx } = require('./trades'); await appendTradeTx(this.redis, trade, { phase: 'sent', label, address, hash: tx.hash, action }) } } catch (_) {}
            // Confirmation handling
            if (resolveOnSent) {
              resolveOnce({ transactionHash: tx.hash })
            }
            if (waitForConfirm) {
              const receipt = await tx.wait()
              this.io.emit('tx:confirmed', { address, hash: tx.hash, status: receipt.status, label })
              appendTxLog({ phase: 'confirmed', label, address, hash: tx.hash, status: receipt.status, receipt })
              try { if (trade) { const { appendTradeTx } = require('./trades'); await appendTradeTx(this.redis, trade, { phase: 'confirmed', label, address, hash: tx.hash, status: receipt.status, action, receipt }) } } catch (_) {}
              resolveOnce(receipt)
            } else {
              tx.wait().then(async (receipt) => {
                this.io.emit('tx:confirmed', { address, hash: tx.hash, status: receipt.status, label })
                appendTxLog({ phase: 'confirmed', label, address, hash: tx.hash, status: receipt.status, receipt })
                try { if (trade) { const { appendTradeTx } = require('./trades'); await appendTradeTx(this.redis, trade, { phase: 'confirmed', label, address, hash: tx.hash, status: receipt.status, action, receipt }) } } catch (_) {}
                resolveOnce(receipt)
              }).catch(async (e) => {
                logger.error(e, 'tx confirm failed')
                this.io.emit('tx:error', { address, error: e.message, label })
                appendTxLog({ phase: 'error', label, address, error: e.message })
                try { if (trade) { const { appendTradeTx } = require('./trades'); const { appendTradeTx: appendTradeTx2 } = require('./trades'); await appendTradeTx2(this.redis, trade, { phase: 'error', label, address, error: e.message, action }) } } catch (_) {}
                rejectOnce(e)
              })
            }
            return // success path exits function
          } catch (e) {
            const msg = (e && (e.message || e.reason || '')) + ''
            const lower = msg.toLowerCase()
            const isNonceLow = lower.includes('nonce too low') || lower.includes('nonce has already been used') || (e.code === 'NONCE_EXPIRED')

            if (isNonceLow) {
              // Resync nonce and retry immediately (counts as same attempt)
              try {
                const fresh = await provider.getTransactionCount(address, 'pending')
                this.nonces.set(address, { next: fresh + 1, initialized: true })
                txRequest = await buildTx({ nonce: fresh })
                if (txRequest.nonce == null) txRequest.nonce = fresh
                if (!txRequest.gasLimit) txRequest.gasLimit = ethers.BigNumber.from(process.env.GAS_LIMIT || '1000000')
                await applyGasCap()
                // Decrement attempt to not count nonce resync as a backoff attempt
                attempt -= 1
                continue
              } catch (e2) {
                logger.error(e2, 'tx failed broadcast (nonce resync)')
                this.io.emit('tx:error', { address, error: e2.message, label })
                appendTxLog({ phase: 'error', label, address, error: e2.message })
                try { if (trade) { const { appendTradeTx } = require('./trades'); await appendTradeTx(this.redis, trade, { phase: 'error', label, address, error: e2.message, action }) } } catch (_) {}
                rejectOnce(e2)
                return
              }
            }

            if (isTransientRpcError(e) && attempt < MAX_ATTEMPTS) {
              const delay = Math.min(10000, BASE_DELAY_MS * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * JITTER_MS)
              logger.warn({ attempt, delay, label, address, error: e.message }, 'tx broadcast transient RPC error; retrying')
              appendTxLog({ phase: 'retry', label, address, error: e.message, attempt, delay })
              // brief provider ping to encourage reconnection on some providers
              try { await provider.getNetwork() } catch (_) {}
              await sleep(delay)
              continue
            }

            // Non-transient or exhausted retries
            logger.error(e, attempt >= MAX_ATTEMPTS ? 'tx failed broadcast (exhausted retries)' : 'tx failed broadcast')
            this.io.emit('tx:error', { address, error: e.message, label })
            appendTxLog({ phase: 'error', label, address, error: e.message })
            try { if (trade) { const { appendTradeTx } = require('./trades'); await appendTradeTx(this.redis, trade, { phase: 'error', label, address, error: e.message, action }) } } catch (_) {}
            rejectOnce(e)
            return
          }
        }
      }
      await sendWithRetry()
    }).catch((e) => {
      // Broadcast-level failure already propagated via externalReject
      // noop
    })

    this.queues.set(address, broadcastStep.catch(() => {}))
    return receiptPromise
  }

  async prewarmNonce(signer) {
    try {
      const address = await signer.getAddress()
      const provider = signer.provider
      await this._ensureNonce(provider, address)
      return this.nonces.get(address)?.next
    } catch (_) {
      return null
    }
  }
}

function appendTxLog(entry) {
  try {
    // Redis list keeps entries; a background trim happens via LTRIM to last 500
    const payload = JSON.stringify({ time: Date.now(), ...entry })
    const { initRedis } = require('./redis')
    initRedis().then((r) => {
      r.rpush('txlog', payload).then(() => r.ltrim('txlog', -500, -1)).catch(()=>{})
    }).catch(()=>{})
  } catch (_) {}
}

module.exports = { OutgoingTxQueue }
