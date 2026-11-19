// Image maths for the package scanner (PackageScanner.jsx).
//
// Nothing in here touches the page or the camera: every function works on plain
// byte arrays, so it can be tested on its own. A gray image is
// { data: Uint8Array (one byte per pixel, row by row), w, h }.
//
// The steps, in the order the scanner runs them:
//   1. findPageQuad    find the four corners of the sheet of paper in the photo
//   2. warpToRect      straighten it into a flat, upright page
//   3. flattenPage     even out shadows and uneven light, make the paper white
//   4. sharpen         a little extra edge on the letters
//   5. sharpnessScore  is the result sharp enough to read? (blur check)
//   6. buildPdf        wrap the finished pages in a plain PDF

export const LETTER_RATIO = 11 / 8.5

// ---------------------------------------------------------------------------
// Basics

export function rgbaToGray(rgba, w, h) {
  const out = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 151 + rgba[j + 2] * 28) >> 8
  }
  return { data: out, w, h }
}

// Shrinks by averaging blocks. Returns the small image and the exact scale used.
export function downscaleGray(img, maxEdge) {
  const f = Math.max(1, Math.floor(Math.max(img.w, img.h) / maxEdge))
  if (f === 1) return { data: img.data, w: img.w, h: img.h, f: 1 }
  const nw = Math.floor(img.w / f), nh = Math.floor(img.h / f)
  const out = new Uint8Array(nw * nh)
  const area = f * f
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0
      for (let yy = 0; yy < f; yy++) {
        const row = (y * f + yy) * img.w + x * f
        for (let xx = 0; xx < f; xx++) s += img.data[row + xx]
      }
      out[y * nw + x] = (s / area + 0.5) | 0
    }
  }
  return { data: out, w: nw, h: nh, f }
}

// Box blur (separable, running sums). r = radius in pixels.
export function boxBlur(src, w, h, r) {
  if (r < 1) return Uint8Array.from(src)
  const tmp = new Float32Array(w * h)
  const out = new Uint8Array(w * h)
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = (sum / win + 0.5) | 0
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
    }
  }
  return out
}

function otsuThreshold(data) {
  const hist = new Array(256).fill(0)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const total = data.length
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]
  let sumB = 0, wB = 0, best = 0, thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = t }
  }
  return thr
}

// ---------------------------------------------------------------------------
// 1. Finding the page

// Biggest connected blob of "on" pixels (4-neighbour). Returns { count, left[], right[], top[], bottom[], bbox }.
function largestBlob(mask, w, h) {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let best = null
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0, count = 0
    stack[sp++] = start; seen[start] = 1
    let minX = w, maxX = 0, minY = h, maxY = 0
    const members = []
    while (sp) {
      const p = stack[--sp]
      count++
      members.push(p)
      const x = p % w, y = (p - x) / w
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1 }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1 }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w }
    }
    if (!best || count > best.count) best = { count, members, bbox: [minX, minY, maxX, maxY] }
  }
  return best
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p) }
  const upper = []
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p) }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

function polyArea(poly) {
  let a = 0
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1] }
  return Math.abs(a) / 2
}

// Corners of a hull as [topLeft, topRight, bottomRight, bottomLeft].
function hullCorners(hull) {
  let tl = hull[0], tr = hull[0], br = hull[0], bl = hull[0]
  for (const p of hull) {
    if (p[0] + p[1] < tl[0] + tl[1]) tl = p
    if (p[0] + p[1] > br[0] + br[1]) br = p
    if (p[0] - p[1] > tr[0] - tr[1]) tr = p
    if (p[0] - p[1] < bl[0] - bl[1]) bl = p
  }
  return [tl, tr, br, bl]
}

