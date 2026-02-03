module.exports = {
  UniswapV2: {
    FactoryPairCreated: { "anonymous": false, "inputs": [ { "indexed": true, "internalType": "address", "name": "token0", "type": "address" }, { "indexed": true, "internalType": "address", "name": "token1", "type": "address" }, { "indexed": false, "internalType": "address", "name": "pair", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "", "type": "uint256" } ], "name": "PairCreated", "type": "event" },
    Router: [ 'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)', 'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)', 'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)' ],
    ERC20: [ 'function balanceOf(address) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)', ]
  },
  UniswapV3: {
    FactoryPoolCreated: { "anonymous": false, "inputs": [ { "indexed": true, "internalType": "address", "name": "token0", "type": "address" }, { "indexed": true, "internalType": "address", "name": "token1", "type": "address" }, { "indexed": true, "internalType": "uint24", "name": "fee", "type": "uint24" }, { "indexed": false, "internalType": "int24", "name": "tickSpacing", "type": "int24" }, { "indexed": false, "internalType": "address", "name": "pool", "type": "address" } ], "name": "PoolCreated", "type": "event" },
    Router: [ 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)' ],
    // Minimal pool ABI for monitoring state
    Pool: [
      'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
      'function liquidity() view returns (uint128)',
      'function token0() view returns (address)',
      'function token1() view returns (address)'
    ],
    ERC20: [ 'function balanceOf(address) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)' ],
    WETH: [ 'function deposit() payable', 'function withdraw(uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)' ]
  },
  UniswapV4: {
    PoolManagerInitialize: { "anonymous": false, "inputs": [ { "indexed": true, "internalType": "PoolId", "name": "id", "type": "bytes32" }, { "indexed": true, "internalType": "Currency", "name": "currency0", "type": "address" }, { "indexed": true, "internalType": "Currency", "name": "currency1", "type": "address" }, { "indexed": false, "internalType": "uint24", "name": "fee", "type": "uint24" }, { "indexed": false, "internalType": "int24", "name": "tickSpacing", "type": "int24" }, { "indexed": false, "internalType": "contract IHooks", "name": "hooks", "type": "address" }, { "indexed": false, "internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160" }, { "indexed": false, "internalType": "int24", "name": "tick", "type": "int24" } ], "name": "Initialize", "type": "event" },
    UniversalRouter: [ { inputs: [ { internalType: 'bytes', name: 'commands', type: 'bytes' }, { internalType: 'bytes[]', name: 'inputs', type: 'bytes[]' }, { internalType: 'uint256', name: 'deadline', type: 'uint256' } ], name: 'execute', outputs: [], stateMutability: 'payable', type: 'function' } ],
    Quoter: [ { "inputs": [ { "components": [ { "components": [ { "internalType": "Currency", "name": "currency0", "type": "address" }, { "internalType": "Currency", "name": "currency1", "type": "address" }, { "internalType": "uint24", "name": "fee", "type": "uint24" }, { "internalType": "int24", "name": "tickSpacing", "type": "int24" }, { "internalType": "contract IHooks", "name": "hooks", "type": "address" } ], "internalType": "struct PoolKey", "name": "poolKey", "type": "tuple" }, { "internalType": "bool", "name": "zeroForOne", "type": "bool" }, { "internalType": "uint128", "name": "exactAmount", "type": "uint128" }, { "internalType": "bytes", "name": "hookData", "type": "bytes" } ], "internalType": "struct IV4Quoter.QuoteExactSingleParams", "name": "params", "type": "tuple" } ], "name": "quoteExactInputSingle", "outputs": [ { "internalType": "uint256", "name": "amountOut", "type": "uint256" }, { "internalType": "uint256", "name": "gasEstimate", "type": "uint256" } ], "stateMutability": "nonpayable", "type": "function" } ],
    ERC20: [ 'function balanceOf(address) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)' ]
  }
  ,Aerodrome: {
    // Aerodrome (Solidly-style) factory PairCreated event signature: PairCreated(address,address,bool,address,uint256)
    // Some deployments omit the bool stable flag from indexed topics; using a generic version here.
    FactoryPairCreated: { "anonymous": false, "inputs": [ { "indexed": true, "internalType": "address", "name": "token0", "type": "address" }, { "indexed": true, "internalType": "address", "name": "token1", "type": "address" }, { "indexed": false, "internalType": "bool", "name": "stable", "type": "bool" }, { "indexed": false, "internalType": "address", "name": "pair", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "", "type": "uint256" } ], "name": "PairCreated", "type": "event" },
    // Minimal router ABI (Solidly-style) uses swapExactETHForTokensSupportingFeeOnTransferTokens like V2 style sometimes; keep simple path-based quoting
    Router: [
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
      'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
      'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
    ],
    ERC20: [ 'function balanceOf(address) view returns (uint256)', 'function allowance(address owner,address spender) view returns (uint256)', 'function approve(address spender,uint256 amount) returns (bool)' ]
  }
}
