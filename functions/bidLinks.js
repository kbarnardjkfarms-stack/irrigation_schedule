// =============================================================================
// Planning › Prices & bids — no-login bid links for vendors (Nov 2026)
// =============================================================================
// An Admin/Owner builds a season's bid list (priceBids), opens a bid round
// (bidRounds/{roundId}: title, due date, which products, a message), and makes
// one link per vendor. The link opens AIO at /bid/<code> with no sign-in:
//   - the vendor sees only the products on the round, the forecast volume and
//     the unit — never anyone else's prices, our history or other vendors
//   - they enter a price per product (their unit, an optional discount %, a
//     note, an alternative product they'd offer) and submit; they can come
//     back and change it until the round closes or the due date passes
//   - each price lands in this season's price database (priceQuotes) as that
//     vendor's quote, source "Bid link", so it shows up on the Bids tab at once
//   - once awards are published, the same link shows what we're committing to
//     buy from them: product, committed volume and their price
// A link can be turned off at any time; the old code stops working.
//
// Firestore (no browser rule for bidLinks, so codes can't be listed or read):
//   bidLinks/{code}     roundId, season, seller, email, contact, at, by,
//                       openedAt, submittedAt, count, off
//   bidRounds/{roundId} season, title, due (YYYY-MM-DD), message, productKeys[],
//                       status 'open' | 'closed', awardsPublished, publishedAt
//   priceBids/{season}__{key}  volume, onHand, volUnit, commit (override)
//   priceQuotes/bl_<code>_<key>  the vendor's quote (one per product per link)
// Lives in its own file so an index.js upload can't wipe it; index.js only
// re-exports bidPortal and bidLinkAdmin.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const LINKS = 'bidLinks';
const newCode = () => crypto.randomBytes(18).toString('base64url');
const docKey = (k) => String(k).replace(/[/.#$[\]]/g, '_').slice(0, 140);
const UNITS = ['gal', 'qt', 'pt', 'floz', 'lb', 'oz', 'ton', 'each', 'acre'];
const FAMILY_UNIT = { vol: 'gal', wt: 'lb' };
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[$,\s%]/g, '')); return isFinite(n) ? n : null; };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date());
// gallons / pounds per unit, to price a committed volume in the vendor's own unit
const VOL = { gal: 1, qt: 0.25, pt: 0.125, floz: 1 / 128, oz: 1 / 128 };
const WT = { ton: 2000, lb: 1, oz: 1 / 16 };
function convert(qty, from, to) {
  if (from === to) return qty;
  if (VOL[from] != null && VOL[to] != null && from !== 'oz' && to !== 'oz') return (qty * VOL[from]) / VOL[to];
  if (WT[from] != null && WT[to] != null) return (qty * WT[from]) / WT[to];
  if (VOL[from] != null && VOL[to] != null) return (qty * VOL[from]) / VOL[to];
  return null;
}
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const quoteDocId = (code, key) => `bl_${code.slice(0, 10)}_${hash(key)}`;

