// Sprinkler package reader.
//
// When a PDF is uploaded to a pivot profile (Storage path
// pivotProfiles/{pivotGuid}/...), this reads the system GPM and the
// pivot/field name off the package and saves them on
// pivotProfiles/{pivotGuid}.packageScan for a manager to confirm.
// Nothing here touches currentGpm: the GPM only goes live when a manager
// confirms it on the pivot profile screen.
//
// How the text is read:
//   1. Computer-made PDFs (dealer design software, "Print to PDF") have
//      real text inside, read with pdf.js.
//   2. Scanned PDFs (copier scans) are just pictures, so the first pages
//      go to Google Cloud Vision for text recognition (OCR). Vision copes
//      with sideways/upside-down pages. Needs the Cloud Vision API enabled
//      on the project once: gcloud services enable vision.googleapis.com
//
// Label patterns seen so far (add new dealers' wording here):
//   Wish Northwest (Butte Irrigation): "TOTAL GPM = 109.87",
//     cover "SYSTEM 109 GPM @ 50 PSI", name "LEGAL : 35E MINI" /
//     "FIELD - 35E MINI"
//   Valley V-Chart (Sprinkler Shop Valley/Paul): "Machine Flow 697 (GPM)",
//     name under "Field Name"
//
// packageScan is keyed by storagePath, so the screen can tell whether the
// scan belongs to the package currently on the profile (a scan of an older
// upload that finishes late is simply ignored there).

const { onObjectFinalized } = require('firebase-functions/v2/storage');
const admin = require('firebase-admin');

const OCR_PAGES = [1, 2, 3, 4, 5]; // Vision reads at most 5 PDF pages per request
const MIN_GPM = 5;
const MAX_GPM = 5000;
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';

// ---------------------------------------------------------------------------
// Pure text helpers (no Firebase), exported for tests.

function toNumber(s) {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// Finds the system GPM in the package text. Tries the most specific label
// first. Returns { gpm, label } or null.
function findGpm(text) {
  if (!text) return null;
  const patterns = [
    // Wish Northwest: the delivered total of the nozzles actually chosen.
    // "TOTAL TARGET GPM" is deliberately not matched (that's the goal).
    { label: 'Total GPM', re: new RegExp('TOTAL\\s+GPM\\s*[=:]\\s*' + NUM, 'gi') },
    // Valley V-Chart cover: "Machine Flow 697 (GPM)"
    { label: 'Machine flow', re: new RegExp('MACHINE\\s+FLOW\\s*[:=]?\\s*' + NUM + '\\s*\\(?\\s*GPM', 'gi') },
    // Wish Northwest cover, rounded target: "SYSTEM 109 GPM @ 50 PSI"
    { label: 'System GPM (cover)', re: new RegExp('SYSTEM\\s+' + NUM + '\\s*GPM', 'gi') }
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(text)) !== null) {
      const n = toNumber(m[1]);
      if (n != null && n >= MIN_GPM && n <= MAX_GPM) return { gpm: n, label: p.label };
    }
  }
  return null;
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// A candidate name has to contain at least two letters (skips dealer
// numbers like "00006494" that sit next to a label on some covers).
function looksLikeName(s) {
  return (String(s).match(/[a-z]/gi) || []).length >= 2;
}

// Every pivot/field name printed on the package, best guesses first.
// More than one can turn up (labels sit in columns on some covers), so the
// caller prefers whichever one matches the pivot.
function findNames(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out = [];
  const add = (s) => {
    const c = cleanName(s);
    if (c && looksLikeName(c) && !out.includes(c)) out.push(c);
  };
  // Same-line labels first.
  for (const line of lines) {
    let m = line.match(/^LEGAL\s*:\s*(.+)$/i);
    if (m) add(m[1]);
  }
  for (const line of lines) {
    const m = line.match(/FIELD\s+NAME\s*[:\-]?\s*(.+)$/i);
    if (m) add(m[1]);
  }
  for (const line of lines) {
    const m = line.match(/^FIELD\s*-\s*(.+)$/i);
    if (m) add(m[1]);
  }
  // Valley V-Chart cover puts the value on a line below "Field Name".
  for (let i = 0; i < lines.length; i++) {
    if (/FIELD\s+NAME\s*[:\-]?\s*$/i.test(lines[i])) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) add(lines[j]);
    }
  }
  return out;
}

