// =============================================================================
// Spray schedule — AgWorld sync (Spray module)
// =============================================================================
// Ported from the Google Apps Script spray schedule (Sync.gs), same rules:
//   * Only recs, work orders and actuals (planned activities are skipped).
//   * Ag Rows jobs must be labeled Ground Spraying / Ground Spreading in AgWorld
//     (operation or a cost line). Drone jobs are found by the drone words.
//     Chemigation / fertigation / fumigation / injection and the farm's own boom
//     sprayer are always left out.
//   * Rec -> work order -> actual are one job: AgWorld's parent_id link wins,
//     otherwise same fields + spray/spread at a later stage (an actual within
//     ACTUAL_MATCH_DAYS of the work order). Whatever people did in the app
//     (operator, done, moved, removed, flight log) follows the job to its new id.
//   * Finished jobs go into the Season log with AgWorld's acres, gallons, GPA
//     and the conditions recorded on the actual.
//   * A job removed in the app comes back by itself if AgWorld later changes
//     its fields or acres.
//
// Firestore (see firestore.rules — module 'spray'):
//   sprayJobs/{jobKey}        written ONLY by this sync: one doc per job on the schedule
//   sprayJobState/{jobKey}    written by the app (operator, done, moved, removed,
//                             flight) and by this sync (done rows from AgWorld).
//                             A job that leaves sprayJobs keeps its state doc, so
//                             the Season log and drone records keep their history.
//   sprayMeta/sync            last run times, saved AgWorld filter values, lock
//   spraySyncLog/{autoId}     one doc per run (counts, skips, errors)
//
// Functions:
//   syncSprayJobs        every hour: everything AgWorld changed since the last run
//   syncSprayJobsFull    every night 02:07: every job edited in the last ~13 months
//   syncSprayJobsNow     callable (Admin/Owner): run either one from the app
//   syncSprayJobsFullNow open the URL in a browser to run the full check now

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const TZ = 'America/Denver';

const SYNC = {
  BASE: 'https://us.agworld.co/user_api/v1',
  DUE_BACK_DAYS: 45,            // keep recent jobs so "done" and "past due" still show
  DUE_AHEAD_DAYS: 365,          // the whole season ahead, for planning
  FULL_UPDATED_BACK_DAYS: 400,  // nightly full check: anything edited in this window
  INCREMENTAL_OVERLAP_MIN: 90,  // hourly runs re-check a little before the last run
  TYPE_FILTER_TARGETS: ['RecommendedActivity', 'WorkOrder', 'ActualActivity'],
  TYPE_FILTER_CANDIDATES: ['RecommendedActivity', 'recommendation', 'recommended', 'Recommendation',
    'WorkOrder', 'workorder', 'work_order', 'WorkOrderActivity', 'ActualActivity', 'actual', 'Actual'],
  GROUND_SPRAY_LABELS: ['ground spraying'],
  GROUND_SPREAD_LABELS: ['ground spreading'],
  HOLD_UNLABELED: false,        // true = unlabeled spray/spread look-alikes wait for the admin to approve
  DRONE_WORDS: ['drone', 'drones', 'uav', 'uavs', 'agras', 'aerial'],
  ACTUAL_MATCH_DAYS: 3,
  PAGE_SIZE: 100,
  MAX_PAGES: 300,
  LOCK_MINUTES: 30
};

// Who wrote a done row. AgWorld refreshes its own rows and the app's one-tap "waiting on AgWorld" rows;
// anything else (typed in by hand) is never overwritten.
const AGWORLD_TAG = 'AgWorld';
const NO_REC_TAG = 'AgWorld (no rec or work order)';
const QUICK_DONE_TAG = 'App (waiting on AgWorld)';

