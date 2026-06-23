/**
 * Genera public/icon-192.png y public/icon-512.png para PWA.
 * Sin dependencias externas — solo Node.js built-ins.
 *   node scripts/gen-icons.js
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC    = join(__dirname, '..', 'public')

// ── PNG encoder (RGBA, sin filtrado) ──────────────────────────────────────────

function crc32(buf) {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t   = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePNG(w, h, rgba) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6  // bit depth = 8, color type = RGBA

  const stride = 1 + w * 4
  const raw    = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0  // filter byte: None
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4
      const dst = y * stride + 1 + x * 4
      raw[dst]   = rgba[src]
      raw[dst+1] = rgba[src+1]
      raw[dst+2] = rgba[src+2]
      raw[dst+3] = rgba[src+3]
    }
  }

  const idat = deflateSync(Buffer.from(raw))
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Drawing helpers ───────────────────────────────────────────────────────────

function setPixel(buf, w, x, y, r, g, b, a = 255) {
  x = Math.round(x); y = Math.round(y)
  if (x < 0 || y < 0 || x >= w || y >= w) return
  const i  = (y * w + x) * 4
  const fa = a / 255
  buf[i]   = Math.round(buf[i]   * (1 - fa) + r * fa)
  buf[i+1] = Math.round(buf[i+1] * (1 - fa) + g * fa)
  buf[i+2] = Math.round(buf[i+2] * (1 - fa) + b * fa)
  buf[i+3] = Math.min(255, buf[i+3] + a)
}

function fillRoundedRect(buf, size, x0, y0, rw, rh, radius, [cr, cg, cb]) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + rh); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + rw); x++) {
      const dx = Math.min(x - x0, x0 + rw - 1 - x)
      const dy = Math.min(y - y0, y0 + rh - 1 - y)
      if (dx < radius && dy < radius) {
        if (Math.sqrt((radius - dx - 0.5) ** 2 + (radius - dy - 0.5) ** 2) > radius) continue
      }
      setPixel(buf, size, x, y, cr, cg, cb)
    }
  }
}

// Scan-line fill para polígono arbitrario (convexo o cóncavo)
function fillPolygon(buf, size, pts, [r, g, b]) {
  let minY = Infinity, maxY = -Infinity
  for (const [, py] of pts) { minY = Math.min(minY, py); maxY = Math.max(maxY, py) }

  const n = pts.length
  for (let y = Math.ceil(minY); y <= Math.floor(maxY); y++) {
    const xs = []
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i]
      const [x2, y2] = pts[(i + 1) % n]
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) {
        xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.ceil(xs[i]); x <= Math.floor(xs[i+1]); x++) {
        setPixel(buf, size, x, y, r, g, b)
      }
    }
  }
}

// ── Diseño del icono ──────────────────────────────────────────────────────────

const BG      = [0x0d, 0x11, 0x17]  // #0d1117
const SURFACE = [0x16, 0x1b, 0x22]  // #161b22
const ACCENT  = [0x7c, 0x3a, 0xed]  // #7c3aed

function makeIcon(size) {
  const buf = new Uint8Array(size * size * 4)

  // Fondo
  for (let i = 0; i < size * size; i++) {
    buf[i*4] = BG[0]; buf[i*4+1] = BG[1]; buf[i*4+2] = BG[2]; buf[i*4+3] = 0xff
  }

  // Tarjeta redondeada
  const pad    = size * 0.06
  const radius = size * 0.20
  fillRoundedRect(buf, size, pad, pad, size - pad*2, size - pad*2, radius, SURFACE)

  // Rayo (bolt) — polígono de 7 vértices normalizados 0..1
  // Sección superior: de (0.28,0.04) a (0.65,0.04) → (0.65,0.48) → (0.35,0.48)
  // Sección inferior: de (0.12,0.50) a (0.88,0.50) → (0.45,0.96)
  const norm = [
    [0.65, 0.04],  // P1 esquina sup-derecha
    [0.28, 0.04],  // P2 esquina sup-izquierda
    [0.35, 0.50],  // P3 codo izquierdo
    [0.12, 0.50],  // P4 punta izquierda del kink
    [0.45, 0.96],  // P5 punta inferior
    [0.88, 0.50],  // P6 punta derecha del kink
    [0.65, 0.50],  // P7 codo derecho
  ]

  const inner = size * 0.15
  const span  = size - inner * 2
  const pts   = norm.map(([nx, ny]) => [inner + nx * span, inner + ny * span])

  fillPolygon(buf, size, pts, ACCENT)

  return buf
}

// ── Genera y guarda ───────────────────────────────────────────────────────────

mkdirSync(PUBLIC, { recursive: true })

for (const size of [192, 512]) {
  const rgba = makeIcon(size)
  const png  = encodePNG(size, size, rgba)
  const out  = join(PUBLIC, `icon-${size}.png`)
  writeFileSync(out, png)
  console.log(`✓  icon-${size}.png  (${(png.length / 1024).toFixed(1)} KB)`)
}
