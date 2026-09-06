import { randomInt } from 'node:crypto'
import { deflateSync } from 'node:zlib'

// A tiny, dependency-free OCR fixture. The expected digits are never put in the prompt.
const glyphs = [
  ['11111','10001','10001','10001','10001','10001','11111'],
  ['00100','01100','00100','00100','00100','00100','01110'],
  ['11111','00001','00001','11111','10000','10000','11111'],
  ['11111','00001','00001','11111','00001','00001','11111'],
  ['10001','10001','10001','11111','00001','00001','00001'],
  ['11111','10000','10000','11111','00001','00001','11111'],
  ['11111','10000','10000','11111','10001','10001','11111'],
  ['11111','00001','00010','00100','01000','01000','01000'],
  ['11111','10001','10001','11111','10001','10001','11111'],
  ['11111','10001','10001','11111','00001','00001','11111'],
]
function chunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type)
  const body = Buffer.concat([typeBytes, payload])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, body, checksum])
}
export function createVisionFixture(digits = String(randomInt(1000, 10000))): { expected: string; dataUrl: string } {
  if (!/^\d{4}$/.test(digits)) throw new Error('The vision fixture requires four digits.')
  const width = 256, height = 96, scale = 8
  const rows = Buffer.alloc(height * (1 + width * 3), 255)
  for (let y = 0; y < height; y++) {
    rows[y * (1 + width * 3)] = 0
    for (let n = 0; n < digits.length; n++) {
      const glyph = glyphs[Number(digits[n])]
      const gy = Math.floor((y - 20) / scale)
      if (gy < 0 || gy >= 7) continue
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue
        for (let dx = 0; dx < scale; dx++) {
          const x = 16 + n * 60 + gx * scale + dx
          const offset = y * (1 + width * 3) + 1 + x * 3
          rows.fill(0, offset, offset + 3)
        }
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
  return { expected: digits, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}
