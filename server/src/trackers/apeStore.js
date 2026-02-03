const { create: createV3 } = require('./uniswapV3')

function create(ctx) {
  const inst = createV3(ctx)
  inst.name = 'ApeStore'
  // enforce include address contains 0xb1900f41d78d330a2a35c6771b3a6088a1b51309
  inst.include = ['0xb1900f41d78d330a2a35c6771b3a6088a1b51309']
  return inst
}

module.exports = { create }