// Looks for the sheet of paper. Works on a small copy of the photo.
// Returns { quad: [[x,y] x4] in full-size pixels, found: boolean, why }.
// When it can't find a page it returns a quad just inside the frame and found:false,
// and the screen then asks the person to drag the corners.
export function findPageQuad(gray) {
  const small = downscaleGray(gray, 420)
  const W = small.w, H = small.h
  const soft = boxBlur(small.data, W, H, 2)
  const thr = otsuThreshold(soft)
  const frame = (inset) => {
    const m = inset * Math.min(gray.w, gray.h)
    return [[m, m], [gray.w - 1 - m, m], [gray.w - 1 - m, gray.h - 1 - m], [m, gray.h - 1 - m]]
  }
  let best = null
  for (const bright of [true, false]) {
    const mask = new Uint8Array(W * H)
    for (let i = 0; i < mask.length; i++) mask[i] = bright ? (soft[i] > thr ? 1 : 0) : (soft[i] <= thr ? 1 : 0)
    const blob = largestBlob(mask, W, H)
    if (!blob) continue
    // Left/right edge of every row and top/bottom of every column: enough to get the hull.
    const left = new Int32Array(H).fill(W), right = new Int32Array(H).fill(-1)
    const top = new Int32Array(W).fill(H), bottom = new Int32Array(W).fill(-1)
    for (const p of blob.members) {
      const x = p % W, y = (p - x) / W
      if (x < left[y]) left[y] = x
      if (x > right[y]) right[y] = x
      if (y < top[x]) top[x] = y
      if (y > bottom[x]) bottom[x] = y
    }
    const pts = []
    for (let y = 0; y < H; y++) if (right[y] >= 0) { pts.push([left[y], y]); pts.push([right[y] + 1, y]) }
    for (let x = 0; x < W; x++) if (bottom[x] >= 0) { pts.push([x, top[x]]); pts.push([x, bottom[x] + 1]) }
    const hull = convexHull(pts)
    if (hull.length < 3) continue
    const hullArea = polyArea(hull)
    const corners = hullCorners(hull)
    const quadArea = polyArea(corners)
    const hullFrac = hullArea / (W * H)
    const solidity = blob.count / hullArea
    const quadFit = quadArea / hullArea
    // A page is a big, mostly-filled, four-cornered shape. Dark-on-light is allowed too
    // (white table, dark page), but the bright version wins ties.
    // A shape that reaches three or more sides of the photo and fills nearly all of it is the
    // background (the table), not the page.
    const [bx0, by0, bx1, by1] = blob.bbox
    const touch = (bx0 <= 1 ? 1 : 0) + (by0 <= 1 ? 1 : 0) + (bx1 >= W - 2 ? 1 : 0) + (by1 >= H - 2 ? 1 : 0)
    const backgroundLike = touch >= 3 && hullFrac > 0.85
    const score = hullFrac * Math.min(1, solidity / 0.7) * Math.min(1, quadFit / 0.92) * (bright ? 1.05 : 1) * (backgroundLike ? 0.1 : 1)
    if (!best || score > best.score) best = { score, hullFrac, solidity, quadFit, corners, bright, backgroundLike }
  }
  if (!best || best.backgroundLike || best.hullFrac < 0.12 || best.quadFit < 0.85 || best.solidity < 0.45) {
    return { quad: frame(0.03), found: false, why: 'no-page' }
  }
  const s = small.f === 1 ? 1 : (gray.w / small.w)
  const sy = small.f === 1 ? 1 : (gray.h / small.h)
  // Nudge each corner a hair outward from the middle: the brightness cut-off sits just inside the real edge.
  const cx = best.corners.reduce((a, p) => a + p[0], 0) / 4, cy = best.corners.reduce((a, p) => a + p[1], 0) / 4
  const quad = best.corners.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, len = Math.hypot(dx, dy) || 1
    const nx = x + (dx / len) * 1.0, ny = y + (dy / len) * 1.0
    return [Math.min(W, Math.max(0, nx)) * s, Math.min(H, Math.max(0, ny)) * sy]
  })
  return { quad, found: true, why: 'ok', hullFrac: best.hullFrac }
}

// ---------------------------------------------------------------------------
// 2. Straightening

// Solves for the projective map that takes the unit square to the four corners
// (Heckbert). Returns [a,b,c,d,e,f,g,h] with
//   X = (a u + b v + c) / (g u + h v + 1),  Y = (d u + e v + f) / (g u + h v + 1)
function squareToQuad(q) {
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3]
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3
  let a, b, c, d, e, f, g, h
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; h = 0
  } else {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0
  }
  return [a, b, c, d, e, f, g, h]
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1])

// How big the flat page should be: as wide as the page really is in the photo
// (never blown up), at most maxW, and in US Letter proportions when it is close to that.
export function pageSize(quad, maxW = 2200) {
  const wTop = dist(quad[0], quad[1]), wBot = dist(quad[3], quad[2])
  const hL = dist(quad[0], quad[3]), hR = dist(quad[1], quad[2])
  const w = (wTop + wBot) / 2, h = (hL + hR) / 2
  const aspect = h / w
  let ratio = aspect
  if (Math.abs(aspect - LETTER_RATIO) < 0.14 * LETTER_RATIO) ratio = LETTER_RATIO
  else if (Math.abs(aspect - 1 / LETTER_RATIO) < 0.14 / LETTER_RATIO) ratio = 1 / LETTER_RATIO
  // Size by the longer side so a landscape page is as sharp as a portrait one.
  const longSrc = Math.max(w, h)
  const longOut = Math.min(Math.round(longSrc), Math.round(maxW * LETTER_RATIO))
  let outW, outH
  if (ratio >= 1) { outH = longOut; outW = Math.round(longOut / ratio) } else { outW = longOut; outH = Math.round(longOut * ratio) }
  // sourceLong = how many photo pixels the page's long side really had (a page under about 1500 is too far away).
  return { w: Math.max(200, outW), h: Math.max(200, outH), sourceLong: Math.round(longSrc) }
}

