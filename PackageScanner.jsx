import { useState, useRef, useEffect } from 'react'
import { rgbaToGray, findPageQuad, scanPage, sharpnessScore, paperBrightness, buildPdf, SHARP_OK, SHARP_SOFT, MIN_PAGE_LONG_EDGE, DARK_PAPER } from './scanMath.js'

// ---------------------------------------------------------------------------
// Package scanner: the "Scan with camera" button on the pivot profile.
//
// One tap opens the phone's own camera (full-size photo, real autofocus). Each photo
// is then run through the scanner maths in scanMath.js: find the page, straighten it,
// even out shadows, sharpen, and check it is sharp enough. The person sees the cleaned
// page and can retake it, rotate it, drag its corners, add more pages or delete one.
// "Upload" wraps the pages in a plain PDF and hands it to onPdf, the same path as a
// PDF picked from the phone. Nothing else about the package flow changes.

const MAX_PAGES = 12
const MAX_PHOTO_EDGE = 3600 // photos bigger than this are shrunk on load (keeps phones from running out of memory)

const tick = () => new Promise((r) => setTimeout(r, 0))

// Opens a photo the way the person held the phone (EXIF turn applied) and returns its gray pixels.
async function decodePhoto(file) {
  let bmp = null
  if (typeof createImageBitmap === 'function') {
    try {
      const probe = await createImageBitmap(file, { imageOrientation: 'from-image' })
      const big = Math.max(probe.width, probe.height)
      if (big > MAX_PHOTO_EDGE) {
        const k = MAX_PHOTO_EDGE / big
        bmp = await createImageBitmap(probe, { resizeWidth: Math.round(probe.width * k), resizeHeight: Math.round(probe.height * k), resizeQuality: 'high' })
        probe.close && probe.close()
      } else {
        bmp = probe
      }
    } catch (e) { bmp = null }
  }
  let w, h, draw
  if (bmp) {
    w = bmp.width; h = bmp.height; draw = (ctx) => ctx.drawImage(bmp, 0, 0, w, h)
  } else {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image()
        im.onload = () => resolve(im)
        im.onerror = () => reject(new Error("Couldn't open that photo. Try taking it again."))
        im.src = url
      })
      const k = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
      w = Math.max(1, Math.round(img.naturalWidth * k)); h = Math.max(1, Math.round(img.naturalHeight * k))
      draw = (ctx) => ctx.drawImage(img, 0, 0, w, h)
    } finally { URL.revokeObjectURL(url) }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  draw(ctx)
  const rgba = ctx.getImageData(0, 0, w, h).data
  if (bmp && bmp.close) bmp.close()
  canvas.width = canvas.height = 0
  return rgbaToGray(rgba, w, h)
}

async function grayToJpeg(img, quality = 0.85) {
  const canvas = document.createElement('canvas')
  canvas.width = img.w; canvas.height = img.h
  const ctx = canvas.getContext('2d')
  const out = ctx.createImageData(img.w, img.h)
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) { out.data[j] = out.data[j + 1] = out.data[j + 2] = img.data[i]; out.data[j + 3] = 255 }
  ctx.putImageData(out, 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  canvas.width = canvas.height = 0
  if (!blob) throw new Error("Couldn't make the page. Try again.")
  return blob
}

async function rotateJpeg(blob, clockwise) {
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error("Couldn't turn that page.")); im.src = url })
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalHeight; canvas.height = img.naturalWidth
    const ctx = canvas.getContext('2d')
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2)
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
    const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    const res = { blob: out, w: canvas.width, h: canvas.height }
    canvas.width = canvas.height = 0
    return res
  } finally { URL.revokeObjectURL(url) }
}

// What to tell the person about a finished page. Order = most important first.
function warningsFor(info) {
  const out = []
  if (!info.found) out.push({ key: 'edges', text: "Couldn't find the edges of the page. Tap Adjust edges and drag the corners onto the paper." })
  if (info.sharp < SHARP_SOFT) out.push({ key: 'blur', bad: true, text: 'This page is blurry, so the numbers may not be readable. Hold the phone steady, let it focus, and tap Retake.' })
  else if (info.sharp < SHARP_OK && info.sourceLong >= MIN_PAGE_LONG_EDGE) out.push({ key: 'soft', text: 'This page is a little soft. If the numbers look hard to read below, tap Retake.' })
  if (info.sourceLong < MIN_PAGE_LONG_EDGE) out.push({ key: 'small', text: 'The page is small in the photo. Move closer so it fills the screen, then tap Retake.' })
  if (info.bright < DARK_PAPER) out.push({ key: 'dark', text: 'The photo was dark. Turn on a light or move to a brighter spot, then tap Retake.' })
  return out
}

