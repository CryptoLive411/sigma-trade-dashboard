const { ethers } = require('ethers')
const ABI = require('../trackers/abi')

let _provider = null
let _address = ''
let _timer = null
let _io = null
const _cache = { wei: ethers.BigNumber.from(0), at: 0 }
const _wethCache = { wei: ethers.BigNumber.from(0), at: 0 }
let _weth = ''
let _signer = null
let _queue = null
let _unwrapInFlight = false

function getEthBalanceWei() { return _cache.wei }
function getEthBalanceTs() { return _cache.at }

async function pollOnce() {
  try {
    if (!_provider || !_address) return
    const now = Date.now()
    // Native ETH balance
    const bal = await _provider.getBalance(_address)
    _cache.wei = bal
    _cache.at = now
    if (_io) { try { _io.emit('account:ethBalance', { address: _address, wei: bal.toString(), at: _cache.at }) } catch (_) {} }

    // WETH balance (if configured)
    if (_weth) {
      try {
        const wethC = new ethers.Contract(_weth, ABI.UniswapV3.WETH, _provider)
        const wbal = await wethC.balanceOf(_address)
        _wethCache.wei = wbal
        _wethCache.at = now
        if (_io) { try { _io.emit('account:wethBalance', { address: _address, token: _weth, wei: wbal.toString(), at: now }) } catch (_) {} }

        // Auto-unwrap logic: if WETH > 0.02, unwrap down to keep 0.01
        const THRESHOLD = ethers.utils.parseEther('0.02')
        const KEEP = ethers.utils.parseEther('0.01')
        if (_signer && _queue && !_unwrapInFlight && wbal.gt(THRESHOLD)) {
          const amount = wbal.sub(KEEP)
          if (amount.gt(0)) {
            try {
              const wethS = new ethers.Contract(_weth, ABI.UniswapV3.WETH, _signer)
              const buildTx = async () => ({ to: _weth, data: wethS.interface.encodeFunctionData('withdraw', [amount]) })
              _unwrapInFlight = true
              const p = _queue.enqueue({ signer: _signer, buildTx, label: 'auto-unwrap-weth', waitForConfirm: false })
              // Reset flag when mined or on error
              Promise.resolve(p).finally(() => { _unwrapInFlight = false }).catch(()=>{ _unwrapInFlight = false })
              if (_io) { try { _io.emit('account:wethUnwrapInitiated', { address: _address, token: _weth, amount: amount.toString() }) } catch (_) {} }
            } catch (_) {
              _unwrapInFlight = false
            }
          }
        }
      } catch (_) { /* ignore WETH poll errors */ }
    }
  } catch (_) {}
}

function configureEthBalancePoller({ provider, address, io, intervalMs = 30000, weth = '', signer = null, queue = null }) {
  _provider = provider || null
  _address = address || ''
  _io = io || null
  _weth = weth || ''
  _signer = signer || null
  _queue = queue || null
  if (_timer) { clearInterval(_timer); _timer = null }
  if (_provider && _address) {
    // Kick immediate fetch then interval
    pollOnce()
    _timer = setInterval(pollOnce, Math.max(5000, intervalMs))
  }
}

module.exports = { getEthBalanceWei, getEthBalanceTs, configureEthBalancePoller }