function findName(text) {
  const names = findNames(text);
  return names.length ? names[0] : null;
}

// "35 E. MINI" -> "35emini". Spaces, punctuation and capitals don't count.
function squash(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The package name matches if any of the AIO names (pivot name or a linked
// AgWorld field name) appears inside it, or it appears inside one of them.
// So "Wilson South Big Pivot updated Feb. 2026" matches "Wilson South Big",
// and "35E MINI" matches "35 E. Mini".
function nameMatches(packageName, aioNames) {
  const p = squash(packageName);
  if (p.length < 3) return { matches: false, matchedName: null };
  for (const name of aioNames || []) {
    const a = squash(name);
    if (a.length < 3) continue;
    if (p.includes(a) || a.includes(p)) return { matches: true, matchedName: name };
  }
  return { matches: false, matchedName: null };
}

// ---------------------------------------------------------------------------
// Reading text out of the PDF.

async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0
  }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Rebuild lines from the text items so "LEGAL : 35E MINI" stays on one line.
    // Text far apart on the same line is a separate column (e.g. the cover's
    // "LEGAL : 35E MINI" next to "NELSON O3030 ORBITOR"), so it gets its
    // own line.
    let out = '';
    let lastY = null;
    let lastXEnd = null;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      // Blank spacer items would hide the gap between columns.
      if (!item.str.trim()) { if (item.hasEOL && !out.endsWith('\n')) out += '\n'; continue; }
      const x = item.transform ? item.transform[4] : null;
      const y = item.transform ? Math.round(item.transform[5]) : null;
      const newRow = lastY !== null && y !== null && Math.abs(y - lastY) > 2;
      const farGap = !newRow && lastXEnd !== null && x !== null && x - lastXEnd > 30;
      if (newRow || farGap) { if (!out.endsWith('\n')) out += '\n'; }
      else if (out && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
      out += item.str;
      if (item.hasEOL) out += '\n';
      lastY = y;
      lastXEnd = x !== null ? x + (item.width || 0) : null;
    }
    pages.push(out);
  }
  await doc.destroy();
  return { text: pages.join('\n'), pageCount: pages.length };
}

async function ocrPdf(buffer) {
  const vision = require('@google-cloud/vision');
  const client = new vision.ImageAnnotatorClient();
  const [result] = await client.batchAnnotateFiles({
    requests: [{
      inputConfig: { content: buffer.toString('base64'), mimeType: 'application/pdf' },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      pages: OCR_PAGES
    }]
  });
  const fileResp = result.responses && result.responses[0];
  const pageResps = (fileResp && fileResp.responses) || [];
  return pageResps
    .map((r) => (r.fullTextAnnotation && r.fullTextAnnotation.text) || '')
    .join('\n');
}

// Reads one stored package and returns what was found. Does not write.
async function readPackage(bucketName, storagePath) {
  const [buffer] = await admin.storage().bucket(bucketName).file(storagePath).download();
  let method = 'text';
  let text = '';
  try {
    text = (await extractPdfText(buffer)).text;
  } catch (err) {
    console.warn('pdf text read failed, trying OCR', storagePath, err.message);
  }
  // No GPM in the PDF's own text (usually a scan, which has no text at all):
  // try OCR. Use the OCR text if it found a GPM, or if the PDF had
  // basically no text of its own (so the name can still come from OCR).
  if (!findGpm(text)) {
    const hasOwnText = text.replace(/\s/g, '').length >= 40;
    try {
      const ocrText = await ocrPdf(buffer);
      if (findGpm(ocrText) || !hasOwnText) {
        text = ocrText;
        method = 'ocr';
      }
    } catch (err) {
      console.error('OCR failed', storagePath, err.message);
      if (!hasOwnText) throw new Error('Could not read this PDF (OCR failed: ' + err.message + ')');
    }
  }
  return { method, gpmFound: findGpm(text), namesOnPackage: findNames(text) };
}

