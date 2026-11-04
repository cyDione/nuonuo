// Draws the tray icon (the app's ring logo) as a PNG at runtime, so the repository carries no binary assets.
const { deflateSync } = require('node:zlib')

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A ring with a dot; `badge` adds an orange dot for "something needs you". Color is black for macOS template images. */
function iconPng(size = 32, { color = [79, 70, 229], badge = false } = {}) {
  const rows = []
  const c = (size - 1) / 2, outer = size * 0.46, inner = size * 0.3, dot = size * 0.14
  for (let y = 0; y < size; y++) {
    const row = [0]
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = d <= outer && d >= inner
      const center = d <= dot
      const b = badge && Math.hypot(x - size * 0.8, y - size * 0.2) <= size * 0.17
      const alpha = ring || center || b ? 255 : 0
      const [r, g, bl] = b ? [234, 88, 12] : color
      row.push(r, g, bl, alpha)
    }
    rows.push(Buffer.from(row))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}

module.exports = { iconPng }