async function linkFor(db, code) {
  const c = String(code || '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(c)) throw new HttpsError('not-found', 'This link isn’t right. Ask JK Farms for a new one.');
  const snap = await db.collection(LINKS).doc(c).get();
  const l = snap.data();
  if (!l || l.off) throw new HttpsError('not-found', 'This link was turned off. Ask JK Farms for a new one.');
  return Object.assign({ code: c }, l);
}
async function roundFor(db, link) {
  const r = (await db.collection('bidRounds').doc(String(link.roundId)).get()).data();
  if (!r) throw new HttpsError('not-found', 'This bid isn’t available any more.');
  return r;
}
function isOpen(r) {
  if (r.status === 'closed') return false;
  if (r.due && today() > r.due) return false;
  return true;
}

// What the vendor sees: product, forecast volume, unit — and only their own prices.
async function portalView(db, link, round) {
  const keys = Array.isArray(round.productKeys) ? round.productKeys : [];
  const refsP = keys.map((k) => db.collection('priceProducts').doc(docKey(k)));
  const refsB = keys.map((k) => db.collection('priceBids').doc(`${round.season}__${docKey(k)}`));
  const refsQ = keys.map((k) => db.collection('priceQuotes').doc(quoteDocId(link.code, k)));
  const [ps, bs, qs] = await Promise.all([refsP, refsB, refsQ].map((refs) => (refs.length ? db.getAll(...refs) : Promise.resolve([]))));
  const lines = keys.map((k, i) => {
    const p = ps[i].data() || {};
    const b = bs[i].data() || {};
    const q = qs[i].exists ? qs[i].data() : null;
    const need = num(b.volume), have = num(b.onHand);
    const forecast = need == null ? null : Math.max(0, need - (have || 0));
    return {
      key: k, name: p.name || k, class: p.class || null, ai: p.ai && !/^(none|n\/a)$/i.test(p.ai) ? p.ai : null,
      forecast: forecast == null ? null : Math.round(forecast * 10) / 10,
      unit: b.volUnit || FAMILY_UNIT[p.family] || 'gal',
      mine: q ? { price: q.price ?? null, unit: q.unit || null, discount: q.discount ?? null, note: q.note || null, alt: q.altProduct || null, at: q.submittedAt || null } : null
    };
  }).sort((a, b) => String(a.class || '').localeCompare(String(b.class || '')) || a.name.localeCompare(b.name));
  // Awards: only this vendor's own, and only once published.
  let awards = null;
  if (round.awardsPublished) {
    const aSnap = await db.collection('priceQuotes').where('season', '==', round.season).where('award', '==', true).get();
    const mine = [];
    aSnap.forEach((d) => {
      const q = d.data();
      if (q.seller !== link.seller || !keys.includes(q.productKey)) return;
      const line = lines.find((l) => l.key === q.productKey);
      const b = bs[keys.indexOf(q.productKey)].data() || {};
      // what we commit to: the line's own number, else (needed − on hand) × 95% like the order sheet
      const commit = num(b.commit) ?? (line && line.forecast != null ? Math.round(line.forecast * 0.95 * 10) / 10 : null);
      const unit = line ? line.unit : null;
      const inPriceUnits = commit != null && unit && q.unit ? convert(commit, unit, q.unit) : null;
      const est = inPriceUnits != null && q.price != null ? Math.round(inPriceUnits * q.price * (1 - (q.discount || 0)) * 100) / 100 : null;
      mine.push({ name: line ? line.name : q.productKey, volume: commit, unit, price: q.price ?? null, priceUnit: q.unit || null, discount: q.discount ?? null, est });
    });
    awards = mine.sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    seller: link.seller, title: round.title || `${round.season} bid`, season: round.season, due: round.due || null,
    message: round.message || null, open: isOpen(round), submittedAt: link.submittedAt || null, lines, awards,
    publishedAt: round.publishedAt || null, units: UNITS
  };
}

async function portalCall(db, data) {
  const link = await linkFor(db, data.code);
  const round = await roundFor(db, link);
  if (data.action === 'submit') {
    if (!isOpen(round)) throw new HttpsError('failed-precondition', 'This bid is closed, so prices can’t be changed. Contact JK Farms.');
    const keys = new Set(round.productKeys || []);
    const entries = Array.isArray(data.entries) ? data.entries.slice(0, 500) : [];
    const batch = db.batch();
    let n = 0;
    const now = Date.now();
    entries.forEach((e) => {
      if (!e || !keys.has(e.key)) return;
      const ref = db.collection('priceQuotes').doc(quoteDocId(link.code, e.key));
      const price = num(e.price);
      if (price == null) { batch.delete(ref); return; } // cleared = no bid on that product
      if (price < 0 || price > 1e7) throw new HttpsError('invalid-argument', 'One of the prices doesn’t look right.');
      const unit = UNITS.includes(e.unit) ? e.unit : 'gal';
      const d = num(e.discount);
      batch.set(ref, {
        productKey: e.key, season: round.season, seller: link.seller, price, unit,
        discount: d == null ? null : Math.max(0, Math.min(d, 100)) / 100,
        note: e.note ? String(e.note).slice(0, 500) : null, altProduct: e.alt ? String(e.alt).slice(0, 200) : null,
        source: 'Bid link', viaLink: link.code.slice(0, 10), roundId: link.roundId, submittedAt: now, updatedAt: now, updatedBy: `bid link: ${link.seller}`
      }, { merge: true });
      n++;
    });
    batch.update(db.collection(LINKS).doc(link.code), { submittedAt: now, count: n });
    await batch.commit();
    return Object.assign({ saved: n }, await portalView(db, Object.assign({}, link, { submittedAt: now }), round));
  }
  if (!link.openedAt) await db.collection(LINKS).doc(link.code).update({ openedAt: Date.now() });
  return portalView(db, link, round);
}

// Admin / Owner: make, list and turn off links for a round.
async function linkAdmin(db, me, data) {
  const a = data.action;
  if (a === 'list') {
    const snap = await db.collection(LINKS).where('roundId', '==', String(data.roundId || '')).get();
    const out = [];
    snap.forEach((d) => { const l = d.data(); if (!l.off) out.push({ code: d.id, seller: l.seller, email: l.email || null, contact: l.contact || null, at: l.at, openedAt: l.openedAt || null, submittedAt: l.submittedAt || null, count: l.count || 0 }); });
    return { links: out.sort((x, y) => String(x.seller).localeCompare(String(y.seller))) };
  }
  if (a === 'create') {
    const seller = String(data.seller || '').trim();
    if (!seller) throw new HttpsError('invalid-argument', 'Who is the link for?');
    const round = (await db.collection('bidRounds').doc(String(data.roundId || '')).get()).data();
    if (!round) throw new HttpsError('not-found', 'Save the bid round first.');
    const code = newCode();
    await db.collection(LINKS).doc(code).set({
      roundId: String(data.roundId), season: round.season, seller, email: data.email ? String(data.email).trim() : null,
      contact: data.contact ? String(data.contact).trim() : null, at: Date.now(), by: me.email || me.name || null
    });
    return { code };
  }
  if (a === 'off') {
    await db.collection(LINKS).doc(String(data.code || '')).update({ off: true, offAt: Date.now() });
    return { ok: true };
  }
  if (a === 'email') {
    await db.collection(LINKS).doc(String(data.code || '')).update({ email: data.email ? String(data.email).trim() : null, contact: data.contact ? String(data.contact).trim() : null });
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Unknown action.');
}

function makeExports() {
  // No sign-in: the link's code is the key. Callable functions work without a login.
  const bidPortal = onCall({ timeoutSeconds: 60 }, async (request) => portalCall(admin.firestore(), request.data || {}));
  const bidLinkAdmin = onCall({ timeoutSeconds: 60 }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = admin.firestore();
    const me = (await db.collection('users').doc(request.auth.uid).get()).data() || {};
    if (me.role !== 'admin' && me.role !== 'owner') throw new HttpsError('permission-denied', 'Admin or Owner only.');
    return linkAdmin(db, me, request.data || {});
  });
  return { bidPortal, bidLinkAdmin };
}

module.exports = { makeExports, _internal: { linkFor, portalView, portalCall, linkAdmin, quoteDocId, isOpen } };