// Resamples the quad of the source photo into an upright outW x outH page (bilinear).
export function warpToRect(gray, quad, outW, outH) {
  const m = squareToQuad(quad)
  const out = new Uint8Array(outW * outH)
  const { data, w, h } = gray
  const [a, b, c, d, e, f, g, hh] = m
  for (let y = 0; y < outH; y++) {
    const v = (y + 0.5) / outH
    for (let x = 0; x < outW; x++) {
      const u = (x + 0.5) / outW
      const den = g * u + hh * v + 1
      const sx = (a * u + b * v + c) / den - 0.5
      const sy = (d * u + e * v + f) / den - 0.5
      let x0 = Math.floor(sx), y0 = Math.floor(sy)
      const fx = sx - x0, fy = sy - y0
      if (x0 < 0) x0 = 0; else if (x0 > w - 2) x0 = w - 2
      if (y0 < 0) y0 = 0; else if (y0 > h - 2) y0 = h - 2
      const i = y0 * w + x0
      const top = data[i] + (data[i + 1] - data[i]) * fx
      const bot = data[i + w] + (data[i + w + 1] - data[i + w]) * fx
      out[y * outW + x] = top + (bot - top) * fy
    }
  }
  return { data: out, w: outW, h: outH }
}

export function rotate90(img, clockwise = true) {
  const { data, w, h } = img
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = clockwise ? h - 1 - y : y
      const ny = clockwise ? x : w - 1 - x
      out[ny * h + nx] = data[y * w + x]
    }
  }
  return { data: out, w: h, h: w }
}

// ---------------------------------------------------------------------------
// 3 and 4. Cleaning up the page

// Evens out light and shadow: works out how bright the blank paper is in each
// region (the brightest nearby pixels, looking past thick dark areas such as table
// headers), divides it out so paper is white everywhere, then stretches the
// contrast so the ink is solid dark.
export function flattenPage(img) {
  const { data, w, h } = img
  const B = 24
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B)
  const peak = new Uint8Array(gw * gh)
  // Paper brightness per block = a high percentile (about 90th) of the block, via a 64-bin histogram.
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      const hist = new Uint16Array(64)
      let n = 0
      const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B)
      for (let y = by * B; y < y1; y++) for (let x = bx * B; x < x1; x++) { hist[data[y * w + x] >> 2]++; n++ }
      let acc = 0, bin = 63
      const want = n * 0.1
      for (let k = 63; k >= 0; k--) { acc += hist[k]; if (acc >= want) { bin = k; break } }
      peak[by * gw + bx] = Math.min(255, bin * 4 + 3)
    }
  }
  // Look past thick dark areas: take the max of a 5x5 block neighbourhood, then smooth.
  const dil = new Uint8Array(gw * gh)
  const R = 2
  for (let by = 0; by < gh; by++) {
    for (let bx = 0; bx < gw; bx++) {
      let m = 0
      for (let yy = Math.max(0, by - R); yy <= Math.min(gh - 1, by + R); yy++) for (let xx = Math.max(0, bx - R); xx <= Math.min(gw - 1, bx + R); xx++) { const v = peak[yy * gw + xx]; if (v > m) m = v }
      dil[by * gw + bx] = m
    }
  }
  const bg = boxBlur(dil, gw, gh, 2)
  const out = new Uint8Array(w * h)
  // Bilinear lookup of the background at each pixel, then normalise.
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0
      const b0 = bg[y0 * gw + x0] + (bg[y0 * gw + x1] - bg[y0 * gw + x0]) * tx
      const b1 = bg[y1 * gw + x0] + (bg[y1 * gw + x1] - bg[y1 * gw + x0]) * tx
      const b = Math.max(40, b0 + (b1 - b0) * ty)
      const v = (data[y * w + x] * 255) / b
      out[y * w + x] = v > 255 ? 255 : v
    }
  }
  // Contrast: find the dark end (0.5th percentile) and push it to black; paper goes to white
  // a little before the top so it prints clean.
  const hist = new Uint32Array(256)
  for (let i = 0; i < out.length; i++) hist[out[i]]++
  let acc = 0, black = 0
  const cut = out.length * 0.005
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= cut) { black = k; break } }
  const white = 236
  const lut = new Uint8Array(256)
  for (let k = 0; k < 256; k++) {
    let t = (k - black) / Math.max(1, white - black)
    t = t < 0 ? 0 : t > 1 ? 1 : t
    // A mild curve: keeps grey type and thin lines from washing out.
    lut[k] = Math.round(255 * Math.pow(t, 1.35))
  }
  for (let i = 0; i < out.length; i++) out[i] = lut[out[i]]
  return { data: out, w, h }
}