// Runs the whole clean-up for one photo file. quadOverride: corners in photo pixels (when the person adjusted them).
async function processPhoto(file, quadOverride, say) {
  say('Opening the photo…')
  const gray = await decodePhoto(file)
  await tick()
  say('Finding the page…')
  const found = quadOverride ? { quad: quadOverride, found: true } : findPageQuad(gray)
  await tick()
  say('Straightening and cleaning up…')
  const { page, size } = scanPage(gray, found.quad)
  await tick()
  const sharp = sharpnessScore(page)
  const bright = paperBrightness(gray, found.quad)
  const blob = await grayToJpeg(page)
  return { blob, w: page.w, h: page.h, quad: found.quad, srcW: gray.w, srcH: gray.h, info: { found: found.found, sharp, bright, sourceLong: size.sourceLong } }
}

// ---------------------------------------------------------------------------

function CameraIcon({ color = '#fff', size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  )
}

const btn = (extra) => ({ fontSize: '14px', padding: '10px 14px', borderRadius: '8px', border: '1px solid #ccc', background: '#fff', color: '#2b2b26', cursor: 'pointer', ...extra })
const btnDark = (extra) => btn({ background: '#2b2b26', color: '#fff', border: 'none', ...extra })

// Drag the four corners onto the page (shown over the original photo).
function EdgeEditor({ file, quad, srcW, srcH, onApply, onCancel }) {
  const [pts, setPts] = useState(quad)
  const [url, setUrl] = useState('')
  const boxRef = useRef(null)
  const dragRef = useRef(-1)
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u) }, [file])
  const pos = (e) => {
    const r = boxRef.current.getBoundingClientRect()
    const x = Math.min(srcW, Math.max(0, ((e.clientX - r.left) / r.width) * srcW))
    const y = Math.min(srcH, Math.max(0, ((e.clientY - r.top) / r.height) * srcH))
    return [x, y]
  }
  const down = (i) => (e) => { dragRef.current = i; e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault() }
  const move = (e) => { const i = dragRef.current; if (i < 0) return; const p = pos(e); setPts((prev) => prev.map((q, k) => (k === i ? p : q))) }
  const up = () => { dragRef.current = -1 }
  const pct = (p) => `${(p[0] / srcW) * 100}% ${(p[1] / srcH) * 100}%`
  return (
    <div>
      <div style={{ fontSize: '13px', color: '#2b2b26', marginBottom: '8px' }}>Drag each corner dot onto a corner of the paper.</div>
      <div ref={boxRef} data-testid="edge-box" onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ position: 'relative', width: '100%', aspectRatio: `${srcW} / ${srcH}`, touchAction: 'none', userSelect: 'none', background: '#ddd' }}>
        {url && <img src={url} alt="Your photo" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />}
        <svg viewBox={`0 0 ${srcW} ${srcH}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <polygon points={pts.map((p) => p.join(',')).join(' ')} fill="rgba(47,107,47,0.12)" stroke="#2F6B2F" strokeWidth={Math.max(srcW, srcH) / 300} vectorEffect="non-scaling-stroke" />
        </svg>
        {pts.map((p, i) => (
          <div key={i} data-testid={`corner-${i}`} onPointerDown={down(i)} style={{ position: 'absolute', left: `${(p[0] / srcW) * 100}%`, top: `${(p[1] / srcH) * 100}%`, width: '44px', height: '44px', margin: '-22px 0 0 -22px', borderRadius: '50%', background: 'rgba(47,107,47,0.25)', border: '2px solid #2F6B2F', boxSizing: 'border-box', touchAction: 'none', cursor: 'grab' }} />
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button data-testid="edge-apply" onClick={() => onApply(pts)} style={btnDark()}>Use these corners</button>
        <button onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  )
}

export default function PackageScanner({ onPdf, disabled, onError, label = 'Scan with camera', replaceStyle = false, iconOnly = false }) {
  const [open, setOpen] = useState(false)
  const [pages, setPages] = useState([])   // { id, file, blob, url, w, h, quad, srcW, srcH, info }
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState('')     // text while working
  const [note, setNote] = useState(null)   // an error inside the scanner
  const [editing, setEditing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef(null)
  const modeRef = useRef('add')            // 'add' | 'retake'
  const idRef = useRef(1)
  const pagesRef = useRef([])
  pagesRef.current = pages

  useEffect(() => () => { pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url)) }, [])

  function clickCamera(mode) { modeRef.current = mode; if (inputRef.current) inputRef.current.click() }

  async function handlePhoto(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    const mode = modeRef.current
    setOpen(true); setNote(null); setEditing(false); setBusy('Opening the photo…')
    if (onError) onError(null)
    try {
      const r = await processPhoto(file, null, setBusy)
      const page = { id: idRef.current++, file, blob: r.blob, url: URL.createObjectURL(r.blob), w: r.w, h: r.h, quad: r.quad, srcW: r.srcW, srcH: r.srcH, info: r.info }
      const baseLen = pagesRef.current.length
      setPages((prev) => {
        if (mode === 'retake' && prev[sel]) { URL.revokeObjectURL(prev[sel].url); const n = prev.slice(); n[sel] = page; return n }
        return prev.length >= MAX_PAGES ? prev : [...prev, page]
      })
      if (mode !== 'retake') setSel(Math.min(baseLen, MAX_PAGES - 1))
    } catch (err) {
      setNote(err.message || "Couldn't use that photo. Try again.")
    } finally { setBusy('') }
  }

  async function applyCorners(quad) {
    const p = pages[sel]
    if (!p) return
    setEditing(false); setBusy('Straightening…'); setNote(null)
    try {
      const r = await processPhoto(p.file, quad, setBusy)
      URL.revokeObjectURL(p.url)
      setPages((prev) => { const n = prev.slice(); n[sel] = { ...p, blob: r.blob, url: URL.createObjectURL(r.blob), w: r.w, h: r.h, quad: r.quad, info: { ...r.info, found: true } }; return n })
    } catch (err) { setNote(err.message || "Couldn't redo that page.") } finally { setBusy('') }
  }

  async function rotate(clockwise) {
    const p = pages[sel]
    if (!p) return
    setBusy('Turning the page…'); setNote(null)
    try {
      const r = await rotateJpeg(p.blob, clockwise)
      URL.revokeObjectURL(p.url)
      setPages((prev) => { const n = prev.slice(); n[sel] = { ...p, blob: r.blob, url: URL.createObjectURL(r.blob), w: r.w, h: r.h, quad: null }; return n })
    } catch (err) { setNote(err.message) } finally { setBusy('') }
  }

  function removePage() {
    const p = pages[sel]
    if (!p) return
    URL.revokeObjectURL(p.url)
    const n = pages.filter((_, i) => i !== sel)
    setPages(n)
    setSel(Math.max(0, Math.min(sel, n.length - 1)))
    if (!n.length) setOpen(false)
  }

  function closeAll() {
    pages.forEach((p) => URL.revokeObjectURL(p.url))
    setPages([]); setSel(0); setOpen(false); setEditing(false); setNote(null); setBusy('')
  }

  async function upload() {
    if (!pages.length) return
    setUploading(true); setNote(null)
    try {
      const bytes = await Promise.all(pages.map(async (p) => ({ bytes: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h })))
      const stamp = new Date().toISOString().slice(0, 10)
      const file = new File([buildPdf(bytes)], `Package scan ${stamp}.pdf`, { type: 'application/pdf' })
      const saved = await onPdf(file)
      if (saved) closeAll()
      else setNote("Couldn't upload the scan. Check your signal and tap Upload again. Your pages are still here.")
    } catch (err) {
      setNote(err.message || "Couldn't make the PDF. Try again.")
    } finally { setUploading(false) }
  }

  const cur = pages[sel]
  const warns = cur && cur.info ? warningsFor(cur.info) : []
  const working = !!busy || uploading

  return (
    <>
      <button
        type="button"
        data-testid="scan-button"
        onClick={() => clickCamera('add')}
        disabled={disabled || working}
        title={iconOnly ? 'Scan the package with your camera' : undefined}
        aria-label={iconOnly ? 'Scan the package with your camera' : undefined}
        style={iconOnly
          ? { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '26px', height: '22px', padding: 0, border: '1px solid #ccc', borderRadius: '5px', background: disabled ? '#f4f2ec' : '#fff', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }
          : replaceStyle
          ? { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '6px 10px', border: '1px solid #ccc', borderRadius: '6px', background: '#fff', color: '#2b2b26', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }
          : { display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', padding: '9px 14px', border: 'none', borderRadius: '8px', background: '#2b2b26', color: '#fff', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      >
        <CameraIcon color={replaceStyle || iconOnly ? '#2b2b26' : '#fff'} size={iconOnly ? 15 : 20} />
        {iconOnly ? null : label}
      </button>
      <input ref={inputRef} data-testid="scan-input" type="file" accept="image/*" capture="environment" onChange={handlePhoto} style={{ display: 'none' }} />

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Scan the package" data-testid="scanner" style={{ position: 'fixed', inset: 0, zIndex: 1100, background: '#f4f2ec', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e4e1d8', background: '#fff' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: '#2b2b26' }}>Scan the package{pages.length ? ` · ${pages.length} page${pages.length === 1 ? '' : 's'}` : ''}</div>
            <button onClick={closeAll} disabled={uploading} style={btn({ padding: '6px 12px', fontSize: '13px' })}>Cancel</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
            {busy && (
              <div data-testid="scan-busy" style={{ fontSize: '13px', color: '#555', padding: '10px 12px', background: '#fff', borderRadius: '8px', marginBottom: '12px' }}>{busy}</div>
            )}
            {note && (
              <div role="alert" style={{ background: '#FBEAEA', border: '1px solid #E8B4B4', borderRadius: '8px', padding: '10px 12px', marginBottom: '12px', fontSize: '13px', color: '#A32D2D' }}>{note}</div>
            )}

            {editing && cur && cur.quad ? (
              <EdgeEditor file={cur.file} quad={cur.quad} srcW={cur.srcW} srcH={cur.srcH} onApply={applyCorners} onCancel={() => setEditing(false)} />
            ) : cur ? (
              <>
                <img data-testid="scan-preview" src={cur.url} alt={`Page ${sel + 1}`} style={{ display: 'block', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '44vh', margin: '0 auto', background: '#fff', border: '1px solid #ccc', borderRadius: '4px', opacity: busy ? 0.5 : 1 }} />
                <div style={{ maxWidth: '560px', margin: '12px auto 0' }}>
                  {warns.map((w) => (
                    <div key={w.key} data-testid={`warn-${w.key}`} style={{ background: w.bad ? '#FBEAEA' : '#FBF3E2', border: `1px solid ${w.bad ? '#E8B4B4' : '#F0D9A8'}`, borderRadius: '8px', padding: '8px 12px', marginBottom: '8px', fontSize: '12px', color: w.bad ? '#A32D2D' : '#6B4108' }}>{w.text}</div>
                  ))}
                  {!warns.length && <div style={{ fontSize: '12px', color: '#2F6B2F', marginBottom: '8px' }}>Looks sharp and readable.</div>}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button data-testid="retake" onClick={() => clickCamera('retake')} disabled={working} style={btn()}>Retake</button>
                    <button data-testid="rotate" onClick={() => rotate(true)} disabled={working} style={btn()}>Turn page</button>
                    {cur.quad && <button data-testid="adjust" onClick={() => setEditing(true)} disabled={working} style={btn()}>Adjust edges</button>}
                    <button data-testid="delete-page" onClick={removePage} disabled={working} style={btn({ color: '#A32D2D', background: '#FBEAEA', border: '1px solid #E8B4B4' })}>Delete page</button>
                  </div>
                </div>
                {pages.length > 1 && (
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', margin: '16px auto 0', maxWidth: '560px', paddingBottom: '4px' }}>
                    {pages.map((p, i) => (
                      <button key={p.id} data-testid={`thumb-${i}`} onClick={() => setSel(i)} aria-label={`Page ${i + 1}`} style={{ flex: '0 0 auto', padding: 0, border: i === sel ? '2px solid #2b2b26' : '1px solid #ccc', borderRadius: '4px', background: '#fff', cursor: 'pointer' }}>
                        <img src={p.url} alt="" style={{ display: 'block', height: '72px', width: 'auto' }} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (!busy && (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <button data-testid="try-again" onClick={() => clickCamera('add')} style={btnDark()}>Take a photo</button>
              </div>
            ))}
          </div>

          {!editing && (
            <div style={{ display: 'flex', gap: '10px', padding: '12px 16px', borderTop: '1px solid #e4e1d8', background: '#fff' }}>
              <button data-testid="add-page" onClick={() => clickCamera('add')} disabled={working || pages.length >= MAX_PAGES} style={btn({ flex: 1, opacity: working || pages.length >= MAX_PAGES ? 0.5 : 1 })}>Add page</button>
              <button data-testid="upload-scan" onClick={upload} disabled={working || !pages.length} style={btnDark({ flex: 2, opacity: working || !pages.length ? 0.5 : 1 })}>
                {uploading ? 'Uploading…' : `Upload ${pages.length === 1 ? 'this page' : `these ${pages.length} pages`}`}
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
