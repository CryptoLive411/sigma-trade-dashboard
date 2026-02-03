const fs = require('fs')
const path = require('path')
const { logger } = require('./logger')

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data')

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
}

function filePath(name) {
  ensureDir()
  return path.join(dataDir, `${name}.json`)
}

function read(name, fallback = {}) {
  try {
    const fp = filePath(name)
    if (!fs.existsSync(fp)) return fallback
    const buf = fs.readFileSync(fp, 'utf8')
    return JSON.parse(buf)
  } catch (e) {
    logger.error(e, `db read error: ${name}`)
    return fallback
  }
}

function write(name, obj) {
  try {
    const fp = filePath(name)
    fs.writeFileSync(fp, JSON.stringify(obj, null, 2))
  } catch (e) {
    logger.error(e, `db write error: ${name}`)
  }
}

module.exports = { read, write }