// Unsharp mask: adds back a little of the difference from a blurred copy.
export function sharpen(img, amount = 0.7, radius = 2) {
  const { data, w, h } = img
  let blur = boxBlur(data, w, h, radius)
  blur = boxBlur(blur, w, h, radius)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) {
    const v = data[i] + amount * (data[i] - blur[i])
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return { data: out, w, h }
}

// ---------------------------------------------------------------------------
// 5. Is it sharp enough?

// How crisp the edges of the letters are. Looks at the steepest 0.1% of edges on a copy of
// the page about 1100 pixels wide (so big and small photos are scored alike). A sharp page has
// black-to-white jumps in a pixel or two (score near 255); blur spreads them out and the score
// falls. Unlike a "how much detail is on the page" measure, it scores a mostly blank cover page
// the same as a dense table, so a sparse page is not wrongly called blurry.
export function sharpnessScore(img) {
  const f = Math.max(1, Math.round(Math.min(img.w, img.h) / 1100))
  const s = f === 1 ? img : downscaleGray(img, Math.max(img.w, img.h) / f)
  const { data, w, h } = s
  const hist = new Uint32Array(256)
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = data[i + 1] - data[i - 1], gy = data[i + w] - data[i - w]
      const g = Math.max(gx < 0 ? -gx : gx, gy < 0 ? -gy : gy)
      hist[g]++; n++
    }
  }
  const want = n * 0.001
  let acc = 0
  for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= want) return k }
  return 0
}

// How bright the blank paper looked in the original photo (0 to 255).
export function paperBrightness(gray, quad) {
  // Sample the middle 60% of the page, take a high percentile so printing does not drag it down.
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4
  const hist = new Uint32Array(256)
  let n = 0
  const rx = Math.abs(quad[1][0] - quad[0][0]) * 0.3 + 1, ry = Math.abs(quad[3][1] - quad[0][1]) * 0.3 + 1
  const step = Math.max(1, Math.floor(Math.min(rx, ry) / 80))
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(gray.h, cy + ry); y += step) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(gray.w, cx + rx); x += step) { hist[gray.data[y * gray.w + x]]++; n++ }
  }
  if (!n) return 128
  let acc = 0
  for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc >= n * 0.15) return k }
  return 128
}

// Cut-offs for sharpnessScore on a cleaned page. Set from test photos with known blur: a score under
// SHARP_SOFT was unreadable or nearly so, SHARP_OK and above read fine.
export const SHARP_OK = 170
export const SHARP_SOFT = 120
// A page whose long side has fewer photo pixels than this was too far from the camera
// (about 135 dots per inch on a letter page). Paper that looked darker than this was shot in poor light.
export const MIN_PAGE_LONG_EDGE = 1500
export const DARK_PAPER = 75

// ---------------------------------------------------------------------------
// 6. The PDF

// One JPEG per page. Each page is 612 points wide (landscape pages 792), its height from the picture.
export function buildPdf(pages) {
  const enc = new TextEncoder()
  const chunks = []
  const offsets = []
  let len = 0
  const push = (x) => {
    const b = typeof x === 'string' ? enc.encode(x) : x
    chunks.push(b)
    len += b.length
  }
  const obj = (id, parts) => {
    offsets[id] = len
    push(`${id} 0 obj\n`)
    parts.forEach(push)
    push('\nendobj\n')
  }
  const total = 2 + pages.length * 3
  push('%PDF-1.4\n')
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>'])
  obj(2, [`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`])
  pages.forEach((p, i) => {
    const base = 3 + i * 3
    const W = p.w > p.h ? 792 : 612
    const H = Math.round((W * p.h) / p.w)
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`
    obj(base, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${base + 2} 0 R >> >> /Contents ${base + 1} 0 R >>`])
    obj(base + 1, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`])
    obj(base + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`,
      p.bytes,
      '\nendstream'
    ])
  })
  const xrefPos = len
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= total; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  push(`${xref}trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)
  const out = new Uint8Array(len)
  let at = 0
  chunks.forEach((c) => { out.set(c, at); at += c.length })
  return out
}

// The whole clean-up for one photo, given its corners. Returns { page: gray image, quad, size }.
export function scanPage(gray, quad) {
  const size = pageSize(quad)
  const flat = warpToRect(gray, quad, size.w, size.h)
  const page = sharpen(flattenPage(flat))
  return { page, size }
}