// The names AIO knows this pivot by: its BaseStation name plus the names of
// every AgWorld field it's linked to.
async function aioNamesForPivot(pivotGuid) {
  const db = admin.firestore();
  const names = [];
  const pivotSnap = await db.collection('pivots').doc(pivotGuid).get();
  if (pivotSnap.exists && pivotSnap.data().name) names.push(pivotSnap.data().name);
  const mapSnap = await db.collection('pivotFieldMapping').where('pivotGuid', '==', pivotGuid).get();
  const fieldIds = new Set();
  mapSnap.forEach((d) => { if (d.data().fieldId) fieldIds.add(String(d.data().fieldId)); });
  const fieldSnaps = await Promise.all([...fieldIds].map((id) => db.collection('fields').doc(id).get()));
  fieldSnaps.forEach((s) => { if (s.exists && s.data().name) names.push(s.data().name); });
  return names;
}

// Reads the package and saves the result on the pivot profile.
// Shared by the upload trigger and the one-time go-live rescan.
async function scanAndSave(bucketName, storagePath, pivotGuid) {
  const ref = admin.firestore().collection('pivotProfiles').doc(pivotGuid);
  let scan;
  try {
    const found = await readPackage(bucketName, storagePath);
    const names = await aioNamesForPivot(pivotGuid);
    // Use the first name on the package that matches the pivot; if none
    // match, show the first one found so the manager sees what it says.
    let nameOnPackage = found.namesOnPackage[0] || null;
    let match = { matches: false, matchedName: null };
    for (const candidate of found.namesOnPackage) {
      const r = nameMatches(candidate, names);
      if (r.matches) { nameOnPackage = candidate; match = r; break; }
    }
    scan = {
      storagePath,
      status: found.gpmFound ? 'read' : 'noGpm',
      gpm: found.gpmFound ? found.gpmFound.gpm : null,
      gpmLabel: found.gpmFound ? found.gpmFound.label : null,
      method: found.method,
      nameOnPackage,
      nameMatches: match.matches,
      matchedName: match.matchedName,
      aioNames: names.slice(0, 10),
      scannedAt: new Date().toISOString(),
      error: null
    };
  } catch (err) {
    scan = {
      storagePath,
      status: 'failed',
      gpm: null,
      gpmLabel: null,
      method: null,
      nameOnPackage: null,
      nameMatches: false,
      matchedName: null,
      aioNames: [],
      scannedAt: new Date().toISOString(),
      error: String(err.message || err).slice(0, 300)
    };
  }
  await ref.set({ packageScan: scan }, { merge: true });
  return scan;
}

// Runs on every file added to Storage; only acts on pivot profile PDFs.
const scanSprinklerPackage = onObjectFinalized(
  { memory: '1GiB', timeoutSeconds: 120 },
  async (event) => {
    const obj = event.data;
    const path = obj.name || '';
    const m = path.match(/^pivotProfiles\/([^/]+)\/[^/]+$/);
    if (!m) return;
    const isPdf = (obj.contentType || '').includes('pdf') || /\.pdf$/i.test(path);
    if (!isPdf) return;
    const scan = await scanAndSave(obj.bucket, path, m[1]);
    console.log('package scan', path, scan.status, scan.gpm, scan.method, scan.nameOnPackage, scan.nameMatches);
  }
);

module.exports = {
  scanSprinklerPackage,
  scanAndSave,
  // for tests
  findGpm,
  findName,
  findNames,
  nameMatches,
  squash,
  extractPdfText
};
