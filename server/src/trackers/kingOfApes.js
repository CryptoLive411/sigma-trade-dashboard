const { create: createV3 } = require('./uniswapV3')

function create(ctx) {
  const inst = createV3(ctx)
  inst.name = 'KingOfApes'
  // enforce include address contains the KoA deployer/router marker
  inst.include = ['0xe6fedc87a1e2e3fa95e2e608ab571c70cd623b58']
  return inst
}

module.exports = { create }