// ---------------------------------------------------------------------------
// Dates (Idaho time)
// ---------------------------------------------------------------------------
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const ymdTZ = (d) => ymdFmt.format(d);
const today = () => ymdTZ(new Date());
function shiftYmd(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dueWindow() { const t = today(); return { from: shiftYmd(t, -SYNC.DUE_BACK_DAYS), to: shiftYmd(t, SYNC.DUE_AHEAD_DAYS) }; }

/** AgWorld due dates -> yyyy-MM-dd in Idaho time, without shifting a date-only value a day early. */
function dueYmd(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00))?$/);
  if (dateOnly) return dateOnly[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : ymdTZ(d);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
const round1 = (n) => Math.round(n * 10) / 10;
const extractNum = (v) => { const m = String(v == null ? '' : v).match(/([\d.]+)/); return m ? m[1] : ''; };
const normalizeFieldKey = (v) => String(v || '').toLowerCase().replace(/[\s\-_.]+/g, '').trim();
// Same name matching as the Farm Map module (mapMath.js mapKey): "Hawaii 07" = "HAWAII7".
const mapKey = (v) => String(v || '').replace(/\b0+(\d)/g, '$1').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pinUrl = (p) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(p.lat + ',' + p.lng);

function cleanName(txt) {
  if (!txt || typeof txt !== 'string') return '';
  let s = txt.replace(/\r\n/g, '\n').split('\n')[0].trim();
  s = s.replace(/^(manager|fm|farm manager|pic|crew)\s*[:\-]\s*/i, '').trim();
  if (s.length > 30 || !/^[A-Za-z][A-Za-z .'\-]*$/.test(s)) return '';
  return s;
}

/** The farm manager is the first line of the AgWorld comment. */
function managerFromActivity(a) {
  const singles = [a.comments, a.comment, a.notes, a.note];
  for (const s of singles) { const n = cleanName(s); if (n) return n; }
  for (const arr of [a.activity_comments, a.comments_list]) {
    if (!arr || !arr.length) continue;
    for (let k = arr.length - 1; k >= 0; k--) {
      const it = arr[k];
      const t = typeof it === 'string' ? it : (it && (it.body || it.comment || it.text || it.note)) || '';
      const n = cleanName(t);
      if (n) return n;
    }
  }
  return '';
}

function primaryCrop(fields) {
  const crops = {};
  fields.forEach((f) => { if (f && f.crops && f.crops.length && f.crops[0].crop_name) crops[String(f.crops[0].crop_name)] = true; });
  const k = Object.keys(crops);
  return k.length === 1 ? k[0] : k.length > 1 ? 'Mixed' : '';
}
const cleanCrop = (c) => (c ? String(c).split('-')[0].trim() : '');

function pdfLink(activity) {
  const a = activity.attributes || {};
  const v = a.updated_at ? encodeURIComponent(a.updated_at) : String(Date.now());
  return 'https://us.agworld.co/activities/' + activity.id + '.pdf?v=' + v;
}

/** EPA registration number anywhere on an AgWorld product line (looks like 100-1070 or 524-475-ZA). */
function epaFrom(i) {
  let found = '';
  const look = (o, depth) => {
    if (!o || typeof o !== 'object' || found || depth > 2) return;
    Object.keys(o).forEach((k) => {
      if (found) return;
      const v = o[k];
      if (/epa|registration|reg_?no/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        const m = String(v).match(/\b\d{1,7}-\d{1,7}(-[A-Za-z0-9]+)?\b/);
        if (m) found = m[0];
      } else if (typeof v === 'object') look(v, depth + 1);
    });
  };
  look(i, 0);
  return found;
}

// ---------------------------------------------------------------------------
// Which activities are spray / spread jobs
// ---------------------------------------------------------------------------
// AgWorld lifecycle: planned -> rec -> work order -> actual (each step is a new activity id).
const STAGE_RANK = { PlannedActivity: 0, RecommendedActivity: 1, WorkOrder: 2, WorkOrderActivity: 2, ActualActivity: 3 };
const stageRank = (r) => { const x = STAGE_RANK[r.activity_type]; return x == null ? 1 : x; };
const sameStage = (a, b) => STAGE_RANK[a] != null && STAGE_RANK[a] === STAGE_RANK[b];

function isRecOrWorkOrder(a) {
  const t = String(a.activity_type || '');
  if (t === 'PlannedActivity') return false;
  if (STAGE_RANK[t] >= 1) return true;
  const blob = [t, a.job_type, a.record_type, a.kind].map((x) => String(x || '').toLowerCase()).join(' ');
  if (a.is_recommendation === true) return true;
  return /recommendation|work ?order/.test(blob);
}

function statusText(a) {
  return [a.activity_status, a.job_status, a.workflow_status, a.workflow_state, a.state,
    a.status_name, a.lifecycle_status, a.status]
    .map((x) => String(x || '').toLowerCase().replace(/_/g, ' ')).join(' ');   // closed_discarded -> closed discarded
}

/** Status fields and flags only — never title or notes, so "avoid the ditch" doesn't kill a job. */
function isCancelled(a) {
  if (a.discarded === true || a.discarded_at || a.archived === true || a.archived_at ||
      a.deleted === true || a.deleted_at || a.cancelled === true || a.canceled === true ||
      a.cancelled_at || a.canceled_at) return true;
  return /\b(cancell?ed|cancel|discard(ed)?|archived|void(ed)?|abandoned|deleted|trash(ed)?|inactive)\b/.test(statusText(a));
}

/** The job's operation plus the names of its cost lines ("Spread and Spray - Ground Spraying"), lowercased. */
function jobLabels(a) {
  const costs = (a.activity_inputs || []).filter((i) => i && /cost/i.test(String(i.input_type || '')))
    .map((i) => String(i.input_name || i.name || ''));
  return [a.operation, a.operation_name, a.activity_category, a.application_method].concat(costs)
    .map((x) => String(x || '').toLowerCase()).join(' | ');
}

function classText(a) {
  const inputs = (a.activity_inputs || []).map((inp) => {
    inp = inp || {};
    const cats = Array.isArray(inp.product_categories) ? inp.product_categories.join(' ') : String(inp.product_categories || '');
    return [inp.input_name || inp.name, cats, inp.rate || inp.application_rate, inp.rate_unit, inp.unit, inp.per_unit || inp.per].join(' ');
  }).join(' ');
  const assets = (a.farm_assets || []).map((fa) => (fa && ((fa.name || '') + ' ' + (fa.category || ''))) || '').join(' ');
  return [a.title, a.application_method, a.activity_category, a.operation, a.specialisation,
    (a.tags || []).join(' '), inputs, assets].map((x) => String(x || '')).join(' ').toLowerCase();
}

function formFromRates(a) {
  let liquid = false, dry = false;
  (a.activity_inputs || []).forEach((inp) => {
    inp = inp || {};
    const blob = [inp.input_name || inp.name, inp.rate || inp.application_rate, inp.rate_unit, inp.unit, inp.per_unit || inp.per].join(' ');
    if (/(\bgals?\b|\bgallons?\b|\bgpa\b|\bqts?\b|\bpts?\b|\bl\/ac(re)?\b|\bl\/ha\b|\bml\b|\bfl ?oz\b)/i.test(blob)) liquid = true;
    if (/(\blbs?\b|\bpounds?\b|#\/ac|#\/acre|\btons?\b|\bkg\b)/i.test(blob)) dry = true;
  });
  if (liquid && !dry) return 'liquid';
  if (dry && !liquid) return 'dry';
  return null;
}

/** { source: 'drone'|'ground', type: 'Spray'|'Spread' } or { reason }. */
function classifyJob(a) {
  const text = classText(a);
  const labels = jobLabels(a);
  if (/chemigation|fertigation|fumigation|inject/.test(labels + ' ' + String(a.title || '').toLowerCase())) {
    return { reason: 'chemigation / fumigation / injection' };
  }
  const droneRe = new RegExp('\\b(' + SYNC.DRONE_WORDS.join('|') + ')\\b');
  if (droneRe.test(text)) {
    const form = formFromRates(a);
    const spread = form === 'dry' || (/\b(spread|spreading|seed|seeding)\b/.test(text) && !/\b(spray|spraying)\b/.test(text));
    return { source: 'drone', type: spread ? 'Spread' : 'Spray' };
  }
  if (/boom ?spray|tractor sprayer/.test(labels)) return { reason: 'farm boom sprayer (not Ag Rows)' };
  if (SYNC.GROUND_SPRAY_LABELS.some((l) => labels.indexOf(l) > -1)) return { source: 'ground', type: 'Spray' };
  if (SYNC.GROUND_SPREAD_LABELS.some((l) => labels.indexOf(l) > -1)) return { source: 'ground', type: 'Spread' };
  return { reason: 'not labeled Ground Spraying, Ground Spreading or drone' };
}

/** Loose guess from product units and words, only for unlabeled jobs. */
function looseGuess(a) {
  const text = classText(a), form = formFromRates(a);
  if (form === 'dry') return 'Spread';
  if (form === 'liquid') return 'Spray';
  const spreadWord = /\b(spread|spreading|spreader|fert|fertilizer|fertiliser|npk|urea|lime|gypsum|manure|compost)\b/.test(text);
  const sprayWord = /\b(spray|spraying|herbicide|fungicide|insecticide|pgr|roundup|glyphosate|chem|application)\b/.test(text);
  if (sprayWord && !spreadWord) return 'Spray';
  if (spreadWord && !sprayWord) return 'Spread';
  if (sprayWord && spreadWord && /\b(glyphosate|roundup|herbicide|fungicide|insecticide|spraying)\b/.test(text)) return 'Spray';
  return null;
}

/** Weather AgWorld recorded on the actual, in mph and °F: "6 mph E · 38°F · 85% humidity". */
function appliedConditions(a) {
  const parts = [];
  const ws = String(a.wind_speed == null ? '' : a.wind_speed), wn = parseFloat(ws);
  if (isFinite(wn)) {
    const mph = /km/i.test(ws) ? wn * 0.621371 : /m\/s/i.test(ws) ? wn * 2.23694 : wn;
    parts.push(Math.round(mph) + ' mph' + (a.wind_direction ? ' ' + a.wind_direction : ''));
  } else if (a.wind_direction) parts.push('wind ' + a.wind_direction);
  const ts = String(a.temperature == null ? '' : a.temperature), tn = parseFloat(ts);
  if (isFinite(tn)) parts.push(Math.round(/C/.test(ts) && !/F/.test(ts) ? tn * 9 / 5 + 32 : tn) + '°F');
  const hn = parseFloat(a.humidity);
  if (isFinite(hn)) parts.push(Math.round(hn) + '% humidity');
  if (a.weather_conditions) parts.push(String(a.weather_conditions));
  return parts.join(' · ');
}

/** Gallons for an AgWorld activity -> { gallons, gpa, how } or null.
 *  Confirmed on JK Farms actuals: total_volume ("1330 gal") and water_rate ("10 gal/acre"). */
function gallonsFromActivity(a, acres) {
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const pick = (o, ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const isGal = (u) => /gal/i.test(String(u || ''));
  const isPerAc = (u) => /(\/|per)\s*(ac|acre)|gpa|\/a\b/i.test(String(u || ''));
  const out = (gal, gpa, how) => ({ gallons: Math.round(gal * 10) / 10, gpa: Math.round(gpa * 100) / 100, how });
  const tv = num(a.total_volume);
  if (tv && isGal(a.total_volume)) return out(tv, acres ? tv / acres : 0, 'total_volume');
  const wr = num(a.water_rate);
  if (wr && isGal(a.water_rate)) return out(wr * (acres || 0), wr, 'water_rate');
  const keys = Object.keys(a).filter((k) => /(spray|water|carrier|application|tank|total)_?(volume|rate|gallons)|^(volume|gallons)$/i.test(k));
  for (const k of keys) {
    const v = a[k];
    const n = v && typeof v === 'object' ? num(pick(v, ['value', 'amount', 'rate', 'quantity'])) : num(v);
    if (n == null || n <= 0) continue;
    const unit = (v && typeof v === 'object' ? pick(v, ['unit', 'units', 'rate_unit']) : '') ||
      a[k + '_unit'] || a[k.replace(/_?(volume|rate|gallons)$/i, '') + '_unit'] || '';
    if (isPerAc(unit) || /rate/i.test(k)) return out(n * (acres || 0), n, k + ' (per acre)');
    if (isGal(unit) || /volume|gallons/i.test(k)) return out(n, acres ? n / acres : 0, k + ' (total)');
  }
  const inputs = a.activity_inputs || [];
  for (const inp0 of inputs) {
    const inp = inp0 || {};
    if (!/water|carrier/i.test(String(inp.input_name || inp.name || ''))) continue;
    const unit = [inp.rate_unit, inp.unit, inp.per_unit || inp.per].join(' ');
    const rate = num(pick(inp, ['rate', 'application_rate']));
    const tot = num(pick(inp, ['total_quantity', 'total', 'quantity', 'total_amount']));
    if (tot && isGal(pick(inp, ['total_unit', 'unit', 'rate_unit']))) return out(tot, acres ? tot / acres : 0, 'water input total');
    if (rate && isGal(unit)) return out(rate * (acres || 0), rate, 'water input rate');
  }
  let sum = 0, any = false;
  inputs.forEach((inp0) => {
    const inp = inp0 || {};
    const tot = num(pick(inp, ['total_quantity', 'total', 'quantity', 'total_amount']));
    if (tot && isGal(pick(inp, ['total_unit', 'unit', 'rate_unit']))) { sum += tot; any = true; }
  });
  if (any) return out(sum, acres ? sum / acres : 0, 'sum of inputs in gallons');
  return null;
}

/** One AgWorld activity -> { row } for the schedule, or { reason } it was left out. */
function evaluateActivity(activity, pins, window) {
  const a = activity.attributes || {};
  const id = String(activity.id);
  if (!isRecOrWorkOrder(a)) return { reason: 'not a rec or work order' };
  if (isCancelled(a)) return { reason: 'cancelled / discarded' };

  const isActual = String(a.activity_type || '') === 'ActualActivity';
  // An actual is dated by when the work was done; recs and work orders by their due date.
  const due = dueYmd(isActual ? (a.completed_at || a.started_at || a.due_at) : a.due_at);
  if (!due) return { reason: 'no due date' };
  if (due < window.from || due > window.to) return { reason: 'due date outside window' };

  let cls = classifyJob(a);
  let needsReview = false;
  if (!cls.source && /not labeled/.test(cls.reason)) {
    const guess = looseGuess(a);
    if (guess) { cls = { source: 'ground', type: guess }; needsReview = SYNC.HOLD_UNLABELED; }
  }
  if (!cls.source) return { reason: cls.reason };

  const fields = (a.activity_fields || []).map((f) => {
    const name = String((f && f.field_name) || '').trim();
    // 1) AgWorld's own outline for that field id, 2) the AIO Farm Map outline with that name,
    // 3) an AgWorld outline whose field has that name
    const pin = (f && f.field_id != null && pins.byId[String(f.field_id)]) || (pins.byMap && pins.byMap[mapKey(name)]) ||
      pins.byName[normalizeFieldKey(name)] || null;
    return {
      name: name || 'Unknown field',
      field_id: f && f.field_id != null ? String(f.field_id) : '',
      farm: String((f && (f.farm_name || f.farm)) || ''),
      acres: round1(parseFloat(extractNum(f && f.area)) || 0),
      lat: pin ? pin.lat : null, lng: pin ? pin.lng : null,
      pin: pin ? pinUrl(pin) : ''
    };
  });
  const acres = fields.length ? round1(fields.reduce((s, f) => s + f.acres, 0)) : round1(parseFloat(extractNum(a.area)) || 0);
  const firstPinned = fields.find((f) => f.lat != null);

  const prods = (a.activity_inputs || []).filter((i) => i && String(i.input_type || 'Product') === 'Product');
  const productNames = uniq(prods.map((i) => String(i.input_name || i.name || '').trim()).filter(Boolean));
  const productDetail = prods.map((i) => ({
    name: String(i.input_name || i.name || '').trim(),
    rate: String(i.rate || i.application_rate || '').trim(),
    total: String(i.total_quantity || i.total_amount || i.quantity || '').trim(),
    epa: epaFrom(i)
  })).filter((p) => p.name);
  const productTypes = uniq([].concat(...prods.map((i) => (Array.isArray(i.product_categories) ? i.product_categories : []))).map(String).filter(Boolean));
  const farms = uniq(fields.map((f) => f.farm).filter(Boolean));
  const fieldLabel = fields.length === 0 ? 'Unknown field'
    : fields.length === 1 ? fields[0].name
    : fields.length + ' fields: ' + fields.map((f) => f.name).join(', ');

  const completed = isActual || a.completed === true || /\b(done|complete|completed|closed fully)\b/.test(statusText(a));
  const ops = (a.operator_users || []).map((u) => String((u && u.name) || '').trim()).filter(Boolean);
  const parent = Number(a.parent_id) > 0 ? String(a.parent_id) : '';   // AgWorld sends -1 for "no link"
  const gal = gallonsFromActivity(a, acres);

  return {
    row: {
      job_key: id,
      source: cls.source,
      agworld_id: id,
      activity_type: String(a.activity_type || ''),
      farm: farms.join(', ') || String(a.farm_name || ''),
      manager: managerFromActivity(a),
      manager_agworld: managerFromActivity(a),
      field: fieldLabel,
      fields,
      crop: cleanCrop(primaryCrop(a.activity_fields || [])),
      job_type: cls.type,
      planned_date: due,
      acres,
      pin_url: firstPinned ? firstPinned.pin : '',
      lat: firstPinned ? firstPinned.lat : null,
      lng: firstPinned ? firstPinned.lng : null,
      agworld_link: pdfLink(activity),
      agworld_page: 'https://us.agworld.co/job_management/activities/' + id,
      agworld_status: completed ? 'completed' : 'open',
      title: String(a.title || ''),
      products: productNames.join(', '),
      product_types: productTypes.join(', '),
      product_detail: productDetail,
      updated_at: String(a.updated_at || ''),
      parent_id: parent,
      needs_review: needsReview,
      labels: jobLabels(a),
      agworld_operator: ops.join(', '),
      agworld_operator_company: String(a.operator_company_name || ''),
      agworld_done_date: completed ? (dueYmd(a.completed_at) || due) : '',
      agworld_gallons: gal ? gal.gallons : null,
      agworld_gpa: gal ? gal.gpa : null,
      job_id: a.job_id ? String(a.job_id) : '',
      applied_conditions: isActual ? appliedConditions(a) : '',
      closes_job: ''
    }
  };
}

// ---------------------------------------------------------------------------
// Rec -> work order -> actual: one job
// ---------------------------------------------------------------------------
function fingerprint(r) {
  const names = (r.fields && r.fields.length ? r.fields.map((f) => f.name) : [r.field]);
  return [r.source, r.job_type, r.planned_date, names.map(normalizeFieldKey).sort().join('+')].join('|');
}

/** Returns { rows, moves: {oldKey: newKey}, orphans: [actuals with nothing scheduled behind them] }. */
function collapseStages(rows) {
  const out = Object.assign({}, rows), moves = {};
  // 1) AgWorld's own "converted from" link
  Object.keys(rows).forEach((k) => {
    const r = rows[k], p = String(r.parent_id || '');
    if (p && p !== k && out[p] && stageRank(r) >= stageRank(out[p])) { moves[p] = k; delete out[p]; }
  });
  // 2) same fields + day + spray/spread at different stages
  const byFp = {};
  Object.keys(out).forEach((k) => { const fp = fingerprint(out[k]); (byFp[fp] = byFp[fp] || []).push(out[k]); });
  Object.keys(byFp).forEach((fp) => {
    const g = byFp[fp];
    const ranks = uniq(g.map(stageRank)).sort((x, y) => y - x);
    if (ranks.length < 2) return;
    const top = g.filter((r) => stageRank(r) === ranks[0]);
    ranks.slice(1).forEach((rk) => {
      g.filter((r) => stageRank(r) === rk).forEach((r, i) => {
        const h = top.find((t) => t.parent_id && t.parent_id === r.job_key) || top[Math.min(i, top.length - 1)];
        moves[r.job_key] = h.job_key; delete out[r.job_key];
      });
    });
  });
  // 3) an actual a few days off the work order's date, same fields + spray/spread (or same AgWorld job id)
  const looseFp = (r) => fingerprint(r).split('|').filter((x, i) => i !== 2).join('|');
  const dayNum = (s) => Math.round(new Date(String(s) + 'T12:00:00Z').getTime() / 86400000);
  Object.keys(out).filter((k) => out[k] && stageRank(out[k]) === 3).forEach((k) => {
    const act = out[k], fp = looseFp(act);
    const cands = Object.keys(out).map((x) => out[x]).filter((r) => r && r.job_key !== k && stageRank(r) < 3 &&
      looseFp(r) === fp && (Math.abs(dayNum(r.agworld_done_date || r.planned_date) - dayNum(act.planned_date)) <= SYNC.ACTUAL_MATCH_DAYS ||
        (act.job_id && String(act.job_id) === String(r.job_id || ''))))
      .sort((x, y) => Math.abs(dayNum(x.planned_date) - dayNum(act.planned_date)) - Math.abs(dayNum(y.planned_date) - dayNum(act.planned_date)));
    if (cands.length) { moves[cands[0].job_key] = k; delete out[cands[0].job_key]; }
  });
  // follow chains (rec -> work order -> actual) to the final job
  Object.keys(moves).forEach((k) => { let t = moves[k], n = 0; while (moves[t] && n++ < 10) t = moves[t]; moves[k] = t; });
  // An actual remembers which job it closed (closes_job) so later runs keep it even when the work order
  // isn't fetched again. An actual with nothing scheduled behind it goes to the Season log only.
  const closed = {};
  Object.keys(moves).forEach((k) => { const t = moves[k]; (closed[t] = closed[t] || []).push(k); });
  const orphans = [];
  Object.keys(out).forEach((k) => {
    const r = out[k];
    if (stageRank(r) !== 3) return;
    if (closed[k]) r.closes_job = uniq(String(r.closes_job || '').split(',').filter(Boolean).concat(closed[k])).join(',');
    if (!r.closes_job) { orphans.push(r); delete out[k]; }
  });
  return { rows: out, moves, orphans };
}

/** A job that vanished and a new one that names it as parent, or has the same field/day/type, is the same job. */
function matchMoves(existing, next, removedKeys, addedKeys) {
  const moves = {};
  const removedByFp = {};
  removedKeys.forEach((k) => { const fp = fingerprint(existing[k]); (removedByFp[fp] = removedByFp[fp] || []).push(k); });
  addedKeys.forEach((k) => {
    const r = next[k];
    if (r.parent_id && existing[r.parent_id] && removedKeys.indexOf(r.parent_id) > -1) { moves[r.parent_id] = k; return; }
    const cands = removedByFp[fingerprint(r)];
    if (cands && cands.length === 1 && !moves[cands[0]]) moves[cands[0]] = k;
  });
  return moves;
}

/** Season log row from AgWorld, or null if the existing one shouldn't change. */
function doneFromAgworld(existingDone, r, tag, operator, notes) {
  if (existingDone && !String(existingDone.entered_by || '').startsWith('AgWorld') && existingDone.entered_by !== QUICK_DONE_TAG) return null;
  const row = {
    completed_date: r.agworld_done_date || r.planned_date, acres_done: r.acres,
    gallons: r.agworld_gallons, gpa: r.agworld_gpa, operator: operator || '', notes: notes || '',
    source: r.source, job_type: r.job_type, manager: r.manager, farm: r.farm, field: r.field, crop: r.crop,
    planned_date: tag === NO_REC_TAG ? '' : r.planned_date, agworld_link: r.agworld_link,
    entered_by: tag, conditions: r.applied_conditions || '', products: r.products || '', product_detail: r.product_detail || []
  };
  if (existingDone) {
    const keys = ['completed_date', 'acres_done', 'gallons', 'gpa', 'operator', 'field', 'manager', 'conditions', 'entered_by', 'products'];
    const same = keys.every((c) => String(existingDone[c] == null ? '' : existingDone[c]) === String(row[c] == null ? '' : row[c]));
    if (same) return null;
  }
  return row;
}

/** A removed job whose fields or acres changed in AgWorld is a different job now: show it again. */
function hiddenStillValid(hidden, job) {
  if (!hidden || !job) return true;
  const same = (a, b) => String(a || '').toLowerCase().replace(/\s+/g, ' ').trim() === String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const fieldChanged = String(hidden.field || '') !== '' && !same(hidden.field, job.field);
  const acresChanged = hidden.acres != null && hidden.acres !== '' && Math.abs(Number(hidden.acres) - Number(job.acres)) > 0.5;
  return !(fieldChanged || acresChanged);
}

// ---------------------------------------------------------------------------
// AgWorld fetch
// ---------------------------------------------------------------------------
function listUrl(sinceIso, typeFilter, page) {
  const p = new URLSearchParams();
  p.set('filter[updated_at]', sinceIso);
  if (typeFilter) p.set('filter[activity_type]', typeFilter);
  p.set('page[size]', String(SYNC.PAGE_SIZE));
  p.set('page[number]', String(page));
  return SYNC.BASE + '/activities?' + p.toString();
}

async function fetchJsonWithRetry(url, token, fetchImpl) {
  const f = fetchImpl || fetch;
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await f(url, { headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', 'Api-Token': token } });
      if (res.ok) return await res.json();
      last = new Error('AgWorld ' + res.status + ': ' + String(await res.text()).slice(0, 200));
      if (res.status < 500 && res.status !== 429) throw last;
    } catch (e) { last = e; if (/AgWorld 4\d\d/.test(String(e.message)) && !/429/.test(String(e.message))) throw e; }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw last;
}

/** Work out which filter[activity_type] values AgWorld honors ({value: type}), or 'OFF'. */
async function detectTypeFilters(token, sinceIso, fetchImpl) {
  const map = {}, found = {};
  for (const v of SYNC.TYPE_FILTER_CANDIDATES) {
    const target = SYNC.TYPE_FILTER_TARGETS.filter((t) => !found[t]);
    if (!target.length) break;
    const data = (await fetchJsonWithRetry(listUrl(sinceIso, v, 1), token, fetchImpl)).data || [];
    const types = uniq(data.map((a) => String((a.attributes || {}).activity_type || '')));
    if (types.length !== 1) continue;
    const t = SYNC.TYPE_FILTER_TARGETS.find((x) => sameStage(x, types[0]));
    if (t && !found[t]) { map[v] = types[0]; found[t] = true; }
  }
  return SYNC.TYPE_FILTER_TARGETS.every((t) => found[t]) ? map : 'OFF';
}

/** Every activity edited since `sinceIso`. Uses the type filters when they're trusted;
 *  if a filtered page comes back with the wrong types (or empty on a full check), fetches everything. */
async function fetchActivities(token, sinceIso, filterMap, isFull, fetchImpl) {
  let filters = filterMap && filterMap !== 'OFF' ? Object.keys(filterMap) : [];
  let filtersFailed = false;
  for (;;) {
    const all = [];
    let redo = false;
    for (let fi = 0; fi < (filters.length || 1) && !redo; fi++) {
      const tf = filters.length ? filters[fi] : null;
      for (let page = 1; page <= SYNC.MAX_PAGES; page++) {
        const data = (await fetchJsonWithRetry(listUrl(sinceIso, tf, page), token, fetchImpl)).data || [];
        if (tf && page === 1) {
          const bad = data.some((a) => !sameStage(String((a.attributes || {}).activity_type || ''), filterMap[tf]));
          if (bad || (isFull && data.length === 0)) { redo = true; break; }
        }
        all.push(...data);
        if (data.length < SYNC.PAGE_SIZE) break;
        if (page === SYNC.MAX_PAGES) throw new Error('More than ' + SYNC.MAX_PAGES + ' pages of AgWorld activities.');
      }
    }
    if (!redo) return { activities: all, filtersFailed };
    filters = []; filtersFailed = true;
  }
}

// ---------------------------------------------------------------------------
// Field pins from AIO's own field data (no more map sheet)
// ---------------------------------------------------------------------------
function ringCenter(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let x = 0, y = 0, n = 0;
  ring.forEach((p) => { if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) { x += Number(p[0]); y += Number(p[1]); n++; } });
  return n ? { lat: Math.round((y / n) * 1e6) / 1e6, lng: Math.round((x / n) * 1e6) / 1e6 } : null;
}

async function loadPins(db) {
  const byId = {}, byName = {}, byMap = {};
  const [bSnap, fSnap, mSnap] = await Promise.all([db.collection('fieldBoundaries').get(), db.collection('fields').get(),
    db.collection('farmFields').get().catch(() => ({ forEach: () => {} }))]);
  // AIO Farm Map outlines: rings [{ c: [lng, lat, lng, lat, ...], hole }]
  mSnap.forEach((d) => {
    const f = d.data() || {};
    if (!f.name || (f.kind && f.kind !== 'field')) return;
    const ring = (f.rings || []).find((r) => r && !r.hole && Array.isArray(r.c));
    if (!ring) return;
    const pts = [];
    for (let i = 0; i + 1 < ring.c.length; i += 2) pts.push([ring.c[i], ring.c[i + 1]]);
    const c = ringCenter(pts);
    if (c && !byMap[mapKey(f.name)]) byMap[mapKey(f.name)] = c;
  });
  bSnap.forEach((d) => {
    let ring = null;
    try { ring = JSON.parse(d.data().boundary || 'null'); } catch (e) { ring = null; }
    const c = ringCenter(ring);
    if (c) byId[d.id] = c;
  });
  fSnap.forEach((d) => {
    const f = d.data() || {};
    if (f.name && byId[d.id]) byName[normalizeFieldKey(f.name)] = byId[d.id];
  });
  return { byId, byName, byMap };
}

// ---------------------------------------------------------------------------
// Farm managers from the Spray module's Managers tab (functions/sprayContacts.js).
// AIO's Users list isn't used, so outside AIO logins never become a job's manager.
// ---------------------------------------------------------------------------
const personKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const { loadPeopleFromContacts: loadPeople } = require('./sprayContacts');
const alerts = require('./sprayAlerts');

/** The job's farm manager: the AgWorld comment first, otherwise the Spray Managers-tab person whose
 *  farms include the job's farm. Adds manager_phone (Managers tab) so everyone gets the Call button. */
function withManager(r, people) {
  const fromAg = r.manager_agworld !== undefined ? String(r.manager_agworld || '') : String(r.manager || '');
  let m = fromAg;
  if (!m) {
    const farms = String(r.farm || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const f of farms) { const l = people.byFarm[mapKey(f)]; if (l && l.length) { m = l[0]; break; } }
  }
  return Object.assign({}, r, {
    manager_agworld: fromAg, manager: m || '',
    manager_from: fromAg ? 'agworld' : (m ? 'sheet' : ''),
    manager_phone: m ? (people.phoneByName[personKey(m)] || '') : ''
  });
}

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------
const STATE = 'sprayJobState', JOBS = 'sprayJobs';

async function readAll(db, coll) {
  const out = {};
  (await db.collection(coll).get()).forEach((d) => { out[d.id] = d.data(); });
  return out;
}

/** Firestore batches top out at 500 writes; commit in chunks. ops: [{ref, data|null, merge}] */
async function commitOps(db, ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    ops.slice(i, i + 400).forEach((o) => {
      if (o.data === null) b.delete(o.ref);
      else b.set(o.ref, o.data, o.merge ? { merge: true } : undefined);
    });
    await b.commit();
  }
}

/** mode 'hourly' | 'full'. deps lets tests swap in a fake Firestore / AgWorld. */
async function runSync(mode, token, deps = {}) {
  const db = deps.db || admin.firestore();
  const fetchImpl = deps.fetch;
  const now = Date.now();
  const stats = { mode, fetched: 0, kept: 0, added: 0, updated: 0, removed: 0, migrated: 0, logged: 0, loggedNoRec: 0, released: 0, skipped: {} };
  const metaRef = db.collection('sprayMeta').doc('sync');
  const meta = (await metaRef.get()).data() || {};
  if (meta.running && now - meta.running < SYNC.LOCK_MINUTES * 60000) return { skipped: 'another sync is running' };
  await metaRef.set({ running: now }, { merge: true });

  try {
    const [pins, people] = await Promise.all([loadPins(db), loadPeople(db)]);
    const window = dueWindow();
    const isFull = mode === 'full';
    const sinceMs = isFull ? now - SYNC.FULL_UPDATED_BACK_DAYS * 86400000
      : (meta.lastOk || now - 2 * 86400000) - SYNC.INCREMENTAL_OVERLAP_MIN * 60000;
    const sinceIso = new Date(sinceMs).toISOString();

    let filterMap = meta.typeFilters || null;
    if (isFull && !filterMap) filterMap = await detectTypeFilters(token, sinceIso, fetchImpl);
    const got = await fetchActivities(token, sinceIso, filterMap, isFull, fetchImpl);
    if (got.filtersFailed) filterMap = null;          // work them out again on the next full check
    stats.fetched = got.activities.length;

    const fresh = {}, outOfScope = {};
    got.activities.forEach((act) => {
      const r = evaluateActivity(act, pins, window);
      if (r.row) fresh[r.row.job_key] = r.row;
      else { outOfScope[String(act.id)] = r.reason; stats.skipped[r.reason] = (stats.skipped[r.reason] || 0) + 1; }
    });

    const existing = await readAll(db, JOBS);
    let next;
    if (isFull) {
      next = Object.assign({}, fresh);
      // A job the full check didn't see gets one more chance before it's dropped (AgWorld hiccups).
      Object.keys(existing).forEach((k) => {
        if (next[k] || outOfScope[k]) return;
        const r = existing[k], d = String(r.planned_date || '');
        if (d < window.from || d > window.to) return;
        if (Number(r.missed_full || 0) >= 1) return;
        next[k] = Object.assign({}, r, { missed_full: 1 });
      });
    } else {
      next = Object.assign({}, existing);
      Object.keys(outOfScope).forEach((id) => { delete next[id]; });
      Object.keys(fresh).forEach((id) => { next[id] = fresh[id]; });
      Object.keys(next).forEach((id) => {
        const d = String(next[id].planned_date || '');
        if (d && (d < window.from || d > window.to)) delete next[id];
      });
    }
    Object.keys(next).forEach((k) => {
      if (existing[k] && existing[k].closes_job && !next[k].closes_job) next[k].closes_job = existing[k].closes_job;
    });

    const collapsed = collapseStages(next);
    next = collapsed.rows;
    Object.keys(next).forEach((k) => { next[k] = withManager(next[k], people); });
    collapsed.orphans = collapsed.orphans.map((r) => withManager(r, people));
    if (collapsed.orphans.length) stats.skipped['actual with no rec or work order (season log only)'] = collapsed.orphans.length;
    const wrongKind = Object.keys(outOfScope).filter((k) => /not labeled|chemigation|boom sprayer|cancel/.test(String(outOfScope[k])));

    const removedKeys = Object.keys(existing).filter((k) => !next[k]);
    const addedKeys = Object.keys(next).filter((k) => !existing[k]);
    stats.removed = removedKeys.length; stats.added = addedKeys.length;
    stats.updated = Object.keys(next).length - addedKeys.length; stats.kept = Object.keys(next).length;
    const moves = Object.assign({}, collapsed.moves, matchMoves(existing, next, removedKeys, addedKeys));

    // App state follows the job to its new id (operator, done, moved, removed, flight log).
    const state = await readAll(db, STATE);
    const ops = [];
    Object.keys(moves).forEach((from) => {
      const to = moves[from];
      if (!state[from] || state[to] || from === to) return;
      state[to] = Object.assign({}, state[from], { moved_from: from });
      delete state[from];
      ops.push({ ref: db.collection(STATE).doc(to), data: state[to] });
      ops.push({ ref: db.collection(STATE).doc(from), data: null });
      stats.migrated++;
    });

    // Season log rows from AgWorld
    const newlyDone = [];   // jobs that were on the schedule and just got closed in AgWorld: phone alert
    const groundDone = [];  // Ag Rows jobs closed in AgWorld: kept as permanent records (sprayRecords.saveAgworldGround)
    const droneNoLog = [];  // drone jobs closed in AgWorld with no flight log: kept until it's added (sprayRecords.keepUnlogged)
    Object.keys(next).forEach((k) => {
      const r = next[k];
      if (r.agworld_status !== 'completed' || r.needs_review) return;
      const st = state[k] || {};
      const op = (st.assign && st.assign.operator) || '';
      const row = doneFromAgworld(st.done, r, AGWORLD_TAG, op, '');
      const doneNow = row || st.done;
      if (r.source !== 'drone' && doneNow && String(doneNow.entered_by || '').startsWith('AgWorld')) groundDone.push({ k, job: r, done: doneNow, operator: op });
      if (r.source === 'drone' && doneNow && !doneNow.flight_id && String(doneNow.entered_by || '').startsWith('AgWorld')) droneNoLog.push({ k, job: r, done: doneNow });
      if (!row) return;
      // Only a job already on the schedule, not done in the app already, finished in the last 2 days
      // (so the first full check never alerts for the whole season).
      const wasScheduled = existing[k] || Object.keys(moves).some((f) => moves[f] === k && existing[f]) ||
        String(r.closes_job || '').split(',').some((x) => x && existing[x.trim()]);
      if (!st.done && wasScheduled && String(row.completed_date || '') >= shiftYmd(today(), -2)) newlyDone.push({ k, r, row });
      state[k] = Object.assign({}, st, { done: Object.assign({}, row, { entered_at: new Date(now).toISOString() }) });
      ops.push({ ref: db.collection(STATE).doc(k), data: { done: state[k].done }, merge: true });
      stats.logged++;
    });
    collapsed.orphans.forEach((r) => {
      if (r.needs_review) return;
      const st = state[r.job_key] || {};
      const row = doneFromAgworld(st.done, r, NO_REC_TAG, '', r.title || '');
      if (!row) return;
      ops.push({ ref: db.collection(STATE).doc(r.job_key), data: { done: Object.assign({}, row, { entered_at: new Date(now).toISOString() }) }, merge: true });
      stats.loggedNoRec++;
    });
    // AgWorld rows for jobs that turned out not to be spray/spread come back out of the Season log
    wrongKind.forEach((k) => {
      const st = state[k];
      if (st && st.done && String(st.done.entered_by || '').startsWith('AgWorld')) {
        ops.push({ ref: db.collection(STATE).doc(k), data: { done: admin.firestore.FieldValue.delete() }, merge: true });
      }
    });
    // Removed in the app, then changed in AgWorld: back on the schedule
    Object.keys(next).forEach((k) => {
      const st = state[k];
      if (st && st.hidden && !hiddenStillValid(st.hidden, next[k])) {
        ops.push({ ref: db.collection(STATE).doc(k), data: { hidden: admin.firestore.FieldValue.delete(), hidden_released: { at: new Date(now).toISOString(), was: st.hidden.field || '', now: next[k].field } }, merge: true });
        stats.released++;
      }
    });

    // The jobs themselves: write new/changed, delete gone
    Object.keys(next).forEach((k) => {
      const r = next[k];
      const old = existing[k];
      if (old && JSON.stringify(stripVolatile(old)) === JSON.stringify(stripVolatile(r))) return;
      ops.push({ ref: db.collection(JOBS).doc(k), data: Object.assign({}, r, { synced_at: new Date(now).toISOString() }) });
    });
    removedKeys.forEach((k) => ops.push({ ref: db.collection(JOBS).doc(k), data: null }));

    await commitOps(db, ops);
    for (const n of newlyDone) await alerts.queueDoneAlert(db, n.k, n.r, n.row, 'agworld');
    // Ag Rows jobs closed only in AgWorld: save a permanent record now, before the job ages off the schedule
    stats.groundSaved = await require('./sprayRecords').saveAgworldGround(db, groundDone);
    stats.noLogKept = await require('./sprayRecords').keepUnlogged(db, droneNoLog);
    stats.alerted = newlyDone.length;

    const metaOut = { running: 0, lastOk: now, typeFilters: filterMap || null };
    if (isFull) metaOut.lastFull = now;
    await metaRef.set(metaOut, { merge: true });
    await db.collection('spraySyncLog').add(Object.assign({ at: new Date(now).toISOString(), ms: Date.now() - now, error: '' }, stats));
    return stats;
  } catch (err) {
    await metaRef.set({ running: 0, lastError: String(err && err.message || err), lastErrorAt: now }, { merge: true });
    await db.collection('spraySyncLog').add(Object.assign({ at: new Date(now).toISOString(), ms: Date.now() - now, error: String(err && err.message || err) }, stats));
    throw err;
  }
}

function stripVolatile(r) {
  const o = Object.assign({}, r);
  delete o.synced_at;
  return o;
}

// ---------------------------------------------------------------------------
// Cloud Functions
// ---------------------------------------------------------------------------
function makeExports(AGWORLD_TOKEN) {
  const syncSprayJobs = onSchedule(
    { schedule: 'every 60 minutes', timeZone: TZ, secrets: [AGWORLD_TOKEN], timeoutSeconds: 540, memory: '1GiB' },
    async () => { await runSync('hourly', AGWORLD_TOKEN.value()); }
  );
  const syncSprayJobsFull = onSchedule(
    { schedule: 'every day 02:07', timeZone: TZ, secrets: [AGWORLD_TOKEN], timeoutSeconds: 1800, memory: '1GiB' },
    async () => { await runSync('full', AGWORLD_TOKEN.value()); }
  );
  // From the app: Admin/Owner can run the hourly check now, or a full check (e.g. after a location
  // was taken off a work order, which AgWorld may not count as an edit).
  const syncSprayJobsNow = onCall(
    { secrets: [AGWORLD_TOKEN], timeoutSeconds: 1800, memory: '1GiB' },
    async (request) => {
      if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
      // Spray admins only (Users screen checkbox); AIO Admin/Owner by itself isn't enough.
      const me = (await admin.firestore().collection('users').doc(request.auth.uid).get()).data() || {};
      if (me.sprayAdmin !== true) throw new HttpsError('permission-denied', 'Spray admins only.');
      const mode = request.data && request.data.mode === 'full' ? 'full' : 'hourly';
      return runSync(mode, AGWORLD_TOKEN.value());
    }
  );
  // Open this function's URL in a browser to run the full check right away (same idea as
  // syncAgworldFieldsNow). Add ?mode=hourly for the quick one. It only reads AgWorld and writes
  // the spray collections, and won't start while another spray sync is running.
  const syncSprayJobsFullNow = onRequest(
    { secrets: [AGWORLD_TOKEN], timeoutSeconds: 1800, memory: '1GiB' },
    async (req, res) => {
      const mode = req.query && req.query.mode === 'hourly' ? 'hourly' : 'full';
      try {
        const s = await runSync(mode, AGWORLD_TOKEN.value());
        if (s.skipped && typeof s.skipped === 'string') { res.status(200).send('A spray sync is already running. Try again in a few minutes.'); return; }
        const skipped = Object.keys(s.skipped).map((k) => '  ' + s.skipped[k] + '  ' + k).join('\n');
        res.status(200).type('text/plain').send(
          'Spray sync (' + mode + ') done.\n' +
          'Checked ' + s.fetched + ' AgWorld activities. On the schedule: ' + s.kept + ' jobs (' + s.added + ' new, ' + s.removed + ' gone).\n' +
          'Season log rows from AgWorld: ' + s.logged + ' (+' + s.loggedNoRec + ' with no rec/work order). Moved to new AgWorld ids: ' + s.migrated + '. Removed jobs back: ' + s.released + '.\n' +
          (skipped ? 'Left out:\n' + skipped : '')
        );
      } catch (err) {
        console.error(err);
        res.status(500).type('text/plain').send('Spray sync failed: ' + err.message);
      }
    }
  );
  return { syncSprayJobs, syncSprayJobsFull, syncSprayJobsNow, syncSprayJobsFullNow };
}

module.exports = {
  makeExports,
  // for tests and for the other Spray functions
  _internal: {
    SYNC, TZ, AGWORLD_TAG, NO_REC_TAG, QUICK_DONE_TAG, runSync, evaluateActivity, classifyJob, collapseStages,
    matchMoves, withManager, gallonsFromActivity, appliedConditions, dueYmd, hiddenStillValid, ringCenter, today, shiftYmd
  }
};
