const { ethers } = require('ethers')

// Event signature for ERC20 Transfer(address,address,uint256)
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)')

// Default known token addresses on Base (lowercased)
const DEFAULT_KNOWN_TOKENS = new Set([
  // WETH
  '0x4200000000000000000000000000000000000006',
  // Native USDC (Base)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  // USDbC (bridged USDC on Base)
  '0xd9aaec86b65d86f6a7b5b1b0c42a4e4b5ea3e93d',
])

function getKnownTokenSet(runtime) {
  const set = new Set(DEFAULT_KNOWN_TOKENS)
  try {
    const weth = runtime?.trading?.weth
    if (weth) set.add(String(weth).toLowerCase())
  } catch (_) {}
  try {
    const extra = runtime?.knownTokens
    if (Array.isArray(extra)) for (const a of extra) set.add(String(a).toLowerCase())
  } catch (_) {}
  return set
}

function extractTokenTransfers(receipt) {
  const logs = receipt?.logs || []
  const counts = new Map() // address -> occurrences
  for (const lg of logs) {
    try {
      if (!lg || !lg.topics || !lg.topics.length) continue
      if (String(lg.topics[0]).toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue
      const addr = String(lg.address || '').toLowerCase()
      if (!addr) continue
      counts.set(addr, (counts.get(addr) || 0) + 1)
    } catch (_) {}
  }
  const list = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).map(([a])=>a)
  return { list, counts }
}

function filterKnownTokens(addresses, knownSet) {
  const set = knownSet || DEFAULT_KNOWN_TOKENS
  return (addresses || []).filter((a) => !set.has(String(a).toLowerCase()))
}

function pickPrimaryToken(addresses, counts) {
  if (!addresses || !addresses.length) return null
  if (counts) {
    let best = addresses[0]
    let bestC = counts.get(best) || 0
    for (const a of addresses) {
      const c = counts.get(a) || 0
      if (c > bestC) { best = a; bestC = c }
    }
    return best
  }
  return addresses[0]
}

function buildDexscreenerLink(chain, tokenAddress) {
  if (!tokenAddress) return null
  const c = (chain || 'base').toLowerCase()
  return `https://dexscreener.com/${c}/${tokenAddress}`
}

module.exports = {
  TRANSFER_TOPIC,
  getKnownTokenSet,
  extractTokenTransfers,
  filterKnownTokens,
  pickPrimaryToken,
  buildDexscreenerLink,
}
