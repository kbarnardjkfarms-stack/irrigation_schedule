import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  Warehouse, Thermometer, ClipboardCheck, Package, TrendingDown, Map as MapIcon,
  Plus, ChevronRight, MapPin, Gauge, BarChart3, AlertTriangle, Check, Layers, Users, Sprout, Building2, FlaskConical, Trash2,
  Fan, Snowflake, Power,
} from "lucide-react";
import { doc, getDoc, setDoc, deleteDoc, collection, collectionGroup, query, where, getDocs, onSnapshot } from "firebase/firestore";
import { db } from "./firebase.js"; // AIO's existing Firebase project — same login, no second sign-in
/* =================================================================
   NORLAND CELLARS — seed data (pulled from the 2025 storage workbook)
   1200 N. Meridian, Rupert, ID
   Zones = the field/lot divisions physically stored within each bay.
   Each zone owns a slice of the bay's pipe, so fill + shrink are
   tracked per field, not just per bay.
==================================================================*/
/* ---------------------------------------------------------------
   Color encoding — variety AND customer are shown at once:
   pile body = variety hue (warm palette), pile top cap + accents =
   customer hue (cool/varied palette). Known names get fixed, stable
   colors; anything new is hashed into the pool so it stays consistent
   across reloads without needing to be configured.
----------------------------------------------------------------*/
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
const VARIETY_FIXED = {
  "Burbank": "#d9a441", "Ranger": "#9c4a2c", "Dakota": "#c96a2e", "Clearwater": "#b58a4a",
  "Teton": "#8c3a3a", "Norkotah": "#a68f2e", "Reveille": "#6b7a3a", "G3 Burbank": "#e0b45a",
  "G3 Reveille": "#7a8f4a", "Ciklamen": "#c9825a", "Nordaana": "#7a4a2e", "907-15": "#d1975f",
  "9426": "#9c6b3f", "Gala": "#b8763f",
};
const VARIETY_POOL = ["#a68f2e", "#c96a2e", "#8c3a3a", "#6b7a3a", "#b58a4a", "#7a4a2e"];
function getVarietyColor(name) {
  if (!name) return "#7c8794";
  if (VARIETY_FIXED[name]) return VARIETY_FIXED[name];
  return VARIETY_POOL[hashStr(name) % VARIETY_POOL.length];
}
const CUSTOMER_FIXED = {
  "Lamb Weston": "#4a7fc7", "Simplot": "#3fae8a", "McCain": "#9b6bd6",
  "Mart Fresh": "#d65f8a", "Mart Frozen": "#5fb0d6", "Grimmway": "#c7974a",
  "Unassigned": "#6b7280",
};
const CUSTOMER_POOL = ["#c7974a", "#e0637a", "#7fb0a0", "#b08cd6", "#d69a5f", "#6ba8c9"];
function getCustomerColor(name) {
  if (!name) return CUSTOMER_FIXED.Unassigned;
  if (CUSTOMER_FIXED[name]) return CUSTOMER_FIXED[name];
  return CUSTOMER_POOL[hashStr(name) % CUSTOMER_POOL.length];
}
function allVarieties(bays) {
  const set = new Map();
  bays.forEach((b) => b.zones.forEach((z) => set.set(z.variety, getVarietyColor(z.variety))));
  return Array.from(set.entries()).sort((a, b) => naturalCompare(a[0], b[0]));
}
function allCustomers(bays) {
  const set = new Map();
  bays.forEach((b) => b.zones.forEach((z) => set.set(z.customer, getCustomerColor(z.customer))));
  return Array.from(set.entries()).sort((a, b) => naturalCompare(a[0], b[0]));
}
/* ---------------------------------------------------------------
   Site hierarchy: Location (complex) > Building > Bay > Zone (field)
----------------------------------------------------------------*/
const DEFAULT_LOCATIONS = [
  { id: "norland", name: "Norland Cellars", address: "1200 N. Meridian, Rupert, ID 83350", lat: 42.6340, lng: -113.6780 },
  { id: "remsburg", name: "Remsburg", address: "Rupert, ID (address TBD)", lat: 42.6260, lng: -113.7100 },
  { id: "watco", name: "Watco-Dutchman", address: "Rupert, ID (address TBD)", lat: 42.5900, lng: -113.7300 },
  { id: "paul", name: "Paul", address: "Paul, ID 83347", lat: 42.6053, lng: -113.7847 },
];
const DEFAULT_BUILDINGS = [
  { id: "bldg-n89", name: "Norland 8–9 Building", locationId: "norland" },
  { id: "bldg-n1011", name: "Norland 10–11 Building", locationId: "norland" },
  { id: "bldg-n12", name: "Norland 12 Building", locationId: "norland" },
  { id: "bldg-r12", name: "Remsburg 1–2 Building", locationId: "remsburg" },
  { id: "bldg-r3", name: "Remsburg 3 Building", locationId: "remsburg" },
  { id: "bldg-w12", name: "Watco 1–2 Building", locationId: "watco" },
  { id: "bldg-w34", name: "Watco 3–4 Building", locationId: "watco" },
  { id: "bldg-w56", name: "Watco 5–6 Building", locationId: "watco" },
  { id: "bldg-p12", name: "Paul 1–2 Building", locationId: "paul" },
  { id: "bldg-p34", name: "Paul 3–4 Building", locationId: "paul" },
];
// Helper: a placeholder single-field bay for complexes where we only have a
// total capacity figure from the workbook, not pipe-level detail yet. Pipe
// count of 30 is nominal — cwt/pipe is derived so the capacity stays accurate
// (capacity = pipeCount * cwtPerPipe) until the real pipe count is entered.
function placeholderZone(id, capacity, pipes = 30) {
  return [{ id, name: "Field 1", variety: "Burbank", customer: "Unassigned", pipeCount: pipes, cwtPerPipe: Math.round((capacity / pipes) * 100) / 100 }];
}
const DEFAULT_BAYS = [
  {
    id: "n8", name: "Norland #8", buildingId: "bldg-n89",
    fillDate: "2025-10-16", cwtPerPipe: 3200,
    zones: [
      { id: "n8z1", name: "Field A — North End", variety: "Burbank", customer: "Unassigned", pipeCount: 19 },
      { id: "n8z2", name: "Field B — South End", variety: "Burbank", customer: "Unassigned", pipeCount: 15 },
    ],
  },
  {
    id: "n9", name: "Norland #9", buildingId: "bldg-n89",
    fillDate: "2025-09-25", cwtPerPipe: 3200,
    zones: [
      { id: "n9z1", name: "Hawaii 05", variety: "Burbank", customer: "Simplot", pipeCount: 25 },
      { id: "n9z2", name: "Hawaii 3 & 7", variety: "Burbank", customer: "Unassigned", pipeCount: 6 },
    ],
  },
  {
    id: "n10", name: "Norland #10", buildingId: "bldg-n1011",
    fillDate: "2025-09-20", cwtPerPipe: 2440,
    zones: [{ id: "n10z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", pipeCount: 40 }],
  },
  {
    id: "n11", name: "Norland #11", buildingId: "bldg-n1011",
    fillDate: "2025-09-17", cwtPerPipe: 2440,
    zones: [{ id: "n11z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", pipeCount: 40 }],
  },
  {
    id: "n12", name: "Norland #12", buildingId: "bldg-n12",
    fillDate: "2025-09-12", cwtPerPipe: 2750,
    zones: [{ id: "n12z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", pipeCount: 36 }],
  },
  // Remsburg — capacities from the 2025 workbook's CAPACITY SUMMARY tab.
  { id: "rems1", name: "Remsburg #1", buildingId: "bldg-r12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("rems1z1", 56710) },
  { id: "rems2", name: "Remsburg #2", buildingId: "bldg-r12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("rems2z1", 56710) },
  { id: "rems3", name: "Remsburg #3", buildingId: "bldg-r3", fillDate: "", cwtPerPipe: null, zones: placeholderZone("rems3z1", 73250) },
  // Paul — capacities from the workbook (Straight/Angle bays).
  { id: "paul1", name: "Paul #1", buildingId: "bldg-p12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("paul1z1", 98914) },
  { id: "paul2", name: "Paul #2", buildingId: "bldg-p12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("paul2z1", 98914) },
  { id: "paul3", name: "Paul #3", buildingId: "bldg-p34", fillDate: "", cwtPerPipe: null, zones: placeholderZone("paul3z1", 98914) },
  { id: "paul4", name: "Paul #4", buildingId: "bldg-p34", fillDate: "", cwtPerPipe: null, zones: placeholderZone("paul4z1", 98914) },
  // Watco-Dutchman — capacities from the workbook where available; #5/#6 are
  // estimated to match the rest of the complex and flagged for correction.
  { id: "watco1", name: "Watco #1", buildingId: "bldg-w12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco1z1", 96192) },
  { id: "watco2", name: "Watco #2", buildingId: "bldg-w12", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco2z1", 96192) },
  { id: "watco3", name: "Watco #3", buildingId: "bldg-w34", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco3z1", 96192) },
  { id: "watco4", name: "Watco #4", buildingId: "bldg-w34", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco4z1", 96192) },
  { id: "watco5", name: "Watco #5", buildingId: "bldg-w56", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco5z1", 96192) },
  { id: "watco6", name: "Watco #6", buildingId: "bldg-w56", fillDate: "", cwtPerPipe: null, zones: placeholderZone("watco6z1", 96192) },
];
// Seed a couple of real historical loads on Norland #9 so shrink math has something to show.
const SEED_RUNS = {
  n9z1: [{ date: "2026-02-10", dest: "Simplot", cwt: 17809 }],
  n9z2: [{ date: "2026-02-14", dest: "Unassigned", cwt: 19241.15 }],
};
const LOCATIONS_KEY = "storage-locations-v3";
const SEASONS_KEY = "storage-seasons-v1";
const DEFAULT_SEASONS = [{ id: "season-2025-26", label: "2025–2026", snapshot: null }];
const BUILDINGS_KEY = "storage-buildings-v3";
// v4: bays/zones switched from "tube" to "pipe" naming, and bays gained an
// explicit total pipeCount (previously implied by summing zone pipe counts).
const CONFIG_KEY = "norland-bays-config-v4";
// v3: pipe checks record empty pipe ranges (both ends pulled independently)
// instead of a single "tubes remaining" count.
const bayDataKey = (id) => `norland-bay-data-v4:${id}`;
const INSPECTIONS_KEY = "norland-inspections-v2";
const CUSTOMERS_KEY = "norland-customers-v2";
const DEFAULT_CUSTOMERS = ["Lamb Weston", "Simplot", "McCain", "Mart Fresh", "Mart Frozen", "Grimmway"];
const VARIETIES_KEY = "norland-varieties-v2";
const DEFAULT_VARIETIES = [
  "Burbank", "Ranger", "Dakota", "Clearwater", "Teton", "Norkotah", "Reveille",
  "G3 Burbank", "G3 Reveille", "Ciklamen", "Nordaana", "907-15", "9426", "Gala",
];
const PRODUCTS_KEY = "norland-products-v1";
const DEFAULT_PRODUCTS = [{ id: "prod-sproutnip", name: "Sprout Nip", restrictedCustomers: [] }];
const APPLICATORS_KEY = "norland-applicators-v1";
const DEFAULT_APPLICATORS = [];
const emptyZoneData = (zoneId) => ({
  pipeChecks: [], cwtRuns: SEED_RUNS[zoneId] ? [...SEED_RUNS[zoneId]] : [], sproutApplications: [],
});
const emptyBayData = (bay) => ({
  zones: Object.fromEntries(bay.zones.map((z) => [z.id, emptyZoneData(z.id)])),
  tempLogs: [],
});
const fmt = (n, d = 0) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const todayStr = () => new Date().toISOString().slice(0, 10);
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// Default list ordering, everywhere: alphabetical, with embedded numbers
// compared numerically rather than digit-by-digit — so "Norland #9" sorts
// before "Norland #10" instead of after it.
function naturalCompare(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
}
function sortByNatural(arr, keyFn = (x) => x) {
  return [...arr].sort((a, b) => naturalCompare(keyFn(a), keyFn(b)));
}
/* ---------------------------------------------------------------
   Storage helpers
----------------------------------------------------------------*/
/* ---------------------------------------------------------------
   Storage helpers — Firestore, same project as the rest of AIO.
   All data lives in one "potatoStorage" collection, one document per
   key, so it can't collide with AIO's own collections (weeks, fields,
   farms, etc.) or with anything Irrigation does.
----------------------------------------------------------------*/
async function loadJSON(key, fallback) {
  try {
    const snap = await getDoc(doc(db, "potatoStorage", key));
    if (!snap.exists()) return fallback;
    return JSON.parse(snap.data().value);
  } catch {
    return fallback;
  }
}
async function saveJSON(key, value) {
  try { await setDoc(doc(db, "potatoStorage", key), { value: JSON.stringify(value), updatedAt: Date.now() }); }
  catch (e) { console.error("storage save failed", key, e); }
}
// Used when a bay (or everything under a building/location) is deleted, so
// its old per-bay data doc doesn't just sit around orphaned in Firestore.
async function deleteJSON(key) {
  try { await deleteDoc(doc(db, "potatoStorage", key)); }
  catch (e) { console.error("storage delete failed", key, e); }
}
/* ---------------------------------------------------------------
   Derived stats — per zone (field), then rolled up per bay
----------------------------------------------------------------*/
// Pipe numbers are GLOBAL to the bay (1..bay.pipeCount) — "pipe 12" means
// the same physical pipe in every field's records, the 3D rendering, and the
// Log Pipe form. A zone's pipeRanges is the set of bay pipe numbers that
// field's potatoes occupy; ranges may be non-contiguous (a field can end up
// split across two stretches) and are stored as a flat list rather than a
// pre-merged one — overlaps and duplicates collapse naturally wherever this
// is turned into a Set.
function pipeRangeSet(ranges) {
  const set = new Set();
  (ranges || []).forEach(({ from, to }) => {
    const lo = Math.min(Number(from), Number(to));
    const hi = Math.max(Number(from), Number(to));
    for (let p = lo; p <= hi; p++) set.add(p);
  });
  return set;
}
// A pipe range is only valid if every pipe number in it actually exists in
// the bay — you can't log or assign pipe 278 in a 273-pipe bay.
function rangeFitsBay(range, bayPipeCount) {
  if (!bayPipeCount) return true; // bay hasn't been given a total yet — nothing to check against
  const lo = Math.min(Number(range.from), Number(range.to));
  const hi = Math.max(Number(range.from), Number(range.to));
  return Number.isFinite(lo) && Number.isFinite(hi) && lo >= 1 && hi <= bayPipeCount;
}
function zonePipeCount(zone) {
  return pipeRangeSet(zone.pipeRanges).size;
}
// "1–5, 36–40" style summary of a set of pipe ranges, for the Log Pipe form's
// live preview and the logged history list.
function formatPipeRanges(ranges) {
  if (!ranges || ranges.length === 0) return "—";
  return ranges
    .map(({ from, to }) => (Number(from) === Number(to) ? `${from}` : `${Math.min(from, to)}–${Math.max(from, to)}`))
    .join(", ");
}
// Every cwt/pipe number on record (bay or field) was calibrated against an
// 18' pile — that's been the assumption everywhere up to now. A bay can now
// be marked as a 9' pile instead, which holds roughly half as much potato
// per pipe for the same footprint, so its cwt gets scaled down by this ratio
// wherever cwt/pipe is actually used in a calculation. Defaulting to 18 for
// any bay that's never had a pile height set keeps every existing bay's
// numbers exactly as they were before this feature existed.
const PILE_HEIGHT_OPTIONS = [18, 9];
function pileHeightRatio(bay) {
  return (bay?.pileHeight || 18) / 18;
}
// Replays a pipe-check log against a footprint of pipe numbers, same
// full/empty-flip logic used for both the bottom (base) footprint and the
// (optional) top-of-pile footprint below — factored out so the two stay
// in lockstep instead of two hand-copied loops drifting apart.
function replayPipeLog(footprint, pipeLog) {
  const fullMap = new Map();
  footprint.forEach((p) => fullMap.set(p, true));
  pipeLog.forEach((entry) => {
    pipeRangeSet(entry.ranges).forEach((p) => {
      if (fullMap.has(p)) fullMap.set(p, entry.type === "fill");
    });
  });
  return fullMap;
}
function computeZoneStats(bay, zone, zoneData) {
  const footprint = pipeRangeSet(zone.pipeRanges);
  const pipeCount = footprint.size;
  const pipeLog = zoneData?.pipeChecks || [];
  // Every pipe starts full the moment it's part of the field's footprint
  // (freshly filled) — logged entries afterward flip specific pipes: a
  // "haul" entry (pulled out) marks pipes empty, a "fill" entry (filled back
  // in, or the field's footprint growing into more pipe) marks them full.
  // Replayed in the order they were logged, so the latest entry for any
  // given pipe wins. This is the bottom/base footprint — the one that
  // drives cwt below — so it only replays entries NOT explicitly logged
  // against the top (position === "top"); legacy entries with no position
  // at all count as bottom, same as before this feature existed.
  const fullMap = replayPipeLog(footprint, pipeLog.filter((e) => e.position !== "top"));
  const pipesFilled = Array.from(fullMap.values()).filter(Boolean).length;
  const pipesEmpty = pipeCount - pipesFilled;
  // Top-of-pile footprint — purely visual (feeds the 3D mound's tapered
  // top face in applyZoneFill), never the cwt math below. Independent
  // tracking only kicks in once there's a reason to: either an explicit
  // top range was entered on Add Product, or a "top" position entry has
  // ever been logged via Log Pipe (which can introduce top tracking on
  // its own, defaulting to the same footprint as bottom until it's been
  // narrowed by a log entry). Otherwise falls back to mirroring bottom
  // exactly, so a field that's never touched this feature renders exactly
  // as it always has.
  const topEntries = pipeLog.filter((e) => e.position === "top");
  const hasTopRange = (zone.topPipeRanges || []).length > 0 || topEntries.length > 0;
  const topFootprint = hasTopRange ? pipeRangeSet(zone.topPipeRanges?.length ? zone.topPipeRanges : zone.pipeRanges) : footprint;
  const topFullMap = hasTopRange ? replayPipeLog(topFootprint, topEntries) : fullMap;
  // The entered cwt/pipe is always the 18'-pile number — scale it down for a
  // bay marked as a 9' pile so capacity/current cwt reflect the shorter pile
  // without anyone having to re-enter a new approximation by hand.
  const cwtPerPipe = (zone.cwtPerPipe || bay.cwtPerPipe || 0) * pileHeightRatio(bay);
  const calculatedCwt = pipesFilled * cwtPerPipe;
  // A manual correction for when the pipe-count math and the actual
  // physical inventory have drifted apart (moisture loss, an unlogged
  // haul, etc.) — when set, this is what "current cwt" means everywhere;
  // the pipe-derived number is still shown alongside it for reference,
  // never silently discarded.
  const hasOverride = zone.actualCwtOverride != null && zone.actualCwtOverride !== "";
  const currentCwt = hasOverride ? Number(zone.actualCwtOverride) : calculatedCwt;
  const capacityCwt = pipeCount * cwtPerPipe;
  const fillPct = capacityCwt > 0 ? Math.min(1, currentCwt / capacityCwt) : 0;
  const runs = zoneData?.cwtRuns || [];
  const totalRun = runs.reduce((s, r) => s + Number(r.cwt || 0), 0);
  const initialCwt = zone.initialFillCwt ?? capacityCwt;
  const shrinkCwt = initialCwt - (totalRun + currentCwt);
  const shrinkPct = initialCwt > 0 ? shrinkCwt / initialCwt : 0;
  return {
    pipeCount, pipesEmpty, pipesFilled, fullMap, topFullMap, hasTopRange, cwtPerPipe,
    calculatedCwt, hasOverride, currentCwt, capacityCwt, fillPct,
    totalRun, initialCwt, shrinkCwt, shrinkPct, runs,
    lastCheckDate: pipeLog.length ? pipeLog[pipeLog.length - 1].date : null,
  };
}
function computeBayStats(bay, bayData) {
  const zoneStats = {};
  let currentCwt = 0, zoneCapacityCwt = 0, totalRun = 0, initialCwt = 0, shrinkCwt = 0;
  bay.zones.forEach((z) => {
    const zs = computeZoneStats(bay, z, bayData?.zones?.[z.id]);
    zoneStats[z.id] = zs;
    currentCwt += zs.currentCwt; zoneCapacityCwt += zs.capacityCwt;
    totalRun += zs.totalRun; initialCwt += zs.initialCwt; shrinkCwt += zs.shrinkCwt;
  });
  // A bay's own declared pipe count + cwt/pipe is its physical capacity —
  // known the moment the bay is created, even before any field is assigned
  // to it (or if fields don't yet cover every pipe). Falls back to the sum
  // of what's actually assigned only when the bay wasn't given its own
  // totals, so older bays without them still work as before.
  const capacityCwt = (bay.pipeCount && bay.cwtPerPipe)
    ? bay.pipeCount * bay.cwtPerPipe * pileHeightRatio(bay)
    : zoneCapacityCwt;
  const fillPct = capacityCwt > 0 ? Math.min(1, currentCwt / capacityCwt) : 0;
  const shrinkPct = initialCwt > 0 ? shrinkCwt / initialCwt : 0;
  return { zoneStats, currentCwt, capacityCwt, fillPct, totalRun, initialCwt, shrinkCwt, shrinkPct };
}
/* =================================================================
   3D — shared bay-group builder (used by both the yard view and the
   single-bay interior viewer). Buildings are open-frame/cutaway by
   default so the field divisions are visible without clicking in.
==================================================================*/
// A quad built from 4 explicit corner points, in order around the perimeter.
// Used for the sloped wall panels — safer than rotating a PlaneGeometry when
// the tilt direction has to be exactly right.
function quadMesh(p0, p1, p2, p3, material) {
  const geo = new THREE.BufferGeometry();
  const v = [p0, p1, p2, p0, p2, p3].flatMap((p) => [p.x, p.y, p.z]);
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(v), 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}
// A thin structural member connecting two arbitrary points (used for the
// slanted corner posts) — oriented via quaternion so the lean is always right
// regardless of which corner it's for.
function strutMesh(p0, p1, material, thickness = 0.22) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const length = dir.length();
  const geo = new THREE.BoxGeometry(thickness, length, thickness);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}
// Frustum pile geometry: full width top-to-bottom (no taper across the bay),
// but the two lengthwise ends slope inward as it rises — like a real potato
// pile's natural angle of repose. Spans Y from 0 (floor) to 1 (scaled later
// for fill level).
// topOffsetZ shifts the top face's center along Z relative to the bottom
// face's center — lets the mound lean rather than always tapering
// perfectly symmetrically, for the (optional) case where a field's actual
// top-of-pile pipe range isn't centered on its bottom/base range. Defaults
// to 0 (a straight, centered taper) so every existing call site — and
// every field that's never had a separate top range entered — renders
// exactly as before.
function buildPileFrustumGeometry(widthBottom, widthTop, depthBottom, depthTop, topOffsetZ = 0) {
  const hwb = widthBottom / 2, hwt = widthTop / 2, hdb = depthBottom / 2, hdt = depthTop / 2;
  const b0 = new THREE.Vector3(-hwb, 0, -hdb), b1 = new THREE.Vector3(hwb, 0, -hdb);
  const b2 = new THREE.Vector3(hwb, 0, hdb), b3 = new THREE.Vector3(-hwb, 0, hdb);
  const t0 = new THREE.Vector3(-hwt, 1, -hdt + topOffsetZ), t1 = new THREE.Vector3(hwt, 1, -hdt + topOffsetZ);
  const t2 = new THREE.Vector3(hwt, 1, hdt + topOffsetZ), t3 = new THREE.Vector3(-hwt, 1, hdt + topOffsetZ);
  const tris = [
    [t0, t1, t2], [t0, t2, t3],   // top
    [b0, b1, t1], [b0, t1, t0],   // front (sloped) end
    [b2, b3, t3], [b2, t3, t2],   // back (sloped) end
    [b3, b0, t0], [b3, t0, t3],   // left side
    [b1, b2, t2], [b1, t2, t1],   // right side
    [b0, b3, b2], [b0, b2, b1],   // bottom
  ];
  const positions = tris.flat().flatMap((p) => [p.x, p.y, p.z]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  return geo;
}
const PILE_TAPER = 0.62; // shared by the building's wall lean and the pile's natural end slope
function buildBayGroup(bay, dims) {
  const { W, H, L } = dims;
  const g = new THREE.Group();
  // Building tapers inward as it rises — widest at the floor, narrower at the eave.
  const TOP_RATIO = PILE_TAPER;
  const baseHalfW = W / 2, topHalfW = (W * TOP_RATIO) / 2;
  const postMat = new THREE.MeshStandardMaterial({ color: "#7c8794", roughness: 0.5, metalness: 0.4 });
  [-L / 2, L / 2].forEach((z) => {
    [-1, 1].forEach((side) => {
      g.add(strutMesh(
        new THREE.Vector3(side * baseHalfW, 0, z),
        new THREE.Vector3(side * topHalfW, H, z),
        postMat
      ));
    });
  });
  const bottomRailZ = new THREE.BoxGeometry(W, 0.2, 0.2);
  const topRailZ = new THREE.BoxGeometry(W * TOP_RATIO, 0.2, 0.2);
  [-L / 2, L / 2].forEach((z) => {
    const rb = new THREE.Mesh(bottomRailZ, postMat); rb.position.set(0, 0, z); g.add(rb);
    const rt = new THREE.Mesh(topRailZ, postMat); rt.position.set(0, H, z); g.add(rt);
  });
  const bottomRailX = new THREE.BoxGeometry(0.2, 0.2, L);
  const topRailX = new THREE.BoxGeometry(0.2, 0.2, L);
  [-1, 1].forEach((side) => {
    const rb = new THREE.Mesh(bottomRailX, postMat); rb.position.set(side * baseHalfW, 0, 0); g.add(rb);
    const rt = new THREE.Mesh(topRailX, postMat); rt.position.set(side * topHalfW, H, 0); g.add(rt);
  });
  const skinMat = new THREE.MeshStandardMaterial({ color: "#c7ccd4", roughness: 0.7, transparent: true, opacity: 0.14, side: THREE.DoubleSide });
  const roof = new THREE.Mesh(new THREE.BoxGeometry(W * TOP_RATIO + 0.4, 0.12, L + 0.4), skinMat);
  roof.position.set(0, H, 0);
  g.add(roof);
  // back (gable) wall — a trapezoid, wide at the floor, narrow at the eave
  const backWall = quadMesh(
    new THREE.Vector3(-baseHalfW, 0, -L / 2), new THREE.Vector3(baseHalfW, 0, -L / 2),
    new THREE.Vector3(topHalfW, H, -L / 2), new THREE.Vector3(-topHalfW, H, -L / 2),
    skinMat
  );
  g.add(backWall);
  // side walls — lean inward uniformly along their full length
  const sideMat = new THREE.MeshStandardMaterial({ color: "#c7ccd4", roughness: 0.7, transparent: true, opacity: 0.07, side: THREE.DoubleSide });
  [-1, 1].forEach((side) => {
    const wall = quadMesh(
      new THREE.Vector3(side * baseHalfW, 0, -L / 2), new THREE.Vector3(side * baseHalfW, 0, L / 2),
      new THREE.Vector3(side * topHalfW, H, L / 2), new THREE.Vector3(side * topHalfW, H, -L / 2),
      sideMat
    );
    g.add(wall);
  });
  const floorMat = new THREE.MeshStandardMaterial({ color: "#5a5346", roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, L), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);
  // Pipe numbers are GLOBAL across the whole bay (1..totalPipes) — every
  // field's pipeRanges reference this same numbering, so "pipe 12" always
  // means the same physical slot regardless of which field owns it. Falling
  // back to the sum of zone pipe counts keeps older bays (saved before bays
  // had their own pipeCount) working.
  const totalPipes = bay.pipeCount || bay.zones.reduce((s, z) => s + zonePipeCount(z), 0) || 1;
  const innerW = W * 0.86;
  const pipeWidth = L / totalPipes;
  const zStart = -L / 2;
  // One indicator cylinder per physical pipe, positioned by its actual
  // global pipe number — independent of which field (if any) currently
  // owns it. Ownership/fill state gets applied in applyZoneFill.
  const stripGroup = new THREE.Group();
  for (let p = 0; p < totalPipes; p++) {
    const pipeMat = new THREE.MeshStandardMaterial({ color: "#4a4238", metalness: 0.6, roughness: 0.35 });
    const pipeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, innerW * 0.9, 10), pipeMat);
    pipeMesh.rotation.z = Math.PI / 2;
    pipeMesh.position.set(0, 0.09, zStart + pipeWidth * (p + 0.5));
    stripGroup.add(pipeMesh);
    pipeMesh.userData = { pipeNumber: p + 1 };
  }
  g.add(stripGroup);
  // Pile/cap mounds and the field-boundary dividers are all (re)built in
  // applyZoneFill, not here — which pipes are full, and which field owns
  // which stretch, can change with every log entry, so there's no fixed set
  // of meshes to just resize in place.
  const pileGroup = new THREE.Group();
  g.add(pileGroup);
  const dividerGroup = new THREE.Group();
  g.add(dividerGroup);
  return { group: g, pileGroup, dividerGroup, stripGroup, totalPipes, pipeWidth, zStart, innerW, maxH: H * 0.82 };
}
// Maps every pipe slot (1..totalPipes) to whichever zone currently owns it
// (via that zone's pipeRanges footprint) and whether it's presently full —
// the single source of truth the pile mounds, dividers, and pipe strip all
// render from.
function buildPipeSlotOwnership(bay, zoneStatsById, totalPipes) {
  const owner = new Array(totalPipes + 1).fill(null); // 1-indexed; owner[0] unused
  const full = new Array(totalPipes + 1).fill(false);
  bay.zones.forEach((zone) => {
    const zs = zoneStatsById[zone.id];
    if (!zs) return;
    zs.fullMap.forEach((isFull, pipeNumber) => {
      if (pipeNumber >= 1 && pipeNumber <= totalPipes) {
        owner[pipeNumber] = zone;
        full[pipeNumber] = isFull;
      }
    });
  });
  return { owner, full };
}
function applyZoneFill(bayMesh, bay, zoneStatsById, maxH) {
  const { pileGroup, dividerGroup, stripGroup, totalPipes, pipeWidth, zStart, innerW } = bayMesh;
  const { owner, full } = buildPipeSlotOwnership(bay, zoneStatsById, totalPipes);
  // The building shell (maxH) always renders at the same eave height — a 9'
  // pile bay isn't a shorter building, it just doesn't get filled as high.
  // So only the pile mounds themselves get scaled down.
  const pileH = maxH * pileHeightRatio(bay);
  // Rebuild the mounds from scratch every update — which pipes are full (and
  // therefore how many separate mounds exist) changes with every log entry,
  // so there's no fixed mesh to just resize in place.
  while (pileGroup.children.length) {
    const child = pileGroup.children.pop();
    child.geometry?.dispose();
    pileGroup.remove(child);
  }
  let p = 1;
  while (p <= totalPipes) {
    if (!owner[p] || !full[p]) { p++; continue; }
    const zone = owner[p];
    let q = p;
    while (q + 1 <= totalPipes && owner[q + 1] === zone && full[q + 1]) q++;
    // Contiguous full run [p, q] (1-indexed, inclusive) owned by the same
    // field — one pile+cap mound per run. Pulling from both ends leaves two
    // separate mounds with a gap of exposed (light-colored) pipe between
    // them, instead of one pile that only ever recedes from a single end.
    const segDepth = Math.max(0.3, (q - p + 1) * pipeWidth - 0.3);
    const topWidth = innerW * PILE_TAPER;
    const segCenterZ = zStart + (p - 1 + (q - p + 1) / 2) * pipeWidth;
    // Top face of the mound: if this field has ever had a top-of-pile pipe
    // range logged (Add Product's optional top range, or a "top" position
    // haul narrowing it since), use its ACTUAL currently-full extent within
    // this run instead of a generic symmetric taper — so the mound really
    // reflects what's been reported, including leaning to one side if the
    // top range isn't centered on the base range. No top range ever
    // entered → falls back to the original fixed-ratio taper, unchanged.
    const zStatsHere = zoneStatsById[zone.id];
    const hasTopRange = !!zStatsHere?.hasTopRange;
    const topFullMap = zStatsHere?.topFullMap;
    let segTopDepth, topOffsetZ;
    const topPipesHere = topFullMap
      ? Array.from(topFullMap.entries()).filter(([pn, isFull]) => isFull && pn >= p && pn <= q).map(([pn]) => pn)
      : [];
    if (hasTopRange && topPipesHere.length) {
      const minP = Math.min(...topPipesHere), maxP = Math.max(...topPipesHere);
      const topCenterZ = zStart + (minP - 1 + (maxP - minP + 1) / 2) * pipeWidth;
      topOffsetZ = topCenterZ - segCenterZ;
      segTopDepth = Math.min(segDepth, Math.max(0.15, (maxP - minP + 1) * pipeWidth - 0.3));
    } else if (hasTopRange) {
      // Top tracking is active but every pipe in the top footprint has
      // since been hauled out within this run — pile comes to a near-point
      // at the top, centered, rather than silently reverting to the
      // generic taper.
      segTopDepth = 0.08;
      topOffsetZ = 0;
    } else {
      segTopDepth = segDepth * PILE_TAPER;
      topOffsetZ = 0;
    }
    const mat = new THREE.MeshStandardMaterial({ color: getVarietyColor(zone.variety), roughness: 0.95, side: THREE.DoubleSide });
    const pile = new THREE.Mesh(buildPileFrustumGeometry(innerW, topWidth, segDepth, segTopDepth, topOffsetZ), mat);
    pile.scale.set(1, pileH, 1);
    pile.position.set(0, 0, segCenterZ);
    pile.castShadow = true;
    pileGroup.add(pile);
    // customer cap — thin colored slab riding the top of each mound, so
    // variety (mound color) and customer (cap color) both read at a glance
    const capMat = new THREE.MeshStandardMaterial({ color: getCustomerColor(zone.customer), roughness: 0.6, metalness: 0.1 });
    const cap = new THREE.Mesh(new THREE.BoxGeometry(topWidth * 0.94, 0.28, segTopDepth * 0.9), capMat);
    cap.position.set(0, pileH + 0.14, segCenterZ);
    cap.castShadow = true;
    pileGroup.add(cap);
    p = q + 1;
  }
  // Field-boundary dividers — rebuilt alongside the mounds since ownership
  // can shift (a field's footprint growing via a fill log entry) just like
  // fill state can.
  while (dividerGroup.children.length) {
    const child = dividerGroup.children.pop();
    child.geometry?.dispose();
    dividerGroup.remove(child);
  }
  for (let b = 2; b <= totalPipes; b++) {
    if (owner[b] !== owner[b - 1] && (owner[b] || owner[b - 1])) {
      const dividerMat = new THREE.MeshBasicMaterial({ color: "#f2c14e" });
      const divider = new THREE.Mesh(new THREE.BoxGeometry(innerW + 0.3, 0.06, 0.06), dividerMat);
      divider.position.set(0, 0.03, zStart + (b - 1) * pipeWidth);
      dividerGroup.add(divider);
    }
  }
  // Recolor each pipe indicator to match its actual state: dark/buried when
  // full, light/exposed metal when empty or not yet claimed by any field.
  stripGroup.children.forEach((pipeMesh, idx) => {
    pipeMesh.material.color.set(full[idx + 1] ? "#4a4238" : "#c7ccd4");
  });
}
/* ---------------------------------------------------------------
   Generic orbiting 3D canvas (used for both yard + interior modes)
----------------------------------------------------------------*/
function Scene3D({ bays, statsById, selectedId, onSelect, mode = "yard", buildingsById = {} }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});
  const [labels, setLabels] = useState([]);
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0e1420");
    scene.fog = new THREE.Fog("#0e1420", 60, 240);
    const camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    mount.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight("#8892a8", 0.85));
    const sun = new THREE.DirectionalLight("#fff3da", 1.0);
    sun.position.set(20, 40, 25);
    sun.castShadow = true;
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: "#54503f", roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const DIMS = { W: 12.5, H: 8.5, L: 24 };
    const TIGHT_GAP = 14, BUILDING_GAP = 9;
    let xPositions = [0];
    if (mode !== "interior") {
      let x = 0;
      for (let i = 1; i < bays.length; i++) {
        const sameBuilding = bays[i].buildingId && bays[i].buildingId === bays[i - 1].buildingId;
        x += sameBuilding ? TIGHT_GAP : TIGHT_GAP + BUILDING_GAP;
        xPositions.push(x);
      }
      const span = xPositions[xPositions.length - 1];
      xPositions = xPositions.map((p) => p - span / 2);
    } else {
      xPositions = bays.map(() => 0);
    }
    const buildingGroup = new THREE.Group();
    scene.add(buildingGroup);
    const bayMeshes = {};
    bays.forEach((bay, i) => {
      const built = buildBayGroup(bay, DIMS);
      built.group.position.x = xPositions[i];
      buildingGroup.add(built.group);
      bayMeshes[bay.id] = built;
      const ringMat = new THREE.MeshBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.85 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(DIMS.W * 0.7, DIMS.W * 0.78, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(built.group.position.x, 0.02, 0);
      ring.visible = mode === "yard" && bay.id === selectedId;
      scene.add(ring);
      bayMeshes[bay.id].ring = ring;
    });
    const target = new THREE.Vector3(0, mode === "interior" ? 3.5 : 3, 0);
    let radius = mode === "interior" ? 26 : 58;
    let theta = mode === "interior" ? 1.15 : Math.PI / 2 - 0.5;
    let phi = mode === "interior" ? 0.85 : 1.02;
    const clampPhi = (p) => Math.max(0.3, Math.min(1.4, p));
    function updateCamera() {
      camera.position.x = target.x + radius * Math.sin(phi) * Math.cos(theta);
      camera.position.y = target.y + radius * Math.cos(phi);
      camera.position.z = target.z + radius * Math.sin(phi) * Math.sin(theta);
      camera.lookAt(target);
    }
    updateCamera();
    const onSelectRef = { current: onSelect };
    stateRef.current.onSelectRef = onSelectRef;
    let dragging = false, lastX = 0, lastY = 0, moved = 0;
    const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; moved = 0; };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      theta -= dx * 0.006;
      phi = clampPhi(phi - dy * 0.006);
      lastX = e.clientX; lastY = e.clientY;
      updateCamera();
    };
    const onUp = (e) => {
      dragging = false;
      if (mode !== "yard") return;
      if (moved < 6) {
        const rect = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);
        const hitables = Object.values(bayMeshes).map((m) => m.group);
        const hits = raycaster.intersectObjects(hitables, true);
        if (hits.length) {
          let obj = hits[0].object;
          while (obj && !Object.values(bayMeshes).find((m) => m.group === obj)) obj = obj.parent;
          const entry = Object.entries(bayMeshes).find(([, m]) => m.group === obj);
          if (entry) onSelectRef.current(entry[0]);
        }
      }
    };
    const onWheel = (e) => {
      e.preventDefault();
      const min = mode === "interior" ? 10 : 20, max = mode === "interior" ? 50 : 130;
      radius = Math.max(min, Math.min(max, radius + e.deltaY * 0.03));
      updateCamera();
    };
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
    let raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      renderer.render(scene, camera);
      const newLabels = [];
      bays.forEach((bay) => {
        const m = bayMeshes[bay.id];
        bay.zones.forEach((zone) => {
          const footprint = pipeRangeSet(zone.pipeRanges);
          if (!footprint.size) return; // no pipe assigned yet — nowhere to anchor a label
          const nums = Array.from(footprint);
          const lo = Math.min(...nums), hi = Math.max(...nums);
          const worldZ = m.zStart + ((lo - 1) + (hi - lo + 1) / 2) * m.pipeWidth;
          const p = new THREE.Vector3(0, m.maxH + 1.6, worldZ).add(m.group.position);
          p.project(camera);
          newLabels.push({
            key: `${bay.id}:${zone.id}`, bayId: bay.id, zoneId: zone.id,
            x: (p.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-p.y * 0.5 + 0.5) * mount.clientHeight,
            visible: p.z < 1,
          });
        });
        // Pipe number markers along the floor at the bottom of the bay —
        // thinned out on bays with lots of pipe so it stays readable instead
        // of a wall of overlapping numbers. Always includes pipe 1 and the
        // last pipe so the range's ends are never ambiguous.
        const step = m.totalPipes <= 20 ? 1 : Math.ceil(m.totalPipes / 20);
        for (let pn = 1; pn <= m.totalPipes; pn++) {
          if (pn !== 1 && pn !== m.totalPipes && (pn - 1) % step !== 0) continue;
          const worldZ = m.zStart + m.pipeWidth * (pn - 0.5);
          const pp = new THREE.Vector3(0, 0.02, worldZ).add(m.group.position);
          pp.project(camera);
          newLabels.push({
            key: `pipe:${bay.id}:${pn}`, bayId: bay.id, isPipeLabel: true, pipeNumber: pn,
            x: (pp.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-pp.y * 0.5 + 0.5) * mount.clientHeight,
            visible: pp.z < 1,
          });
        }
        if (mode === "yard") {
          const p2 = new THREE.Vector3(0, m.maxH + 3.4, 0).add(m.group.position);
          p2.project(camera);
          newLabels.push({
            key: `bay:${bay.id}`, bayId: bay.id, isBayLabel: true,
            x: (p2.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-p2.y * 0.5 + 0.5) * mount.clientHeight,
            visible: p2.z < 1,
          });
        }
      });
      if (mode === "yard") {
        // one label per building, centered over the bays that belong to it
        let gi = 0;
        while (gi < bays.length) {
          const bId = bays[gi].buildingId;
          let gj = gi;
          while (gj + 1 < bays.length && bays[gj + 1].buildingId === bId) gj++;
          const xs = [];
          for (let k = gi; k <= gj; k++) xs.push(bayMeshes[bays[k].id].group.position.x);
          const xAvg = xs.reduce((s, v) => s + v, 0) / xs.length;
          const p3 = new THREE.Vector3(xAvg, DIMS.H + 5.4, 0);
          p3.project(camera);
          const building = buildingsById[bId];
          newLabels.push({
            key: `building:${bId}`, isBuildingLabel: true, buildingName: building?.name || bId,
            x: (p3.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-p3.y * 0.5 + 0.5) * mount.clientHeight,
            visible: p3.z < 1,
          });
          gi = gj + 1;
        }
      }
      setLabels(newLabels);
    };
    animate();
    const ro = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    ro.observe(mount);
    stateRef.current = { ...stateRef.current, bayMeshes };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bays.map((b) => b.id).join(","), mode]);
  useEffect(() => {
    if (stateRef.current.onSelectRef) stateRef.current.onSelectRef.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    const bm = stateRef.current.bayMeshes;
    if (!bm) return;
    bays.forEach((bay) => {
      const m = bm[bay.id];
      if (!m) return;
      const bayStats = statsById[bay.id];
      if (bayStats) applyZoneFill(m, bay, bayStats.zoneStats, m.maxH);
      if (m.ring) m.ring.visible = mode === "yard" && bay.id === selectedId;
    });
  }, [bays, statsById, selectedId, mode]);
  return (
    <div ref={mountRef} style={{ position: "relative", width: "100%", height: "100%", cursor: "grab" }}>
      {labels.map((l) => {
        if (!l.visible) return null;
        if (l.isBuildingLabel) {
          return (
            <div key={l.key} style={{
              position: "absolute", left: l.x, top: l.y, transform: "translate(-50%,-100%)",
              pointerEvents: "none", color: "#f2c14e", fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, letterSpacing: 0.4, whiteSpace: "nowrap",
              textShadow: "0 2px 6px rgba(0,0,0,0.6)",
            }}>
              {l.buildingName}
            </div>
          );
        }
        const bay = bays.find((b) => b.id === l.bayId);
        const bayStats = statsById[l.bayId];
        if (l.isBayLabel) {
          return (
            <div key={l.key} onClick={() => onSelect(l.bayId)} style={{
              position: "absolute", left: l.x, top: l.y, transform: "translate(-50%,-100%)",
              pointerEvents: "auto", cursor: "pointer",
              background: l.bayId === selectedId ? "rgba(242,193,78,0.18)" : "rgba(14,20,32,0.72)",
              border: `1px solid ${l.bayId === selectedId ? "#f2c14e" : "#3a4457"}`,
              borderRadius: 6, padding: "5px 9px", color: "#eef1f6",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, whiteSpace: "nowrap",
              boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
            }}>
              <div style={{ fontWeight: 700 }}>{bay.name}</div>
              <div style={{ color: "#9aa4b8", marginTop: 1 }}>{Math.round((bayStats?.fillPct || 0) * 100)}% full</div>
              <YardBayAgristorBadge bay={bay} />
            </div>
          );
        }
        if (l.isPipeLabel) {
          return (
            <div key={l.key} style={{
              position: "absolute", left: l.x, top: l.y, transform: "translate(-50%,0)",
              pointerEvents: "none", color: "#8790a3", fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9.5, whiteSpace: "nowrap", textShadow: "0 1px 3px rgba(0,0,0,0.9)",
            }}>
              {l.pipeNumber}
            </div>
          );
        }
        const zs = bayStats?.zoneStats?.[l.zoneId];
        const zone = bay?.zones.find((z) => z.id === l.zoneId);
        if (!zone || !zs) return null;
        return (
          <div key={l.key} style={{
            position: "absolute", left: l.x, top: l.y, transform: "translate(-50%,-100%)",
            pointerEvents: "none", background: "rgba(14,20,32,0.82)", border: "1px solid #2b3549",
            borderRadius: 5, padding: "4px 7px", color: "#eef1f6",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, whiteSpace: "nowrap",
          }}>
            <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
              <ColorDot color={getVarietyColor(zone.variety)} /><ColorDot color={getCustomerColor(zone.customer)} /> {zone.name}
            </div>
            <div style={{ color: "#9aa4b8" }}>{zone.variety} · {zone.customer} · {zs.pipesFilled}/{zone.pipeCount} pipe · {Math.round(zs.fillPct * 100)}%</div>
          </div>
        );
      })}
    </div>
  );
}
/* =================================================================
   Map tab — Leaflet + Esri World Imagery (no API key required)
==================================================================*/
function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L);
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css"; link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(link);
    }
    const existing = document.getElementById("leaflet-js");
    if (existing) {
      const iv = setInterval(() => { if (window.L) { clearInterval(iv); resolve(window.L); } }, 50);
      return;
    }
    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    script.onload = () => resolve(window.L);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}
// One pin per complex (location), placed at the lat/lng entered for it in
// Manage Sites. Clicking a pin's popup link jumps into that complex's 3D
// yard (all of its bays) — the map is a way to get to a complex, not a
// bay-level view.
function MapTab({ locations, bays, buildingsById, statsById, onSelectLocation }) {
  const mountRef = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);
  const withCoords = locations.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng));
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !mountRef.current || mapRef.current) return;
      if (mountRef.current._leaflet_id) delete mountRef.current._leaflet_id; // guard against a stray re-init on a reused container
      const center = withCoords[0] ? [withCoords[0].lat, withCoords[0].lng] : [42.62, -113.70];
      const map = L.map(mountRef.current, { zoomControl: true }).setView(center, 12);
      const imagery = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles &copy; Esri", maxZoom: 20 }
      ).addTo(map);
      const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
      });
      L.control.layers({ "Satellite (Esri)": imagery, "Streets (OSM)": streets }, {}, { position: "topright" }).addTo(map);
      withCoords.forEach((loc) => {
        const locBays = bays.filter((b) => buildingsById[b.buildingId]?.locationId === loc.id);
        const agg = locBays.reduce((acc, b) => {
          const s = statsById[b.id] || {};
          return { cwt: acc.cwt + (s.currentCwt || 0), capacity: acc.capacity + (s.capacityCwt || 0) };
        }, { cwt: 0, capacity: 0 });
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:24px;height:24px;border-radius:50% 50% 50% 0;background:#e0a63e;border:2px solid #0e1420;transform:rotate(-45deg);box-shadow:0 0 0 1px rgba(255,255,255,0.4)"></div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 24],
        });
        const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(map);
        marker.bindPopup(
          `<div style="font-family:sans-serif;font-size:13px;min-width:190px">
             <b>${loc.name}</b><br/>
             <span style="color:#666">${loc.address || ""}</span>
             <div style="margin-top:6px">${locBays.length} bay${locBays.length === 1 ? "" : "s"}</div>
             <div>${fmt(agg.cwt)} / ${fmt(agg.capacity)} cwt (${agg.capacity ? Math.round((agg.cwt / agg.capacity) * 100) : 0}%)</div>
             <a href="#" data-loc="${loc.id}" style="color:#c17a3b">View 3D yard →</a>
           </div>`
        );
        marker.on("popupopen", () => {
          const link = document.querySelector(`a[data-loc="${loc.id}"]`);
          if (link) link.onclick = (e) => { e.preventDefault(); onSelectLocation(loc.id); };
        });
      });
      if (withCoords.length > 1) {
        const bounds = L.latLngBounds(withCoords.map((l) => [l.lat, l.lng]));
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
      }
      mapRef.current = map;
      setReady(true);
    });
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withCoords.map((l) => `${l.id}:${l.lat}:${l.lng}`).join(",")]);
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%", background: "#141b28" }} />
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#8790a3", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
          loading map…
        </div>
      )}
      <div style={{ position: "absolute", bottom: 10, left: 10, background: "rgba(14,20,32,0.82)", border: "1px solid #2b3549", borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "#8790a3", maxWidth: 300 }}>
        Basemap: Esri World Imagery (satellite, no key required). Each pin is a complex, placed at the lat/lng set in Manage Sites — click a pin, then "View 3D yard" to see its bays.
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Small UI atoms
----------------------------------------------------------------*/
function StatBlock({ label, value, sub, accent }) {
  return (
    <div style={{ flex: 1, minWidth: 140 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: "#8790a3" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "#eef1f6", fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: "#6f7890", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}
const inputStyle = {
  width: "100%", background: "#161d2b", border: "1px solid #2b3549", borderRadius: 6,
  padding: "8px 10px", color: "#eef1f6", fontSize: 13.5, fontFamily: "inherit", outline: "none", boxSizing: "border-box",
};
// "Unassigned" always leads (it's a placeholder, not a real entry); everything
// else — including a legacy value no longer on the main list — sorts alphabetically.
function customerOptions(customers, currentValue) {
  const rest = currentValue && !customers.includes(currentValue) ? [...customers, currentValue] : customers;
  return ["Unassigned", ...sortByNatural(rest)];
}
function varietyOptions(varieties, currentValue) {
  const rest = currentValue && !varieties.includes(currentValue) ? [...varieties, currentValue] : varieties;
  return sortByNatural(rest);
}
function applicatorOptions(applicators, currentValue) {
  const rest = currentValue && !applicators.includes(currentValue) ? [...applicators, currentValue] : applicators;
  return ["Unassigned", ...sortByNatural(rest)];
}
// --- Agworld field lookup -----------------------------------------------
// The syncAgworldFieldsNow / syncAgworldFields cloud functions (in this same
// Firebase project's functions/index.js) mirror Agworld into Firestore:
// seasons/{seasonId} (name/dates), fields/{fieldId} (name/farm), and the
// per-season crop data at fields/{fieldId}/seasons/{seasonId} (cropName,
// varietyName, acres). There's no "is this a potato field" flag in Agworld
// itself, so potato fields are picked out here by matching cropName.
function useAgworldSeasons() {
  const [seasons, setSeasons] = useState(null); // null = still loading
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, "seasons"));
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
        if (!cancelled) setSeasons(list);
      } catch (err) {
        console.error("Failed to load Agworld seasons:", err);
        if (!cancelled) setSeasons([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  return seasons;
}
// Defaults the Agworld season picker to whichever synced season covers the
// current calendar year (matched against its start/end date or name), so
// users don't have to manually reselect it every year — falls back to the
// most recent season (list is already sorted newest-first) if none match.
function pickDefaultSeasonId(seasons) {
  if (!seasons || seasons.length === 0) return "";
  const year = String(new Date().getFullYear());
  const match = seasons.find((s) =>
    (s.startDate && s.startDate.slice(0, 4) === year) ||
    (s.endDate && s.endDate.slice(0, 4) === year) ||
    (s.name && s.name.includes(year))
  );
  return (match || seasons[0]).id;
}
// Collection-group query across every field's "seasons" subcollection,
// narrowed to one seasonId, then joined back to each field's parent doc for
// its name/farm. Filtered client-side to fields whose synced crop looks like
// potatoes — everything else (grain, hay, etc.) that Agworld also tracks is
// left out of the picker.
function useAgworldFields(seasonId) {
  const [fields, setFields] = useState(null); // null = loading / no season picked yet
  useEffect(() => {
    if (!seasonId) { setFields(null); return; }
    let cancelled = false;
    setFields(null);
    (async () => {
      try {
        const q = query(collectionGroup(db, "seasons"), where("seasonId", "==", seasonId));
        const snap = await getDocs(q);
        const joined = await Promise.all(
          snap.docs.map(async (seasonDoc) => {
            const fieldRef = seasonDoc.ref.parent.parent; // fields/{fieldId}
            if (!fieldRef) return null;
            const fieldSnap = await getDoc(fieldRef);
            return { id: fieldRef.id, ...(fieldSnap.exists() ? fieldSnap.data() : {}), ...seasonDoc.data() };
          })
        );
        const potatoFields = joined
          .filter(Boolean)
          .filter((f) => f.cropName && /potato/i.test(f.cropName))
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        if (!cancelled) setFields(potatoFields);
      } catch (err) {
        // Most likely cause on a first-ever query like this is a missing
        // Firestore index for the collection-group filter — Firestore logs a
        // direct "create it here" link to the browser console when that
        // happens. Degrades to an empty list either way; manual entry still
        // works as the fallback.
        console.error("Failed to load Agworld fields:", err);
        if (!cancelled) setFields([]);
      }
    })();
    return () => { cancelled = true; };
  }, [seasonId]);
  return fields;
}
function agworldTabStyle(active) {
  return {
    border: `1px solid ${active ? "#e0a63e" : "#2b3549"}`,
    background: active ? "rgba(224,166,62,0.12)" : "transparent",
    color: active ? "#f2c14e" : "#8790a3",
    borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600,
  };
}
function AgworldFieldPicker({ onPick }) {
  const seasons = useAgworldSeasons();
  const [seasonId, setSeasonId] = useState("");
  useEffect(() => {
    if (seasons && seasons.length && !seasonId) setSeasonId(pickDefaultSeasonId(seasons));
  }, [seasons]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = useAgworldFields(seasonId);
  const [search, setSearch] = useState("");
  const filtered = (fields || []).filter((f) => !search || (f.name || "").toLowerCase().includes(search.toLowerCase()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Field label="Agworld season">
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} style={{ ...inputStyle, width: 160 }}>
            {seasons === null && <option value="">loading…</option>}
            {seasons?.length === 0 && <option value="">no seasons synced yet</option>}
            {seasons?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Search fields">
          <input value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...inputStyle, width: 160 }} placeholder="type to filter…" />
        </Field>
      </div>
      <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #232d40", borderRadius: 6, background: "#141b28" }}>
        {fields === null ? (
          <div style={{ padding: 10, fontSize: 12, color: "#6f7890" }}>{seasonId ? "loading fields…" : "pick a season above"}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 10, fontSize: 12, color: "#6f7890" }}>
            No potato fields synced from Agworld for this season. Try another season, or switch to "Enter manually" below.
          </div>
        ) : (
          filtered.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onPick(f)}
              style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid #1c2434", color: "#eef1f6", padding: "8px 10px", fontSize: 12.5, cursor: "pointer" }}
            >
              <div style={{ fontWeight: 600 }}>{f.name}</div>
              <div style={{ color: "#8790a3", fontSize: 11 }}>
                {f.farmName || "—"} · {f.varietyName || "variety unknown"} · {f.acres ? `${Math.round(f.acres)} ac` : "—"}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
// Shared "add one product/field to a bay" mini-form. Used both in Bay Detail
// (add product to the bay you're looking at) and in Manage Sites (add product
// to any existing bay from the structure tree). A bay can exist with zero
// fields — this is the one place a field/product gets attached to it, by
// saying exactly which of the bay's own pipe numbers it covers.
// Fields can be picked straight from Agworld's synced field list for the
// season (name + variety autofill, still editable), or typed in by hand for
// anything Agworld doesn't track (purchased loads, un-synced fields, etc.).
function AddZoneForm({ bay, varieties, customers, onAdd, nextName = "Field 1" }) {
  const [source, setSource] = useState("agworld"); // "agworld" | "manual"
  const [name, setName] = useState(nextName);
  const [variety, setVariety] = useState(varieties[0] || "");
  const [customer, setCustomer] = useState("Unassigned");
  const [pipeFrom, setPipeFrom] = useState("");
  const [pipeTo, setPipeTo] = useState("");
  // Optional — the pipe range actually exposed at the TOP of this field's
  // pile, if it's narrower than (or offset from) the bottom/base range
  // above. Leave blank for a field that hasn't been checked/doesn't need
  // this — the 3D mound just uses its normal fixed taper, same as always.
  const [topPipeFrom, setTopPipeFrom] = useState("");
  const [topPipeTo, setTopPipeTo] = useState("");
  const [cwtPerPipe, setCwtPerPipe] = useState("");
  // Optional manual correction for total cwt — see computeZoneStats'
  // actualCwtOverride handling. Leave blank to just use the pipe-count math.
  const [actualCwt, setActualCwt] = useState("");
  const [error, setError] = useState("");
  const [fromAgworld, setFromAgworld] = useState(false);
  // A bay without its own total yet falls back to whatever's already
  // assigned to other fields — so validation still catches an obviously
  // out-of-range pipe number even before someone's entered the bay's total.
  const bayPipeBound = bay.pipeCount || bay.zones.reduce((s, z) => s + zonePipeCount(z), 0) || null;
  const takenPipes = pipeRangeSet(bay.zones.flatMap((z) => z.pipeRanges || []));
  const applyAgworldField = (f) => {
    setName(f.name || nextName);
    if (f.varietyName) setVariety(f.varietyName);
    setFromAgworld(true);
    setError("");
  };
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || !variety || pipeFrom === "" || pipeTo === "") {
      setError("Needs a name, variety, and a pipe range.");
      return;
    }
    const range = { from: Number(pipeFrom), to: Number(pipeTo) };
    if (!rangeFitsBay(range, bayPipeBound)) {
      setError(`This bay only has ${bayPipeBound} pipe — pipe ${Math.max(range.from, range.to)} doesn't exist.`);
      return;
    }
    const hasTopRange = topPipeFrom !== "" && topPipeTo !== "";
    const topRange = hasTopRange ? { from: Number(topPipeFrom), to: Number(topPipeTo) } : null;
    if (topRange && !rangeFitsBay(topRange, bayPipeBound)) {
      setError(`This bay only has ${bayPipeBound} pipe — top pipe ${Math.max(topRange.from, topRange.to)} doesn't exist.`);
      return;
    }
    onAdd({
      id: uid("zone"), name: trimmed, variety, customer: customer || "Unassigned",
      pipeRanges: [range], pipeCount: pipeRangeSet([range]).size,
      ...(topRange ? { topPipeRanges: [topRange] } : {}),
      ...(cwtPerPipe ? { cwtPerPipe: Number(cwtPerPipe) } : {}),
      ...(actualCwt !== "" ? { actualCwtOverride: Number(actualCwt) } : {}),
    });
    setName(nextName); setVariety(varieties[0] || ""); setCustomer("Unassigned");
    setPipeFrom(""); setPipeTo(""); setTopPipeFrom(""); setTopPipeTo("");
    setCwtPerPipe(""); setActualCwt(""); setError(""); setFromAgworld(false);
  };
  const overlap = pipeFrom !== "" && pipeTo !== ""
    ? Array.from(pipeRangeSet([{ from: pipeFrom, to: pipeTo }])).filter((p) => takenPipes.has(p))
    : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "#0e1420", border: "1px solid #232d40", borderRadius: 8, padding: 10, width: "100%" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" onClick={() => setSource("agworld")} style={agworldTabStyle(source === "agworld")}>From Agworld</button>
        <button type="button" onClick={() => setSource("manual")} style={agworldTabStyle(source === "manual")}>Enter manually</button>
      </div>
      {source === "agworld" && <AgworldFieldPicker onPick={applyAgworldField} />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Field name">
          <input value={name} onChange={(e) => { setName(e.target.value); setFromAgworld(false); }} style={{ ...inputStyle, width: 140 }} />
        </Field>
        <Field label="Variety">
          <select value={variety} onChange={(e) => setVariety(e.target.value)} style={{ ...inputStyle, width: 130 }}>
            {varietyOptions(varieties, variety).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Customer">
          <select value={customer} onChange={(e) => setCustomer(e.target.value)} style={{ ...inputStyle, width: 130 }}>
            {customerOptions(customers, customer).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label={`Bottom pipe from (of ${bayPipeBound ?? "?"})`}>
          <input type="number" min="1" max={bayPipeBound || undefined} value={pipeFrom} onChange={(e) => setPipeFrom(e.target.value)} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 1" />
        </Field>
        <Field label="to">
          <input type="number" min="1" max={bayPipeBound || undefined} value={pipeTo} onChange={(e) => setPipeTo(e.target.value)} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 15" />
        </Field>
        <Field label="Cwt/pipe at 18' (optional)"><input type="number" value={cwtPerPipe} onChange={(e) => setCwtPerPipe(e.target.value)} style={{ ...inputStyle, width: 130 }} placeholder="e.g. 3200" /></Field>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Top pipe from (optional, if narrower)">
          <input type="number" min="1" max={bayPipeBound || undefined} value={topPipeFrom} onChange={(e) => setTopPipeFrom(e.target.value)} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 3" />
        </Field>
        <Field label="to">
          <input type="number" min="1" max={bayPipeBound || undefined} value={topPipeTo} onChange={(e) => setTopPipeTo(e.target.value)} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 12" />
        </Field>
        <Field label="Actual cwt override (optional)">
          <input type="number" value={actualCwt} onChange={(e) => setActualCwt(e.target.value)} style={{ ...inputStyle, width: 130 }} placeholder="e.g. 42000" />
        </Field>
        <Button onClick={submit}><Plus size={14} /> Add product</Button>
      </div>
      <div style={{ fontSize: 11, color: "#6f7890" }}>
        Bottom pipe is the field's full base footprint (drives cwt). Top pipe is only the range still exposed at the
        top of the pile, if it's narrower than the base — leave blank and the 3D mound just uses a standard taper.
        Actual cwt overrides the pipe-count math for this field's inventory total (e.g. to correct for shrink not yet
        reflected in the log) — the calculated number stays visible for reference.
      </div>
      {overlap.length > 0 && (
        <div style={{ fontSize: 11, color: "#e0a63e" }}>Heads up: pipe {formatPipeRanges([{ from: Math.min(...overlap), to: Math.max(...overlap) }])} is already assigned to another field in this bay.</div>
      )}
      {fromAgworld && <div style={{ fontSize: 11, color: "#8fd19e" }}>Loaded from Agworld — adjust anything above before adding.</div>}
      {error && <div style={{ width: "100%", fontSize: 12, color: "#e08787" }}>{error}</div>}
    </div>
  );
}
function NewSeasonPrompt({ activeSeasonLabel, onCancel, onConfirm }) {
  const [label, setLabel] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "#141b28", border: "1px solid #2b3549", borderRadius: 12, padding: 22, width: 420, maxWidth: "90vw" }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#eef1f6", marginBottom: 8 }}>Start a new season</div>
        <div style={{ fontSize: 12.5, color: "#8790a3", marginBottom: 14, lineHeight: 1.5 }}>
          This archives <b>{activeSeasonLabel}</b> as a read-only historical record and resets every bay's fields —
          variety, customer, fill date, pipe checks, cwt runs, and inspections — for a fresh season. Bays, buildings,
          and your customer/variety lists carry forward as-is.
        </div>
        <Field label="Label for the new season">
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} placeholder="e.g. 2026–2027" />
        </Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onConfirm(label.trim())}>Archive & start new season</Button>
        </div>
      </div>
    </div>
  );
}
function EmptySiteNotice({ onManage }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, padding: 24, color: "#8790a3" }}>
      <div style={{ fontSize: 14, color: "#c7cede" }}>No bays set up at this site yet.</div>
      <Button onClick={onManage}><Plus size={14} /> Add a bay in Manage Sites</Button>
    </div>
  );
}
function ColorDot({ color, size = 8 }) {
  return <span style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color, border: "1px solid rgba(255,255,255,0.25)", flexShrink: 0 }} />;
}
function Legend({ bays }) {
  const varieties = allVarieties(bays);
  const customers = allCustomers(bays);
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", fontSize: 11.5, color: "#8790a3" }}>
      <div>
        <div style={{ marginBottom: 5, letterSpacing: 0.3, color: "#6f7890" }}>VARIETY (pile color)</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {varieties.map(([name, color]) => (
            <span key={name} style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color={color} /> {name}</span>
          ))}
        </div>
      </div>
      <div>
        <div style={{ marginBottom: 5, letterSpacing: 0.3, color: "#6f7890" }}>CUSTOMER (top cap color)</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {customers.map(([name, color]) => (
            <span key={name} style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color={color} /> {name}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
function Button({ children, onClick, variant = "primary", style, disabled }) {
  const base = { border: "none", borderRadius: 6, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: disabled ? "default" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, opacity: disabled ? 0.5 : 1 };
  const variants = {
    primary: { background: "#e0a63e", color: "#1a1408" },
    ghost: { background: "transparent", color: "#c7cede", border: "1px solid #2b3549" },
  };
  return <button disabled={disabled} onClick={onClick} style={{ ...base, ...variants[variant], ...style }}>{children}</button>;
}
// Small red icon-only delete affordance used throughout Manage Sites —
// confirms with a plain `window.confirm` (the caller supplies the message,
// since what's actually at stake varies a lot by level: a field vs. an
// entire location's worth of buildings and bays).
function DeleteButton({ onConfirm, confirmMessage, title = "Delete", disabled, size = 13 }) {
  if (disabled) return null;
  return (
    <button
      type="button"
      title={title}
      onClick={() => { if (window.confirm(confirmMessage)) onConfirm(); }}
      style={{
        border: "1px solid #4a2b2b", background: "transparent", color: "#e08787",
        borderRadius: 6, padding: "3px 6px", cursor: "pointer", display: "inline-flex", alignItems: "center",
      }}
    >
      <Trash2 size={size} />
    </button>
  );
}
// Uncontrolled inline-editable field — saves on blur (or Enter), and resets
// its displayed value whenever the underlying prop changes (e.g. after a
// successful save round-trip), via the `key`.
function EditableInline({ value, onSave, type = "text", width, disabled, placeholder }) {
  const commit = (e) => {
    const raw = e.target.value;
    const v = type === "number" ? Number(raw) : raw;
    if (raw === "" || v === value) return;
    onSave(v);
  };
  return (
    <input
      key={value}
      defaultValue={value}
      type={type}
      disabled={disabled}
      placeholder={placeholder}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
      style={{
        background: disabled ? "transparent" : "#0e1420", border: "1px solid #232d40", borderRadius: 5,
        padding: "4px 7px", color: disabled ? "#8790a3" : "#eef1f6", fontSize: 12.5, fontFamily: "inherit",
        width: width || "auto", boxSizing: "border-box",
      }}
    />
  );
}
/* ---------------------------------------------------------------
   Agri-Stor live conditions — read-only listener on the readings the
   syncAgristorReadings / syncAgristorReadingsNow cloud functions (same
   Firebase project's functions/index.js) write hourly into
   agristorReadings/{agristorDocId(binName)}. This component never talks
   to Agri-Stor directly — it only listens to that Firestore doc. A bay
   opts in by having its "Agri-Stor bin" field (set in Manage Sites) match
   a bin name over there exactly.
----------------------------------------------------------------*/
// Must stay byte-for-byte in sync with agristorNormalizeBinName() in
// functions/index.js — same bin name has to produce the same doc id on
// both sides.
function agristorDocId(binName) {
  return (binName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function useAgristorReading(binName) {
  const [reading, setReading] = useState(undefined); // undefined = loading, null = no doc yet
  useEffect(() => {
    if (!binName) { setReading(null); return; }
    setReading(undefined);
    const ref = doc(db, "agristorReadings", agristorDocId(binName));
    const unsub = onSnapshot(
      ref,
      (snap) => setReading(snap.exists() ? snap.data() : null),
      (err) => { console.error("Agri-Stor reading listener failed:", err); setReading(null); }
    );
    return () => unsub();
  }, [binName]);
  return reading;
}
// Historical Agri-Stor points for this bin (plenum/return-air temp, panel
// Δ T), written hourly by the sync function's PHASE 2 history subcollection
// (agristorReadings/{binId}/history) — separate from the single "latest
// reading" doc useAgristorReading listens to above. Returns [] while
// loading/unlinked/no data yet; each item is the raw history doc plus its
// `date` field. Only starts accumulating from whenever that Cloud Function
// update was deployed — there's no retroactive backfill.
function useAgristorHistory(binName) {
  const [points, setPoints] = useState([]);
  useEffect(() => {
    if (!binName) { setPoints([]); return; }
    const ref = collection(db, "agristorReadings", agristorDocId(binName), "history");
    const unsub = onSnapshot(ref, (snap) => {
      setPoints(snap.docs.map((d) => d.data()));
    }, (err) => {
      console.error("Agri-Stor history listen failed:", err);
      setPoints([]);
    });
    return () => unsub();
  }, [binName]);
  return points;
}
// Same aggregation approach as buildBayDaySeries (see below): the sync runs
// hourly, so a given date can have several history points — average them
// per day rather than requiring exactly one, then recompute panel Δ T from
// the day's averaged plenum/return (rather than averaging the already-
// computed per-point deltas), matching how the physical Δ T is derived
// from averaged Top/Bottom below.
function buildAgristorDaySeries(points) {
  const dayMap = new Map();
  points.forEach((p) => {
    if (!p.date) return;
    if (!dayMap.has(p.date)) dayMap.set(p.date, { plenumSum: 0, plenumCount: 0, returnSum: 0, returnCount: 0 });
    const d = dayMap.get(p.date);
    if (p.plenumTempF != null) { d.plenumSum += p.plenumTempF; d.plenumCount += 1; }
    if (p.returnAirTempF != null) { d.returnSum += p.returnAirTempF; d.returnCount += 1; }
  });
  return Array.from(dayMap.entries())
    .map(([date, d]) => {
      const plenum = d.plenumCount ? Math.round((d.plenumSum / d.plenumCount) * 10) / 10 : null;
      const returnAir = d.returnCount ? Math.round((d.returnSum / d.returnCount) * 10) / 10 : null;
      const panelDelta = plenum != null && returnAir != null ? Math.round((returnAir - plenum) * 10) / 10 : null;
      return { date, plenum, returnAir, panelDelta };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
// Merges the physical pipe-check day series with the Agri-Stor day series
// on date, so both plot against one shared x-axis — the union of every
// date either side has data for, not just days with both.
function mergeDaySeries(physical, agristor) {
  const byDate = new Map();
  physical.forEach((r) => byDate.set(r.date, { date: r.date, top: r.top, bottom: r.bottom, actualDelta: r.delta }));
  agristor.forEach((r) => {
    const existing = byDate.get(r.date) || { date: r.date };
    byDate.set(r.date, { ...existing, plenum: r.plenum, returnAir: r.returnAir, panelDelta: r.panelDelta });
  });
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
function formatAgristorAge(ts) {
  if (!ts) return "—";
  const ms = typeof ts?.toDate === "function" ? ts.toDate().getTime() : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
// Read-only card showing this bay's latest Agri-Stor sensor reading, synced
// in by a separate scheduled Cloud Function (see agristorSync in the
// functions project) — this component never talks to Agri-Stor itself, it
// only listens to the Firestore doc that job writes.
function LiveConditionsCard({ bay }) {
  const reading = useAgristorReading(bay.agristorBinName);
  if (!bay.agristorBinName) {
    return (
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14, fontSize: 12.5, color: "#6f7890" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Thermometer size={14} color="#5b6478" /> <b style={{ color: "#8790a3" }}>Live conditions</b>
        </div>
        Not linked to an Agri-Stor bin yet — set "Agri-Stor bin name" for this bay in Manage Sites to see live temperature/CO2 readings here.
      </div>
    );
  }
  if (reading === undefined) {
    return (
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14, fontSize: 12.5, color: "#6f7890" }}>
        Loading live conditions for "{bay.agristorBinName}"…
      </div>
    );
  }
  if (reading === null) {
    return (
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14, fontSize: 12.5, color: "#6f7890" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Thermometer size={14} color="#5b6478" /> <b style={{ color: "#8790a3" }}>Live conditions</b>
        </div>
        No reading yet for "{bay.agristorBinName}" — check the name matches the Agri-Stor panel exactly, or wait for the next hourly sync.
      </div>
    );
  }
  const isError = reading.status === "network_error";
  return (
    <div style={{ background: isError ? "#1c1414" : "#141b28", border: `1px solid ${isError ? "#4a2b2b" : "#232d40"}`, borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, color: "#eef1f6" }}>
          <Thermometer size={15} color="#f2c14e" /> Live conditions — {bay.agristorBinName}
        </div>
        <div style={{ fontSize: 11.5, color: isError ? "#e08787" : "#8790a3", display: "flex", alignItems: "center", gap: 5 }}>
          {isError && <AlertTriangle size={12} />}
          {isError ? "Network error at sensor" : `OK · updated ${formatAgristorAge(reading.updatedAt)}`}
        </div>
      </div>
      {isError ? (
        // Don't present these numbers as current — the sensor has lost
        // contact, so whatever last came through could be hours or days
        // old. reading.lastGoodReadingAt (the vendor's own last-known-good
        // timestamp, distinct from reading.updatedAt which only reflects
        // when OUR sync last ran) gives an honest "stale since" age when
        // the vendor actually sends it; otherwise say so rather than guess.
        <div style={{ fontSize: 12.5, color: "#e0a3a3" }}>
          {reading.lastGoodReadingAt
            ? `Last known-good reading was ${formatAgristorAge(reading.lastGoodReadingAt)} — readings below are hidden until the sensor reconnects.`
            : "Readings are hidden until the sensor reconnects — age of the last known-good reading isn't available."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, fontSize: 12.5, color: "#c7cede" }}>
          <LiveStat label="Plenum" value={reading.plenumTempF != null ? `${reading.plenumTempF}°F` : "—"} sub={reading.plenumRH != null ? `${reading.plenumRH}% RH` : ""} />
          <LiveStat label="Return air" value={reading.returnAirTempF != null ? `${reading.returnAirTempF}°F` : "—"} sub={reading.returnAirRH != null ? `${reading.returnAirRH}% RH` : ""} />
          <LiveStat label="Outside air" value={reading.outsideAirTempF != null ? `${reading.outsideAirTempF}°F` : "—"} sub={reading.outsideAirRH != null ? `${reading.outsideAirRH}% RH` : ""} />
          <LiveStat label="Pile avg" value={reading.pileAvgTempF != null ? `${reading.pileAvgTempF}°F` : "—"} />
          <LiveStat label="CO2" value={reading.co2Ppm != null ? `${reading.co2Ppm} ppm` : "—"} />
          <LiveStat
            label="Fan / Cooling-Refrig"
            value={[reading.fanPct, reading.coolingPct ?? reading.refrigerationPct]
              .map((v) => (v != null ? `${v}%` : "—"))
              .join(" / ")}
          />
        </div>
      )}
    </div>
  );
}
// Small "equipment status" panel overlaid on the interior 3D view — styled
// like a physical control-panel display (dark bezel, rounded corners)
// rather than blending into the rest of the app chrome, since it's meant
// to read at a glance like the actual Agri-Stor touchscreen does. Purely
// read-only, same as everything else Agri-Stor-related in this app — it
// never sends anything back, it just mirrors the synced Fan %/Cooling %.
// Per how this bay's equipment is actually described day to day: Fan % and
// Refer(/Cooling) % are always shown live as numbers; "STOPPED" is the one
// plain-word state, shown only when both read 0/off. There's no attempt to
// collapse "fan-only" vs "refrigerating" into separate single-word states
// beyond that — the two live numbers already say which is which.
function EquipmentStatusPanel({ bay }) {
  const reading = useAgristorReading(bay.agristorBinName);
  if (!bay.agristorBinName || reading === null) return null;
  const loading = reading === undefined;
  const isError = !loading && reading.status === "network_error";
  const fanPct = reading?.fanPct ?? null;
  const coolPct = reading?.coolingPct ?? reading?.refrigerationPct ?? null;
  const stopped = !loading && (fanPct == null || fanPct <= 0) && (coolPct == null || coolPct <= 0);
  const fanSpinning = !loading && fanPct != null && fanPct > 0;
  const coolActive = !loading && coolPct != null && coolPct > 0;
  return (
    <div
      style={{
        position: "absolute", top: 10, right: 10, width: 190,
        background: "linear-gradient(180deg, #232c3d 0%, #161c28 100%)",
        border: "1px solid #3a4358", borderRadius: 12, padding: 3,
        boxShadow: "0 4px 14px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      <style>{`@keyframes agristorFanSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <div style={{ background: "#0a0f18", borderRadius: 9, padding: "9px 10px", border: "1px solid #1c2434" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: "#8790a3", letterSpacing: 0.4, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {bay.agristorBinName}
          </div>
          {!loading && (
            <div style={{
              display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700,
              color: isError ? "#e08787" : stopped ? "#8790a3" : "#8fd19e",
            }}>
              {isError ? <AlertTriangle size={11} color="#e08787" /> : <Power size={11} color={stopped ? "#8790a3" : "#8fd19e"} />}
              {isError ? "NETWORK ERROR" : stopped ? "STOPPED" : "RUNNING"}
            </div>
          )}
        </div>
        {loading ? (
          <div style={{ fontSize: 11, color: "#5b6478" }}>Loading…</div>
        ) : isError ? (
          // Same reasoning as LiveConditionsCard: don't show Fan/Refer as
          // live numbers when the sensor has lost contact — they could be
          // days stale. reading.lastGoodReadingAt is the vendor's own
          // last-known-good timestamp; reading.updatedAt is only ever "when
          // our sync last ran" and would misleadingly look fresh anyway.
          <div style={{ fontSize: 10.5, color: "#c99", lineHeight: 1.4 }}>
            {reading.lastGoodReadingAt
              ? `Stale since ${formatAgristorAge(reading.lastGoodReadingAt)} — hidden until reconnected.`
              : "Hidden until sensor reconnects."}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
              <Fan
                size={20}
                color={fanSpinning ? "#f2c14e" : "#4a5468"}
                style={fanSpinning ? { animation: "agristorFanSpin 1.6s linear infinite" } : undefined}
              />
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#eef1f6" }}>{fanPct != null ? `${fanPct}%` : "—"}</div>
                <div style={{ fontSize: 9.5, color: "#6f7890", letterSpacing: 0.3 }}>FAN</div>
              </div>
            </div>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7 }}>
              <Snowflake size={18} color={coolActive ? "#5fd1e6" : "#4a5468"} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#eef1f6" }}>{coolPct != null ? `${coolPct}%` : "—"}</div>
                <div style={{ fontSize: 9.5, color: "#6f7890", letterSpacing: 0.3 }}>REFER</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
// Compact Agri-Stor readout embedded in each bay's yard-view (3D map)
// label — this is the "widget on the 3D map screen" showing live
// conditions per bay without having to open it. Same state language as the
// bigger interior EquipmentStatusPanel above: Fan %/Refer % are shown live
// as numbers at all times, and "STOPPED" appears only as an extra idle-state
// word alongside them (never in place of the numbers). Renders nothing for
// a bay with no Agri-Stor bin linked, or before the first reading loads —
// so bays without Agri-Stor look exactly as they did before this was added.
function YardBayAgristorBadge({ bay }) {
  const reading = useAgristorReading(bay.agristorBinName);
  if (!bay.agristorBinName || reading === null || reading === undefined) return null;
  // Network error means the sensor has lost contact — whatever numbers came
  // through with it could be hours or days old, so don't present them as
  // live in a widget meant to be read at a glance. Flag it instead, with an
  // honest age when the vendor's own last-known-good timestamp is present.
  if (reading.status === "network_error") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, paddingTop: 3, borderTop: "1px solid #2b3549", fontSize: 9.5, color: "#e08787" }}>
        <AlertTriangle size={10} color="#e08787" />
        <span style={{ fontWeight: 700, letterSpacing: 0.3 }}>NETWORK ERROR</span>
        {reading.lastGoodReadingAt && <span style={{ color: "#c99" }}>· stale {formatAgristorAge(reading.lastGoodReadingAt)}</span>}
      </div>
    );
  }
  const fanPct = reading?.fanPct ?? null;
  const coolPct = reading?.coolingPct ?? reading?.refrigerationPct ?? null;
  const fanOn = fanPct != null && fanPct > 0;
  const coolOn = coolPct != null && coolPct > 0;
  const stopped = !fanOn && !coolOn;
  const plenum = reading?.plenumTempF ?? null;
  const returnAir = reading?.returnAirTempF ?? null;
  // Same "return air minus plenum" formula as buildAgristorDaySeries' panelDelta,
  // so this live number and the Temperature tab's historical chart always agree.
  const deltaT = plenum != null && returnAir != null ? Math.round((returnAir - plenum) * 10) / 10 : null;
  return (
    <div style={{ marginTop: 3, paddingTop: 3, borderTop: "1px solid #2b3549" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "#c7cede" }}>
          <Fan size={10} color={fanOn ? "#f2c14e" : "#4a5468"} /> {fanPct != null ? `${fanPct}%` : "—"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 9.5, color: "#c7cede" }}>
          <Snowflake size={10} color={coolOn ? "#5fd1e6" : "#4a5468"} /> {coolPct != null ? `${coolPct}%` : "—"}
        </span>
        {stopped && <span style={{ fontSize: 9, fontWeight: 700, color: "#8790a3", letterSpacing: 0.3 }}>STOPPED</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 2, fontSize: 9.5, color: "#9aa4b8" }}>
        <span>Plen {plenum != null ? `${plenum}°` : "—"}</span>
        <span>Ret {returnAir != null ? `${returnAir}°` : "—"}</span>
        <span>ΔT {deltaT != null ? `${deltaT}°` : "—"}</span>
      </div>
    </div>
  );
}
function LiveStat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: "uppercase", color: "#6f7890" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#eef1f6" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#8790a3" }}>{sub}</div>}
    </div>
  );
}
/* ---------------------------------------------------------------
   Bay detail panel (per-zone pipe checks + cwt runs) + interior 3D
----------------------------------------------------------------*/
function BayDetail({ bay, data, stats, customers, varieties, readOnly, onAddPipeCheck, onAddCwtRun, onUpdateZoneCustomer, onUpdateZoneVariety, onAddZoneToBay, onUpdateZoneMeta, onEmptyBay, onDeleteZone }) {
  const [zoneId, setZoneId] = useState(bay.zones[0]?.id ?? null);
  useEffect(() => { setZoneId(bay.zones[0]?.id ?? null); }, [bay.id]);
  const [showAddZone, setShowAddZone] = useState(false);
  useEffect(() => { setShowAddZone(false); }, [bay.id]);
  const zone = bay.zones.find((z) => z.id === zoneId);
  const zoneData = data.zones[zoneId] || { pipeChecks: [], cwtRuns: [] };
  const zs = stats.zoneStats[zoneId];
  // Potatoes get pulled from (or filled back into) both ends of a run, so a
  // log entry records up to two pipe ranges (front end + back end) rather
  // than a single count — leaves an accurate picture of exactly which pipes
  // are empty vs still full, including a full stretch left in the middle.
  // Log Pipe does double duty: "haul" pulls product out of pipe already in
  // this field's footprint; "fill" puts product into pipe (including pipe
  // not yet part of this field, growing its footprint).
  const [logType, setLogType] = useState("haul"); // "haul" | "fill"
  // Which of the field's two footprints this entry applies to — "bottom"
  // (the base range, drives cwt) or "top" (the top-of-pile range, purely
  // visual). Defaults to bottom so existing muscle memory/behavior is
  // unchanged; switching to "top" is what lets the mound's tapered top
  // face narrow over the season as reported, instead of only ever using
  // whatever top range (if any) was entered once at Add Product time.
  const [logPosition, setLogPosition] = useState("bottom"); // "bottom" | "top"
  const [rangeFrom1, setRangeFrom1] = useState("");
  const [rangeTo1, setRangeTo1] = useState("");
  const [rangeFrom2, setRangeFrom2] = useState("");
  const [rangeTo2, setRangeTo2] = useState("");
  const [checkDate, setCheckDate] = useState(todayStr());
  const [checkNote, setCheckNote] = useState("");
  const [logError, setLogError] = useState("");
  const [runDate, setRunDate] = useState(todayStr());
  const [runDest, setRunDest] = useState(zone?.customer || "Unassigned");
  const [runCwt, setRunCwt] = useState("");
  useEffect(() => { setRunDest(zone?.customer || "Unassigned"); }, [zoneId]);
  useEffect(() => { setRangeFrom1(""); setRangeTo1(""); setRangeFrom2(""); setRangeTo2(""); setLogError(""); }, [zoneId, logType, logPosition]);
  // A bay without its own total yet falls back to whatever's already
  // assigned across its fields — same fallback AddZoneForm uses.
  const bayPipeBound = bay.pipeCount || bay.zones.reduce((s, z) => s + zonePipeCount(z), 0) || null;
  const pendingRanges = [
    ...(rangeFrom1 !== "" && rangeTo1 !== "" ? [{ from: Number(rangeFrom1), to: Number(rangeTo1) }] : []),
    ...(rangeFrom2 !== "" && rangeTo2 !== "" ? [{ from: Number(rangeFrom2), to: Number(rangeTo2) }] : []),
  ];
  const submitCheck = () => {
    if (!zone || pendingRanges.length === 0) return;
    for (const r of pendingRanges) {
      if (!rangeFitsBay(r, bayPipeBound)) {
        setLogError(`This bay only has ${bayPipeBound} pipe — pipe ${Math.max(r.from, r.to)} doesn't exist.`);
        return;
      }
    }
    if (logType === "haul") {
      // Hauling from "top" checks against whichever top footprint is
      // currently in effect (an explicit top range, or — once any top
      // entry has ever been logged — the same footprint as bottom); from
      // "bottom" it's always the base pipeRanges, exactly as before.
      const footprint = logPosition === "top"
        ? pipeRangeSet(zone.topPipeRanges?.length ? zone.topPipeRanges : zone.pipeRanges)
        : pipeRangeSet(zone.pipeRanges);
      const outside = Array.from(pipeRangeSet(pendingRanges)).filter((p) => !footprint.has(p));
      if (outside.length > 0) {
        setLogError(`Pipe ${outside[0]} isn't part of ${zone.name}'s ${logPosition} pipe yet — can't haul it from here.`);
        return;
      }
    }
    setLogError("");
    onAddPipeCheck(bay.id, zoneId, { date: checkDate, type: logType, position: logPosition, ranges: pendingRanges, note: checkNote });
    setRangeFrom1(""); setRangeTo1(""); setRangeFrom2(""); setRangeTo2(""); setCheckNote("");
  };
  const submitRun = () => {
    if (!runCwt || isNaN(Number(runCwt))) return;
    onAddCwtRun(bay.id, zoneId, { date: runDate, dest: runDest, cwt: Number(runCwt) });
    setRunCwt(""); setRunDest("");
  };
  const pipeChecks = [...(zoneData.pipeChecks || [])].reverse();
  const cwtRuns = [...(zoneData.cwtRuns || [])].reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, color: "#eef1f6" }}>{bay.name}</h2>
          <div style={{ color: "#8790a3", fontSize: 12.5, marginTop: 3 }}>
            Filled {bay.fillDate} · {bay.zones.length} field{bay.zones.length !== 1 ? "s" : ""} · {bay.pipeCount || bay.zones.reduce((s, z) => s + z.pipeCount, 0)} pipes total · {bay.pileHeight || 18}' pile
          </div>
        </div>
        {!readOnly && bay.zones.length > 0 && (
          <Button
            variant="ghost"
            style={{ borderColor: "#4a2b2b", color: "#e08787" }}
            onClick={() => {
              if (window.confirm(`Empty "${bay.name}"? This unassigns all ${bay.zones.length} field${bay.zones.length !== 1 ? "s" : ""} currently in it so you can fill it with something new. Their logged checks, cwt runs, and applications are kept, not deleted — use "Delete field & records" on an individual field below if you actually want to erase its history.`)) {
                onEmptyBay(bay.id);
              }
            }}
          >
            Empty this bay
          </Button>
        )}
      </div>
      {bay.zones.length === 0 && (
        <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 14, color: "#c7cede", marginBottom: 10 }}>
            This bay is empty — no product assigned yet. Add a field below when it's ready to fill.
          </div>
          {!readOnly && (
            <AddZoneForm bay={bay} varieties={varieties} customers={customers} onAdd={(z) => onAddZoneToBay(bay.id, z)} />
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <StatBlock label="Bay inventory" value={`${fmt(stats.currentCwt)} cwt`} sub={`${Math.round(stats.fillPct * 100)}% of ${fmt(stats.capacityCwt)} cwt`} accent="#f2c14e" />
        <StatBlock label="Total run out" value={`${fmt(stats.totalRun)} cwt`} />
        <StatBlock label="Bay shrink" value={`${fmt(stats.shrinkCwt)} cwt`} sub={`${(stats.shrinkPct * 100).toFixed(2)}%`} accent={stats.shrinkPct > 0.08 ? "#e08787" : "#8fd19e"} />
      </div>
      <LiveConditionsCard bay={bay} />
      <div>
        <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <Layers size={13} /> INTERIOR VIEW — FIELD DIVISION
        </div>
        <div style={{ position: "relative", height: 300, background: "#0e1420", border: "1px solid #232d40", borderRadius: 10, overflow: "hidden" }}>
          <Scene3D bays={[bay]} statsById={{ [bay.id]: stats }} mode="interior" onSelect={() => {}} />
          <EquipmentStatusPanel bay={bay} />
        </div>
        <div style={{ marginTop: 8 }}><Legend bays={[bay]} /></div>
      </div>
      {bay.zones.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {bay.zones.map((z) => (
            <div key={z.id} style={{
              border: `1px solid ${z.id === zoneId ? "#e0a63e" : "#232d40"}`,
              background: z.id === zoneId ? "rgba(224,166,62,0.12)" : "transparent",
              borderRadius: 20, padding: "6px 8px 6px 14px", fontSize: 12.5, fontWeight: 600,
              display: "inline-flex", alignItems: "center", gap: 6,
            }}>
              <button onClick={() => setZoneId(z.id)} style={{
                border: "none", background: "none", padding: 0, cursor: "pointer", fontWeight: 600, fontSize: 12.5,
                color: z.id === zoneId ? "#f2c14e" : "#8790a3", display: "inline-flex", alignItems: "center", gap: 6,
              }}>
                <ColorDot color={getVarietyColor(z.variety)} /><ColorDot color={getCustomerColor(z.customer)} />
                {z.name} <span style={{ opacity: 0.7 }}>· {z.variety} · {z.customer}</span>
              </button>
              {!readOnly && (
                <button
                  title="Delete field & records — permanent"
                  onClick={() => {
                    if (window.confirm(`Permanently delete "${z.name}" from ${bay.name}? This erases its pipe checks, cwt runs, and Sprout Nip applications for good — this is NOT the same as "Empty this bay", which keeps records. This cannot be undone.`)) {
                      onDeleteZone(bay.id, z.id);
                    }
                  }}
                  style={{ border: "none", background: "none", padding: 3, cursor: "pointer", color: "#6f7890", display: "flex", alignItems: "center" }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          {!readOnly && (
            <Button variant="ghost" onClick={() => setShowAddZone((v) => !v)}>
              <Plus size={13} /> {showAddZone ? "Cancel" : "Add product"}
            </Button>
          )}
        </div>
      )}
      {bay.zones.length > 0 && !readOnly && showAddZone && (
        <AddZoneForm
          bay={bay} varieties={varieties} customers={customers}
          nextName={`Field ${bay.zones.length + 1}`}
          onAdd={(z) => { onAddZoneToBay(bay.id, z); setShowAddZone(false); }}
        />
      )}
      {zone && zs && (
        <>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
            <StatBlock label={`${zone.name} inventory`} value={`${fmt(zs.currentCwt)} cwt`}
              sub={zs.hasOverride
                ? `manual · calculated from checks: ${fmt(zs.calculatedCwt)} cwt · ${zs.pipesFilled}/${zone.pipeCount} pipe`
                : `${Math.round(zs.fillPct * 100)}% of ${fmt(zs.capacityCwt)} cwt · ${zs.pipesFilled}/${zone.pipeCount} pipe`}
              accent="#f2c14e" />
            <div>
              <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: "#8790a3" }}>Actual cwt override</div>
              <EditableInline
                value={zone.actualCwtOverride ?? ""} type="number" disabled={readOnly} width={110}
                placeholder={fmt(zs.calculatedCwt)}
                onSave={(v) => onUpdateZoneMeta(bay.id, zone.id, { actualCwtOverride: v })}
              />
            </div>
            <div>
              <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: "#8790a3" }}>Variety</div>
              <select value={zone.variety} disabled={readOnly} onChange={(e) => onUpdateZoneVariety(bay.id, zone.id, e.target.value)}
                style={{ ...inputStyle, marginTop: 4, width: "auto", fontSize: 14 }}>
                {varietyOptions(varieties, zone.variety).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: "#8790a3" }}>Customer / buyer</div>
              <select value={zone.customer} disabled={readOnly} onChange={(e) => onUpdateZoneCustomer(bay.id, zone.id, e.target.value)}
                style={{ ...inputStyle, marginTop: 4, width: "auto", fontSize: 14 }}>
                {customerOptions(customers, zone.customer).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <StatBlock label="Field shrink" value={`${fmt(zs.shrinkCwt)} cwt`} sub={`${(zs.shrinkPct * 100).toFixed(2)}%`} accent={zs.shrinkPct > 0.08 ? "#e08787" : "#8fd19e"} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
                <Gauge size={16} color="#f2c14e" /> Log pipe — {zone.name}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button type="button" onClick={() => setLogType("haul")} style={agworldTabStyle(logType === "haul")}>Hauling out</button>
                <button type="button" onClick={() => setLogType("fill")} style={agworldTabStyle(logType === "fill")}>Filling in</button>
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                <button type="button" onClick={() => setLogPosition("bottom")} style={agworldTabStyle(logPosition === "bottom")}>Bottom pipe</button>
                <button type="button" onClick={() => setLogPosition("top")} style={agworldTabStyle(logPosition === "top")}>Top pipe</button>
              </div>
              <div style={{ fontSize: 12, color: "#8790a3", marginBottom: 10 }}>
                {logType === "haul"
                  ? `Potatoes get pulled from both ends, so enter which pipe number ranges have been hauled out on each end of the ${logPosition} pipe. Leave the second range blank if you've only pulled from one end.`
                  : `Enter which pipe number ranges this load filled on the ${logPosition} pipe — pipe not already part of this field's ${logPosition} footprint gets added to it. Leave the second range blank if you only filled one stretch.`}
              </div>
              <Field label="Date"><input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} style={inputStyle} /></Field>
              <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 4, letterSpacing: 0.3 }}>Pipe range 1 (bay has {bayPipeBound ?? "?"} total)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input type="number" min="1" max={bayPipeBound || undefined} value={rangeFrom1} onChange={(e) => setRangeFrom1(e.target.value)} style={inputStyle} placeholder="pipe #" />
                <span style={{ color: "#6f7890", alignSelf: "center" }}>to</span>
                <input type="number" min="1" max={bayPipeBound || undefined} value={rangeTo1} onChange={(e) => setRangeTo1(e.target.value)} style={inputStyle} placeholder="pipe #" />
              </div>
              <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 4, letterSpacing: 0.3 }}>Pipe range 2 (optional — the other end)</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input type="number" min="1" max={bayPipeBound || undefined} value={rangeFrom2} onChange={(e) => setRangeFrom2(e.target.value)} style={inputStyle} placeholder="pipe #" />
                <span style={{ color: "#6f7890", alignSelf: "center" }}>to</span>
                <input type="number" min="1" max={bayPipeBound || undefined} value={rangeTo2} onChange={(e) => setRangeTo2(e.target.value)} style={inputStyle} placeholder="pipe #" />
              </div>
              <Field label="Note (optional)"><input value={checkNote} onChange={(e) => setCheckNote(e.target.value)} style={inputStyle} /></Field>
              {pendingRanges.length > 0 && (() => {
                const affected = pipeRangeSet(pendingRanges);
                if (logType === "fill") {
                  const footprint = pipeRangeSet(zone.pipeRanges);
                  const newToField = Array.from(affected).filter((p) => !footprint.has(p)).length;
                  return (
                    <div style={{ fontSize: 12.5, color: "#c7cede", marginBottom: 10 }}>
                      → Pipe {formatPipeRanges(pendingRanges)} filled ({affected.size} pipe{newToField > 0 ? `, ${newToField} new to this field` : ""}) =
                      {" "}<b style={{ color: "#f2c14e" }}>+{fmt(affected.size * zs.cwtPerPipe)} cwt</b>
                    </div>
                  );
                }
                const currentlyFull = Array.from(affected).filter((p) => zs.fullMap.get(p)).length;
                return (
                  <div style={{ fontSize: 12.5, color: "#c7cede", marginBottom: 10 }}>
                    → Pipe {formatPipeRanges(pendingRanges)} hauled out ({currentlyFull} pipe still full there) =
                    {" "}<b style={{ color: "#f2c14e" }}>-{fmt(currentlyFull * zs.cwtPerPipe)} cwt</b>
                  </div>
                );
              })()}
              {logError && <div style={{ fontSize: 12, color: "#e08787", marginBottom: 10 }}>{logError}</div>}
              <Button onClick={submitCheck} disabled={readOnly || pendingRanges.length === 0}><Plus size={14} /> Add log entry</Button>
              <div style={{ marginTop: 14, maxHeight: 150, overflowY: "auto" }}>
                {pipeChecks.length === 0 && <div style={{ color: "#5b6478", fontSize: 12 }}>No pipe logged yet.</div>}
                {pipeChecks.map((c, i) => {
                  const affected = pipeRangeSet(c.ranges).size;
                  const isFill = c.type === "fill";
                  return (
                    <div key={i} style={{ fontSize: 12, color: "#c7cede", padding: "6px 0", borderTop: "1px solid #232d40" }}>
                      <b>{c.date}</b> — {isFill ? "filled" : "hauled out"} pipe {formatPipeRanges(c.ranges)} ({affected} pipe)
                      {c.note && <div style={{ color: "#8790a3" }}>{c.note}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
                <TrendingDown size={16} color="#f2c14e" /> Log cwt run out — {zone.name}
              </div>
              <Field label="Date"><input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} style={inputStyle} /></Field>
              <Field label="Destination / buyer">
                <select value={runDest} onChange={(e) => setRunDest(e.target.value)} style={inputStyle}>
                  {customerOptions(customers, zone.customer).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Cwt run"><input type="number" min="0" value={runCwt} onChange={(e) => setRunCwt(e.target.value)} style={inputStyle} /></Field>
              <Button onClick={submitRun} disabled={readOnly}><Plus size={14} /> Add load</Button>
              <div style={{ marginTop: 14, maxHeight: 150, overflowY: "auto" }}>
                {cwtRuns.length === 0 && <div style={{ color: "#5b6478", fontSize: 12 }}>No loads logged yet.</div>}
                {cwtRuns.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#c7cede", padding: "6px 0", borderTop: "1px solid #232d40", display: "flex", justifyContent: "space-between" }}>
                    <span><b>{r.date}</b> — {r.dest}</span>
                    <span style={{ color: "#f2c14e" }}>{fmt(r.cwt)} cwt</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
/* ---------------------------------------------------------------
   Temperature tab
----------------------------------------------------------------*/
const CURING_DAYS = 30; // ~1 month post-fill, wider top/bottom spread is expected
function daysSince(fillDateStr, onDateStr) {
  if (!fillDateStr || !onDateStr) return null;
  const ms = new Date(onDateStr) - new Date(fillDateStr);
  return Math.round(ms / 86400000);
}
function deltaStatus(delta, daysIn) {
  const abs = Math.abs(delta);
  if (daysIn != null && daysIn >= 0 && daysIn <= CURING_DAYS) {
    if (abs > 7) return { level: "wide", color: "#e08787", note: "wide even for the curing period — worth a check" };
    return { level: "ok", color: "#8fd19e", note: "normal for curing (up to ~5°F expected this first month)" };
  }
  if (abs < 0.5) return { level: "tight", color: "#e0a63e", note: "tighter than target — check airflow" };
  if (abs > 3) return { level: "wide", color: "#e08787", note: "wider than target — worth a check" };
  return { level: "ok", color: "#8fd19e", note: "within normal range (target ~1.5°F)" };
}
// Averages same-day readings per position, then pairs top/bottom by nearest
// date rather than requiring an exact match — so a top reading on Monday and
// a bottom reading on Wednesday still produce a delta.
// Aggregates every reading for a bay by date, regardless of which pipe it
// came from. Same-day readings of the same position are averaged; Δ T only
// needs a Top reading and a Bottom reading recorded on the same date — they
// can come from entirely different pipes.
function buildBayDaySeries(logs) {
  const dayMap = new Map();
  logs.forEach((l) => {
    if (!dayMap.has(l.date)) dayMap.set(l.date, { topSum: 0, topCount: 0, bottomSum: 0, bottomCount: 0 });
    const d = dayMap.get(l.date);
    if (l.position === "Top") { d.topSum += l.temp; d.topCount += 1; }
    else { d.bottomSum += l.temp; d.bottomCount += 1; }
  });
  return Array.from(dayMap.entries())
    .map(([date, d]) => {
      const top = d.topCount ? Math.round((d.topSum / d.topCount) * 10) / 10 : null;
      const bottom = d.bottomCount ? Math.round((d.bottomSum / d.bottomCount) * 10) / 10 : null;
      const delta = top != null && bottom != null ? Math.round((top - bottom) * 10) / 10 : null;
      return { date, top, bottom, delta, topCount: d.topCount, bottomCount: d.bottomCount };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
// Simple per-pipe reference table: most recent Top and most recent Bottom
// logged at each individual pipe, whatever dates those happen to be.
function latestByPipe(logs) {
  const map = new Map();
  logs.forEach((l) => {
    if (!map.has(l.pipeNumber)) map.set(l.pipeNumber, {});
    const rec = map.get(l.pipeNumber);
    const key = l.position === "Top" ? "top" : "bottom";
    if (!rec[key] || rec[key].date <= l.date) rec[key] = { temp: l.temp, date: l.date };
  });
  return Array.from(map.entries())
    .map(([pipeNumber, rec]) => ({
      pipeNumber, top: rec.top || null, bottom: rec.bottom || null,
      delta: rec.top && rec.bottom ? Math.round((rec.top.temp - rec.bottom.temp) * 10) / 10 : null,
    }))
    .sort((a, b) => a.pipeNumber - b.pipeNumber);
}
function TemperatureTab({ bays, dataById, onAddTemp, onDeleteTemp, readOnly }) {
  const [bayId, setBayId] = useState(bays[0]?.id);
  const bay = bays.find((b) => b.id === bayId);
  const totalPipes = bay ? (bay.pipeCount || bay.zones.reduce((s, z) => s + z.pipeCount, 0)) : 0;
  const [pipeNumber, setPipeNumber] = useState(1);
  const [position, setPosition] = useState("Top");
  const [date, setDate] = useState(todayStr());
  const [temp, setTemp] = useState("");
  useEffect(() => { setPipeNumber(1); }, [bayId]);
  const logs = dataById[bayId]?.tempLogs || [];
  const series = useMemo(() => buildBayDaySeries(logs), [logs]);
  const pipeLatest = useMemo(() => latestByPipe(logs), [logs]);
  const latestRow = [...series].reverse().find((r) => r.delta != null) ?? null;
  const latestDelta = latestRow?.delta ?? null;
  const latestStatus = latestRow ? deltaStatus(latestRow.delta, daysSince(bay?.fillDate, latestRow.date)) : null;
  const allDeltas = series.map((r) => r.delta).filter((d) => d != null);
  const avgDelta = allDeltas.length ? Math.round((allDeltas.reduce((s, d) => s + d, 0) / allDeltas.length) * 10) / 10 : null;
  const avgStatus = avgDelta != null ? deltaStatus(avgDelta, daysSince(bay?.fillDate, latestRow?.date)) : null;
  // Agri-Stor side — live reading for the "right now" panel Δ T stat, plus
  // the hourly history (see agristorSync.js PHASE 2) for the trend chart.
  // Both are no-ops (empty/null) on a bay that isn't linked to a bin yet.
  const agristorReading = useAgristorReading(bay?.agristorBinName);
  const agristorHistory = useAgristorHistory(bay?.agristorBinName);
  const agristorSeries = useMemo(() => buildAgristorDaySeries(agristorHistory), [agristorHistory]);
  const combinedSeries = useMemo(() => mergeDaySeries(series, agristorSeries), [series, agristorSeries]);
  const livePanelDelta = agristorReading?.returnVsPlenumF ?? null;
  const submit = () => {
    if (temp === "" || isNaN(Number(temp))) return;
    onAddTemp(bayId, { date, pipeNumber, position, temp: Number(temp) });
    setTemp("");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="Bay">
          <select value={bayId} onChange={(e) => setBayId(e.target.value)} style={inputStyle}>
            {bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Pipe #">
          <select value={pipeNumber} onChange={(e) => setPipeNumber(Number(e.target.value))} style={{ ...inputStyle, width: 90 }}>
            {Array.from({ length: totalPipes }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Position">
          <div style={{ display: "flex", gap: 4 }}>
            {["Top", "Bottom"].map((p) => (
              <button key={p} onClick={() => setPosition(p)} style={{
                border: `1px solid ${position === p ? "#e0a63e" : "#2b3549"}`,
                background: position === p ? "rgba(224,166,62,0.14)" : "#161d2b",
                color: position === p ? "#f2c14e" : "#8790a3",
                borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600,
              }}>{p}</button>
            ))}
          </div>
        </Field>
        <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
        <Field label="Temp (°F)"><input type="number" value={temp} onChange={(e) => setTemp(e.target.value)} style={{ ...inputStyle, width: 110 }} /></Field>
        <Button onClick={submit} disabled={readOnly} style={{ marginBottom: 10 }}><Plus size={14} /> Log reading</Button>
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <StatBlock label={`${bay?.name} · all pipes`} value={series.length ? `${series.length} day${series.length === 1 ? "" : "s"} logged` : "no data"} sub="top vs. bottom across every pipe in this bay" />
        <StatBlock label="Current actual Δ T (top − bottom)" value={latestDelta != null ? `${latestDelta > 0 ? "+" : ""}${latestDelta}°F` : "—"}
          sub={latestStatus ? latestStatus.note : "need a Top and a Bottom reading on the same date"}
          accent={latestStatus ? latestStatus.color : undefined} />
        <StatBlock label="Average actual Δ T (all days)" value={avgDelta != null ? `${avgDelta > 0 ? "+" : ""}${avgDelta}°F` : "—"}
          sub={avgDelta != null ? `across ${allDeltas.length} day${allDeltas.length === 1 ? "" : "s"} of readings` : "need a Top and a Bottom reading on the same date"}
          accent={avgStatus ? avgStatus.color : undefined} />
        <StatBlock label="Live panel Δ T (Agri-Stor)" value={livePanelDelta != null ? `${livePanelDelta > 0 ? "+" : ""}${livePanelDelta}°F` : "—"}
          sub={bay?.agristorBinName ? "return air − plenum, right now" : "bay isn't linked to an Agri-Stor bin"} accent="#d9722e" />
      </div>
      <div style={{ fontSize: 11.5, color: "#6f7890" }}>
        Every reading in this bay counts, from any pipe. Same-day readings of the same position are averaged first;
        actual Δ T comes from that day's average Top and average Bottom — it doesn't matter which pipes they were taken at, only that they share a date.
        Target Δ T is ~1.5°F once cured. Flagged amber under ~0.5°F (too tight — check airflow), red over 3°F (too wide).
        In the first {CURING_DAYS} days after fill, up to ~5°F is normal and won't be flagged.
        Panel Δ T (return air − plenum) comes from the Agri-Stor sync instead of a physical check — it updates hourly on its own.
      </div>
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 2, color: "#eef1f6" }}>{bay?.name} — temperatures over time</div>
        <div style={{ fontSize: 11, color: "#6f7890", marginBottom: 8 }}>
          Top/Bottom are your physical pipe checks (dots mark a logged day); Plenum/Return air are the Agri-Stor sync (hourly, averaged per day).
        </div>
        {combinedSeries.length === 0 ? (
          <div style={{ color: "#5b6478", fontSize: 13 }}>No readings yet for this bay.</div>
        ) : (
          <>
            <div style={{ height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedSeries} margin={{ right: 8 }}>
                  <CartesianGrid stroke="#232d40" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#8790a3" fontSize={11} />
                  <YAxis stroke="#8790a3" fontSize={11} domain={["dataMin - 2", "dataMax + 2"]} label={{ value: "°F", angle: -90, position: "insideLeft", fill: "#8790a3", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#0e1420", border: "1px solid #2b3549", fontSize: 12 }} labelStyle={{ color: "#eef1f6" }} />
                  <Line type="monotone" dataKey="top" stroke="#f2c14e" strokeWidth={2} dot={{ r: 3 }} name="Top °F (avg)" connectNulls />
                  <Line type="monotone" dataKey="bottom" stroke="#3ba8e8" strokeWidth={2} dot={{ r: 3 }} name="Bottom °F (avg)" connectNulls />
                  <Line type="monotone" dataKey="plenum" stroke="#2cd4b5" strokeWidth={1.5} dot={false} name="Plenum °F" connectNulls />
                  <Line type="monotone" dataKey="returnAir" stroke="#e56bc0" strokeWidth={1.5} dot={false} name="Return air °F" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: "#c7cede", margin: "6px 0 14px" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#f2c14e" /> Top (physical)</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#3ba8e8" /> Bottom (physical)</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#2cd4b5" /> Plenum (Agri-Stor)</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#e56bc0" /> Return air (Agri-Stor)</span>
            </div>
            <div style={{ fontWeight: 700, marginBottom: 2, color: "#eef1f6" }}>{bay?.name} — Δ T over time</div>
            <div style={{ fontSize: 11, color: "#6f7890", marginBottom: 8 }}>
              Actual Δ T (top − bottom, from your checks) vs. panel Δ T (return air − plenum, from Agri-Stor) — same dates as the chart above.
            </div>
            <div style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={combinedSeries} margin={{ right: 8 }}>
                  <CartesianGrid stroke="#232d40" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#8790a3" fontSize={11} />
                  <YAxis stroke="#8790a3" fontSize={11} domain={["dataMin - 1", "dataMax + 1"]} label={{ value: "Δ T °F", angle: -90, position: "insideLeft", fill: "#8790a3", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#0e1420", border: "1px solid #2b3549", fontSize: 12 }} labelStyle={{ color: "#eef1f6" }} />
                  <Line type="monotone" dataKey="actualDelta" stroke="#a06bd6" strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2 }} name="Actual Δ T" connectNulls />
                  <Line type="monotone" dataKey="panelDelta" stroke="#d9722e" strokeWidth={1.5} dot={false} name="Panel Δ T" connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 11.5, color: "#c7cede", marginTop: 6 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#a06bd6" /> Actual Δ T (physical)</span>
              <span style={{ display: "flex", alignItems: "center", gap: 5 }}><ColorDot color="#d9722e" /> Panel Δ T (Agri-Stor)</span>
            </div>
          </>
        )}
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>{bay?.name} — latest reading by pipe</div>
        <div style={{ overflowX: "auto", border: "1px solid #232d40", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#141b28", textAlign: "left" }}>
                <th style={thStyle}>Pipe #</th>
                <th style={thStyle}>Top °F</th>
                <th style={thStyle}>Bottom °F</th>
                <th style={thStyle}>Δ T</th>
              </tr>
            </thead>
            <tbody>
              {pipeLatest.length === 0 && (
                <tr><td colSpan={4} style={{ ...tdStyle, color: "#5b6478" }}>No readings logged for this bay yet.</td></tr>
              )}
              {pipeLatest.map((r) => {
                const refDate = [r.top?.date, r.bottom?.date].filter(Boolean).sort().pop();
                const status = r.delta != null ? deltaStatus(r.delta, daysSince(bay?.fillDate, refDate)) : null;
                return (
                  <tr key={r.pipeNumber} style={{ borderTop: "1px solid #232d40" }}>
                    <td style={tdStyle}><b style={{ color: "#eef1f6" }}>{r.pipeNumber}</b></td>
                    <td style={{ ...tdStyle, color: "#f2c14e" }}>{r.top ? `${r.top.temp}°F` : "—"}</td>
                    <td style={{ ...tdStyle, color: "#3ba8e8" }}>{r.bottom ? `${r.bottom.temp}°F` : "—"}</td>
                    <td style={{ ...tdStyle, color: status ? status.color : "#c7cede" }}>
                      {r.delta != null ? `${r.delta > 0 ? "+" : ""}${r.delta}°F` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 2, color: "#eef1f6" }}>{bay?.name} — manual entries</div>
        <div style={{ fontSize: 11, color: "#6f7890", marginBottom: 8 }}>
          Every reading logged for this bay, most recent first — the "latest by pipe" table above only shows the newest per pipe/position, so delete an individual mis-entered reading here.
        </div>
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 300, border: "1px solid #232d40", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#141b28", textAlign: "left" }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Pipe #</th>
                <th style={thStyle}>Position</th>
                <th style={thStyle}>Temp °F</th>
                {!readOnly && <th style={thStyle}></th>}
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={readOnly ? 4 : 5} style={{ ...tdStyle, color: "#5b6478" }}>No manual entries logged for this bay yet.</td></tr>
              )}
              {logs.map((entry, i) => ({ entry, i })).slice().reverse().map(({ entry, i }) => (
                <tr key={i} style={{ borderTop: "1px solid #232d40" }}>
                  <td style={tdStyle}>{entry.date}</td>
                  <td style={tdStyle}><b style={{ color: "#eef1f6" }}>{entry.pipeNumber}</b></td>
                  <td style={{ ...tdStyle, color: entry.position === "Top" ? "#f2c14e" : "#3ba8e8" }}>{entry.position}</td>
                  <td style={tdStyle}>{entry.temp}°F</td>
                  {!readOnly && (
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <button
                        type="button"
                        title="Delete this entry"
                        onClick={() => {
                          if (window.confirm(`Delete this ${entry.position?.toLowerCase()} reading — ${entry.temp}°F, pipe ${entry.pipeNumber}, ${entry.date}? This cannot be undone.`)) {
                            onDeleteTemp(bayId, i);
                          }
                        }}
                        style={{ background: "none", border: "none", color: "#8790a3", cursor: "pointer", padding: 4, display: "flex", alignItems: "center", marginLeft: "auto" }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Inspections tab
----------------------------------------------------------------*/
const CHECKLIST_ITEMS = ["Fans running", "Doors / curtains sealed", "Signs of rot or pests", "Condensation / humidity ok", "Temperature within target"];
function InspectionsTab({ bays, inspections, onAdd, readOnly }) {
  const [bayId, setBayId] = useState(bays[0]?.id);
  const [date, setDate] = useState(todayStr());
  const [inspector, setInspector] = useState("");
  const [notes, setNotes] = useState("");
  const [results, setResults] = useState({});
  const toggle = (item) => setResults((r) => ({ ...r, [item]: r[item] === "issue" ? "ok" : r[item] === "ok" ? undefined : "ok" }));
  const submit = () => {
    onAdd({ id: `${Date.now()}`, bayId, date, inspector: inspector || "Unnamed", results, notes });
    setNotes(""); setResults({}); setInspector("");
  };
  const list = [...inspections].reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
          <ClipboardCheck size={16} color="#f2c14e" /> New check
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Field label="Bay">
            <select value={bayId} onChange={(e) => setBayId(e.target.value)} style={inputStyle}>
              {bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Inspector"><input value={inspector} onChange={(e) => setInspector(e.target.value)} style={inputStyle} placeholder="name" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, margin: "6px 0 14px" }}>
          {CHECKLIST_ITEMS.map((item) => {
            const state = results[item];
            const color = state === "issue" ? "#e08787" : state === "ok" ? "#8fd19e" : "#8790a3";
            const bg = state === "issue" ? "#3a2230" : state === "ok" ? "#1c3324" : "#161d2b";
            return (
              <div key={item} onClick={() => toggle(item)} style={{ cursor: "pointer", padding: "8px 10px", borderRadius: 6, fontSize: 12.5, background: bg, border: `1px solid ${color}55`, color, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                {item}{state === "issue" && <AlertTriangle size={14} />}{state === "ok" && <Check size={14} />}
              </div>
            );
          })}
        </div>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} /></Field>
        <Button onClick={submit} disabled={readOnly}><Plus size={14} /> Save check</Button>
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>History</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.length === 0 && <div style={{ color: "#5b6478", fontSize: 13 }}>No checks recorded yet.</div>}
          {list.map((insp) => {
            const bay = bays.find((b) => b.id === insp.bayId);
            const issues = Object.entries(insp.results || {}).filter(([, v]) => v === "issue");
            return (
              <div key={insp.id} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 13, color: "#eef1f6", fontWeight: 700 }}>{bay?.name || "—"} <span style={{ color: "#8790a3", fontWeight: 400 }}>· {insp.date} · {insp.inspector}</span></div>
                  {issues.length > 0 ? <span style={{ color: "#e08787", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}><AlertTriangle size={13} /> {issues.length} issue(s)</span>
                    : <span style={{ color: "#8fd19e", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}><Check size={13} /> all clear</span>}
                </div>
                {issues.length > 0 && <div style={{ fontSize: 12, color: "#e08787", marginTop: 4 }}>{issues.map(([k]) => k).join(", ")}</div>}
                {insp.notes && <div style={{ fontSize: 12, color: "#8790a3", marginTop: 4 }}>{insp.notes}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Sprout Nip tab — product library (with per-customer restriction
   rules), applicator roster, application logging per field, and
   history. Applications are season-scoped like everything else in
   bayData, so they archive and reset with the season.
----------------------------------------------------------------*/
function SproutNipTab({ bays, dataById, customers, products, applicators, readOnly, onAddSproutApplication, onAddProduct, onUpdateProductRestrictions, onAddApplicator }) {
  const [bayId, setBayId] = useState(bays[0]?.id);
  const bay = bays.find((b) => b.id === bayId);
  const [zoneId, setZoneId] = useState(bay?.zones[0]?.id);
  useEffect(() => { setZoneId(bays.find((b) => b.id === bayId)?.zones[0]?.id); }, [bayId, bays]);
  const zone = bay?.zones.find((z) => z.id === zoneId);
  const zoneData = dataById[bayId]?.zones?.[zoneId] || { sproutApplications: [] };
  const [productId, setProductId] = useState(products[0]?.id || "");
  useEffect(() => { if (!products.find((p) => p.id === productId)) setProductId(products[0]?.id || ""); }, [products, productId]);
  const [date, setDate] = useState(todayStr());
  const [rate, setRate] = useState("");
  const [rateUnit, setRateUnit] = useState("fl oz/cwt");
  const [cwtApplied, setCwtApplied] = useState("");
  const [applicator, setApplicator] = useState("Unassigned");
  const [appError, setAppError] = useState("");
  const selectedProduct = products.find((p) => p.id === productId);
  const blocked = !!(selectedProduct && zone && selectedProduct.restrictedCustomers.includes(zone.customer));
  const submitApplication = () => {
    if (readOnly) return;
    if (blocked) { setAppError(`${selectedProduct.name} is restricted for ${zone.customer} — pick a different product or field.`); return; }
    if (!productId || !rate || !cwtApplied) { setAppError("Product, rate, and cwt applied are all required."); return; }
    onAddSproutApplication(bayId, zoneId, {
      id: uid("app"), date, productId, productName: selectedProduct?.name || "Unknown product",
      rate: Number(rate), rateUnit, cwtApplied: Number(cwtApplied), applicator,
    });
    setRate(""); setCwtApplied(""); setAppError("");
  };
  const [newProductName, setNewProductName] = useState("");
  const [productError, setProductError] = useState("");
  const addProduct = () => {
    const trimmed = newProductName.trim();
    if (!trimmed) return;
    if (products.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) { setProductError(`"${trimmed}" is already on the list.`); return; }
    onAddProduct({ id: uid("prod"), name: trimmed, restrictedCustomers: [] });
    setNewProductName(""); setProductError("");
  };
  const [newApplicatorName, setNewApplicatorName] = useState("");
  const addApplicator = () => {
    const trimmed = newApplicatorName.trim();
    if (!trimmed) return;
    onAddApplicator(trimmed);
    setNewApplicatorName("");
  };
  const toggleRestriction = (product, customerName) => {
    const next = product.restrictedCustomers.includes(customerName)
      ? product.restrictedCustomers.filter((c) => c !== customerName)
      : [...product.restrictedCustomers, customerName];
    onUpdateProductRestrictions(product.id, next);
  };
  const history = [...(zoneData.sproutApplications || [])].reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Product library */}
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
          <FlaskConical size={16} color="#f2c14e" /> Product library
        </div>
        <div style={{ fontSize: 12, color: "#8790a3", marginBottom: 12 }}>
          Check a customer to block that product from ever being logged against their potatoes.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {products.map((p) => (
            <div key={p.id} style={{ background: "#0e1420", border: "1px solid #232d40", borderRadius: 8, padding: 12 }}>
              <div style={{ fontWeight: 700, color: "#eef1f6", marginBottom: 8 }}>{p.name}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {customers.map((c) => {
                  const isRestricted = p.restrictedCustomers.includes(c);
                  return (
                    <button key={c} onClick={() => toggleRestriction(p, c)} style={{
                      border: `1px solid ${isRestricted ? "#e08787" : "#2b3549"}`,
                      background: isRestricted ? "rgba(224,135,135,0.14)" : "transparent",
                      color: isRestricted ? "#e08787" : "#8790a3",
                      borderRadius: 20, padding: "4px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600,
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      {isRestricted && <AlertTriangle size={11} />} {c}
                    </button>
                  );
                })}
                {customers.length === 0 && <span style={{ fontSize: 12, color: "#5b6478" }}>Add customers first to set restrictions.</span>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input value={newProductName} onChange={(e) => { setNewProductName(e.target.value); setProductError(""); }}
            onKeyDown={(e) => e.key === "Enter" && addProduct()} style={{ ...inputStyle, flex: 1 }} placeholder="Add a product, e.g. 1,4 SIGHT" />
          <Button onClick={addProduct}><Plus size={14} /> Add</Button>
        </div>
        {productError && <div style={{ fontSize: 12, color: "#e08787", marginTop: 6 }}>{productError}</div>}
      </div>
      {/* Applicator companies */}
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>Applicator companies</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {applicators.map((a) => <span key={a} style={{ fontSize: 12.5, color: "#c7cede", background: "#0e1420", border: "1px solid #232d40", borderRadius: 20, padding: "5px 12px" }}>{a}</span>)}
          {applicators.length === 0 && <span style={{ fontSize: 12, color: "#5b6478" }}>No applicator companies added yet.</span>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newApplicatorName} onChange={(e) => setNewApplicatorName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addApplicator()} style={{ ...inputStyle, flex: 1 }} placeholder="Add a company, e.g. Western Ag Applicators" />
          <Button onClick={addApplicator}><Plus size={14} /> Add</Button>
        </div>
      </div>
      {/* Log application */}
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>Log an application</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label="Bay">
            <select value={bayId} onChange={(e) => setBayId(e.target.value)} style={inputStyle}>
              {bays.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Field">
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
              {(bay?.zones || []).map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select value={productId} onChange={(e) => { setProductId(e.target.value); setAppError(""); }} style={inputStyle}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Field label="Rate"><input type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} style={{ ...inputStyle, width: 110 }} /></Field>
          <Field label="Rate unit"><input value={rateUnit} onChange={(e) => setRateUnit(e.target.value)} style={{ ...inputStyle, width: 130 }} /></Field>
          <Field label="Cwt applied to"><input type="number" min="0" value={cwtApplied} onChange={(e) => setCwtApplied(e.target.value)} style={{ ...inputStyle, width: 140 }} /></Field>
          <Field label="Applicator company">
            <select value={applicator} onChange={(e) => setApplicator(e.target.value)} style={inputStyle}>
              {applicatorOptions(applicators, applicator).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        </div>
        {zone && (
          <div style={{ fontSize: 12.5, color: "#8790a3", margin: "4px 0 10px" }}>
            {zone.name} is <ColorDot color={getCustomerColor(zone.customer)} size={7} /> <b style={{ color: "#c7cede" }}>{zone.customer}</b>'s potatoes.
          </div>
        )}
        {blocked && (
          <div style={{ fontSize: 12.5, color: "#e08787", display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
            <AlertTriangle size={14} /> {selectedProduct.name} is restricted for {zone.customer} — this can't be logged until you change the product or the field.
          </div>
        )}
        {appError && !blocked && <div style={{ fontSize: 12.5, color: "#e08787", marginBottom: 10 }}>{appError}</div>}
        <Button onClick={submitApplication} disabled={readOnly || blocked}><Plus size={14} /> Log application</Button>
      </div>
      {/* History */}
      <div>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>{bay?.name} — {zone?.name} application history</div>
        <div style={{ overflowX: "auto", border: "1px solid #232d40", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#141b28", textAlign: "left" }}>
                <th style={thStyle}>Date</th>
                <th style={thStyle}>Product</th>
                <th style={thStyle}>Rate</th>
                <th style={thStyle}>Cwt applied</th>
                <th style={thStyle}>Applicator</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && <tr><td colSpan={5} style={{ ...tdStyle, color: "#5b6478" }}>No applications logged for this field yet.</td></tr>}
              {history.map((a) => (
                <tr key={a.id} style={{ borderTop: "1px solid #232d40" }}>
                  <td style={tdStyle}><b style={{ color: "#eef1f6" }}>{a.date}</b></td>
                  <td style={tdStyle}>{a.productName}</td>
                  <td style={tdStyle}>{a.rate} {a.rateUnit}</td>
                  <td style={tdStyle}>{fmt(a.cwtApplied)} cwt</td>
                  <td style={tdStyle}>{a.applicator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Customers tab — manage the customer roster. This is the only
   place new customers get created; every other customer field in
   the app is a select restricted to this list.
----------------------------------------------------------------*/
function CustomersTab({ customers, bays, onAdd }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (customers.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
      setError(`"${trimmed}" is already on the list.`);
      return;
    }
    onAdd(trimmed);
    setName(""); setError("");
  };
  const usage = useMemo(() => {
    const map = new Map(customers.map((c) => [c, { fields: 0, pipes: 0 }]));
    bays.forEach((bay) => bay.zones.forEach((z) => {
      if (!map.has(z.customer)) map.set(z.customer, { fields: 0, pipes: 0 });
      const u = map.get(z.customer);
      u.fields += 1; u.pipes += z.pipeCount;
    }));
    return map;
  }, [customers, bays]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}>
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
          <Users size={16} color="#f2c14e" /> Add a customer
        </div>
        <div style={{ fontSize: 12, color: "#8790a3", marginBottom: 10 }}>
          Every customer/buyer field elsewhere in the app only lets you pick from this list — add one here first.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            style={{ ...inputStyle, flex: 1 }} placeholder="e.g. Idahoan Foods" />
          <Button onClick={submit}><Plus size={14} /> Add</Button>
        </div>
        {error && <div style={{ fontSize: 12, color: "#e08787", marginTop: 8 }}>{error}</div>}
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>Current customers</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {customers.map((c) => {
            const u = usage.get(c) || { fields: 0, pipes: 0 };
            return (
              <div key={c} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, color: "#eef1f6", fontWeight: 600 }}>
                  <ColorDot color={getCustomerColor(c)} size={10} /> {c}
                </span>
                <span style={{ fontSize: 12, color: "#8790a3" }}>{u.fields} field{u.fields === 1 ? "" : "s"} assigned</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Varieties tab — manage the variety roster, same pattern as customers.
----------------------------------------------------------------*/
function VarietiesTab({ varieties, bays, onAdd }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (varieties.some((v) => v.toLowerCase() === trimmed.toLowerCase())) {
      setError(`"${trimmed}" is already on the list.`);
      return;
    }
    onAdd(trimmed);
    setName(""); setError("");
  };
  const usage = useMemo(() => {
    const map = new Map(varieties.map((v) => [v, { fields: 0, pipes: 0 }]));
    bays.forEach((bay) => bay.zones.forEach((z) => {
      if (!map.has(z.variety)) map.set(z.variety, { fields: 0, pipes: 0 });
      const u = map.get(z.variety);
      u.fields += 1; u.pipes += z.pipeCount;
    }));
    return map;
  }, [varieties, bays]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}>
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
          <Sprout size={16} color="#f2c14e" /> Add a variety
        </div>
        <div style={{ fontSize: 12, color: "#8790a3", marginBottom: 10 }}>
          Every variety field elsewhere in the app only lets you pick from this list — add one here first.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            style={{ ...inputStyle, flex: 1 }} placeholder="e.g. Alturas" />
          <Button onClick={submit}><Plus size={14} /> Add</Button>
        </div>
        {error && <div style={{ fontSize: 12, color: "#e08787", marginTop: 8 }}>{error}</div>}
      </div>
      <div>
        <div style={{ fontWeight: 700, marginBottom: 10, color: "#eef1f6" }}>Current varieties</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {varieties.map((v) => {
            const u = usage.get(v) || { fields: 0, pipes: 0 };
            return (
              <div key={v} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, color: "#eef1f6", fontWeight: 600 }}>
                  <ColorDot color={getVarietyColor(v)} size={10} /> {v}
                </span>
                <span style={{ fontSize: 12, color: "#8790a3" }}>{u.fields} field{u.fields === 1 ? "" : "s"} assigned</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
/* ---------------------------------------------------------------
   Manage tab — create Locations (complexes), Buildings, and Bays
   (with their fields) without touching code.
----------------------------------------------------------------*/
function ManageTab({ locations, buildings, bays, varieties, customers, readOnly, onAddLocation, onAddBuilding, onAddBay, onUpdateLocation, onUpdateBuilding, onUpdateBayMeta, onUpdateZoneMeta, onAddZoneToBay, onEmptyBay, onEmptyAllBays, onDeleteLocation, onDeleteBuilding, onDeleteBay, onDeleteZone }) {
  const [showEmptyAll, setShowEmptyAll] = useState(false);
  const filledBayCount = bays.filter((b) => b.zones.length > 0).length;
  // --- add location ---
  const [locName, setLocName] = useState("");
  const [locAddress, setLocAddress] = useState("");
  const [locLat, setLocLat] = useState("");
  const [locLng, setLocLng] = useState("");
  const [locError, setLocError] = useState("");
  const submitLocation = () => {
    const trimmed = locName.trim();
    if (!trimmed) return;
    if (locations.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
      setLocError(`"${trimmed}" already exists.`); return;
    }
    onAddLocation({
      id: uid("loc"), name: trimmed, address: locAddress.trim() || "Address TBD",
      lat: locLat !== "" ? Number(locLat) : 42.62, lng: locLng !== "" ? Number(locLng) : -113.70,
    });
    setLocName(""); setLocAddress(""); setLocLat(""); setLocLng(""); setLocError("");
  };
  // --- add building ---
  const [bldgLocationId, setBldgLocationId] = useState(locations[0]?.id || "");
  const [bldgName, setBldgName] = useState("");
  const [bldgCwtPerPipe, setBldgCwtPerPipe] = useState("");
  const [bldgPileHeight, setBldgPileHeight] = useState(18);
  const [bldgError, setBldgError] = useState("");
  const submitBuilding = () => {
    const trimmed = bldgName.trim();
    if (!trimmed || !bldgLocationId) return;
    if (buildings.some((b) => b.locationId === bldgLocationId && b.name.toLowerCase() === trimmed.toLowerCase())) {
      setBldgError(`"${trimmed}" already exists at this location.`); return;
    }
    onAddBuilding({
      id: uid("bldg"), name: trimmed, locationId: bldgLocationId, pileHeight: bldgPileHeight,
      ...(bldgCwtPerPipe ? { cwtPerPipe: Number(bldgCwtPerPipe) } : {}),
    });
    setBldgName(""); setBldgCwtPerPipe(""); setBldgPileHeight(18); setBldgError("");
  };
  // --- add bay (with zones) ---
  const [bayLocationId, setBayLocationId] = useState(locations[0]?.id || "");
  const buildingsHere = buildings.filter((b) => b.locationId === bayLocationId);
  const [bayBuildingId, setBayBuildingId] = useState(buildingsHere[0]?.id || "");
  useEffect(() => {
    const opts = buildings.filter((b) => b.locationId === bayLocationId);
    setBayBuildingId(opts[0]?.id || "");
  }, [bayLocationId, buildings]);
  const [bayName, setBayName] = useState("");
  const [bayFillDate, setBayFillDate] = useState(todayStr());
  const [bayPipeCount, setBayPipeCount] = useState("");
  const [bayCwtPerPipe, setBayCwtPerPipe] = useState("");
  const [bayPileHeight, setBayPileHeight] = useState(18);
  // Optional — ties this bay to a bin in the Agri-Stor monitoring panel so a
  // scheduled sync knows which bay to attach live temperature/CO2/etc.
  // readings to. Must match that panel's bin name exactly (e.g. "Hidden
  // Valley 1-2").
  const [bayAgristorBin, setBayAgristorBin] = useState("");
  // Prefill the bay's cwt/pipe and pile height from its building's defaults
  // whenever the building changes — but only while still untouched, so it
  // never clobbers something already picked/typed in.
  const bayCwtTouched = useRef(false);
  const bayPileHeightTouched = useRef(false);
  useEffect(() => {
    const bldg = buildings.find((b) => b.id === bayBuildingId);
    if (!bayCwtTouched.current) setBayCwtPerPipe(bldg?.cwtPerPipe ? String(bldg.cwtPerPipe) : "");
    if (!bayPileHeightTouched.current) setBayPileHeight(bldg?.pileHeight || 18);
  }, [bayBuildingId, buildings]);
  // A bay can be created empty — product/fields get added afterward, once
  // there's something to fill it with. These rows are an optional shortcut
  // for adding fields right away if you already know them.
  const [zoneRows, setZoneRows] = useState([]);
  const [bayError, setBayError] = useState("");
  const updateZoneRow = (i, patch) => setZoneRows((rows) => rows.map((r, ri) => ri === i ? { ...r, ...patch } : r));
  const addZoneRow = () => setZoneRows((rows) => [...rows, { name: `Field ${rows.length + 1}`, variety: varieties[0] || "", customer: "Unassigned", pipeFrom: "", pipeTo: "", cwtPerPipe: "" }]);
  const removeZoneRow = (i) => setZoneRows((rows) => rows.filter((_, ri) => ri !== i));
  const zoneRowPipeSum = zoneRows.reduce((s, r) => s + pipeRangeSet([{ from: r.pipeFrom, to: r.pipeTo }]).size, 0);
  const bayPipeBound = bayPipeCount !== "" ? Number(bayPipeCount) : null;
  const submitBay = () => {
    const trimmed = bayName.trim();
    if (!trimmed) { setBayError("Give the bay a name."); return; }
    if (!bayBuildingId) { setBayError("Pick or create a building first."); return; }
    for (const r of zoneRows) {
      if (!r.name.trim() || !r.variety || r.pipeFrom === "" || r.pipeTo === "") {
        setBayError("Every field needs a name, variety, and a pipe range."); return;
      }
      if (!rangeFitsBay({ from: r.pipeFrom, to: r.pipeTo }, bayPipeBound)) {
        setBayError(`"${r.name}" references pipe outside the ${bayPipeBound} total entered for this bay.`); return;
      }
    }
    const bayId = uid("bay");
    const zones = zoneRows.map((r) => {
      const range = { from: Number(r.pipeFrom), to: Number(r.pipeTo) };
      return {
        id: uid("zone"), name: r.name.trim(), variety: r.variety, customer: r.customer || "Unassigned",
        pipeRanges: [range], pipeCount: pipeRangeSet([range]).size,
        ...(r.cwtPerPipe ? { cwtPerPipe: Number(r.cwtPerPipe) } : {}),
      };
    });
    onAddBay({
      id: bayId, name: trimmed, buildingId: bayBuildingId, fillDate: bayFillDate,
      pipeCount: bayPipeBound ?? (zoneRowPipeSum || null),
      cwtPerPipe: bayCwtPerPipe !== "" ? Number(bayCwtPerPipe) : 2500,
      pileHeight: bayPileHeight,
      agristorBinName: bayAgristorBin.trim() || null,
      zones,
    });
    setBayName(""); setBayPipeCount(""); bayCwtTouched.current = false; bayPileHeightTouched.current = false;
    setBayAgristorBin(""); setZoneRows([]);
    setBayError("");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 900 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {/* Location */}
        <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
            <MapPin size={16} color="#f2c14e" /> Add a location (complex)
          </div>
          <Field label="Name"><input value={locName} onChange={(e) => setLocName(e.target.value)} style={inputStyle} placeholder="e.g. Hidden Valley" /></Field>
          <Field label="Address"><input value={locAddress} onChange={(e) => setLocAddress(e.target.value)} style={inputStyle} placeholder="street, city, ID" /></Field>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Latitude"><input value={locLat} onChange={(e) => setLocLat(e.target.value)} style={inputStyle} placeholder="42.62" /></Field>
            <Field label="Longitude"><input value={locLng} onChange={(e) => setLocLng(e.target.value)} style={inputStyle} placeholder="-113.70" /></Field>
          </div>
          {locError && <div style={{ fontSize: 12, color: "#e08787", marginBottom: 8 }}>{locError}</div>}
          <Button onClick={submitLocation}><Plus size={14} /> Add location</Button>
        </div>
        {/* Building */}
        <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
            <Building2 size={16} color="#f2c14e" /> Add a building
          </div>
          <Field label="Location">
            <select value={bldgLocationId} onChange={(e) => setBldgLocationId(e.target.value)} style={inputStyle}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Building name"><input value={bldgName} onChange={(e) => setBldgName(e.target.value)} style={inputStyle} placeholder="e.g. Hidden Valley 1–2 Building" /></Field>
          <div style={{ display: "flex", gap: 10 }}>
            <Field label="Approx. cwt/pipe at an 18' pile (optional)">
              <input type="number" value={bldgCwtPerPipe} onChange={(e) => setBldgCwtPerPipe(e.target.value)} style={{ ...inputStyle, width: 150 }} placeholder="e.g. 3200" />
            </Field>
            <Field label="Default pile height for new bays">
              <select value={bldgPileHeight} onChange={(e) => setBldgPileHeight(Number(e.target.value))} style={{ ...inputStyle, width: 100 }}>
                {PILE_HEIGHT_OPTIONS.map((h) => <option key={h} value={h}>{h}'</option>)}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 11, color: "#5b6478", marginBottom: 8 }}>
            Both prefill whenever a new bay is added to this building — each bay can still override them. Cwt/pipe should
            always be entered as if piled 18' high; a bay marked as a 9' pile automatically gets about half that.
          </div>
          {bldgError && <div style={{ fontSize: 12, color: "#e08787", marginBottom: 8 }}>{bldgError}</div>}
          <Button onClick={submitBuilding} disabled={!locations.length}><Plus size={14} /> Add building</Button>
        </div>
      </div>
      {/* Bay + fields */}
      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, color: "#eef1f6" }}>
          <Package size={16} color="#f2c14e" /> Add a bay
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Field label="Location">
            <select value={bayLocationId} onChange={(e) => setBayLocationId(e.target.value)} style={inputStyle}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Building">
            <select value={bayBuildingId} onChange={(e) => setBayBuildingId(e.target.value)} style={inputStyle}>
              {buildingsHere.length === 0 && <option value="">— add a building first —</option>}
              {buildingsHere.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label="Bay name"><input value={bayName} onChange={(e) => setBayName(e.target.value)} style={inputStyle} placeholder="e.g. Hidden Valley #1" /></Field>
          <Field label="Fill date"><input type="date" value={bayFillDate} onChange={(e) => setBayFillDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Total pipe in this bay">
            <input type="number" min="1" value={bayPipeCount} onChange={(e) => setBayPipeCount(e.target.value)} style={{ ...inputStyle, width: 110 }} placeholder={zoneRowPipeSum ? String(zoneRowPipeSum) : "e.g. 40"} />
          </Field>
          <Field label="Cwt/pipe (at 18' pile)">
            <input
              type="number"
              value={bayCwtPerPipe}
              onChange={(e) => { bayCwtTouched.current = true; setBayCwtPerPipe(e.target.value); }}
              style={{ ...inputStyle, width: 110 }}
              placeholder="e.g. 3200"
            />
          </Field>
          <Field label="Pile height">
            <select
              value={bayPileHeight}
              onChange={(e) => { bayPileHeightTouched.current = true; setBayPileHeight(Number(e.target.value)); }}
              style={{ ...inputStyle, width: 90 }}
            >
              {PILE_HEIGHT_OPTIONS.map((h) => <option key={h} value={h}>{h}'</option>)}
            </select>
          </Field>
          <Field label="Agri-Stor bin name (optional)">
            <input
              value={bayAgristorBin}
              onChange={(e) => setBayAgristorBin(e.target.value)}
              style={{ ...inputStyle, width: 160 }}
              placeholder="e.g. Hidden Valley 1-2"
            />
          </Field>
        </div>
        <div style={{ fontSize: 11, color: "#5b6478", margin: "6px 0" }}>
          Leave "Total pipe" blank to use the sum of the fields below once they're filled in. Cwt/pipe and pile height
          prefill from the building's defaults and can be changed here or later. Always enter cwt/pipe as if piled 18'
          high — a 9' pile automatically holds about half that. "Agri-Stor bin name" must match that panel's bin name
          exactly — it's how the hourly sync knows which bay a reading belongs to.
          {bayPileHeight === 9 && bayCwtPerPipe !== "" && !isNaN(Number(bayCwtPerPipe)) && (
            <> <b style={{ color: "#e0a63e" }}>≈ {fmt(Number(bayCwtPerPipe) * 0.5)} cwt/pipe effective at 9'.</b></>
          )}
        </div>
        <div style={{ fontSize: 11, color: "#8790a3", margin: "10px 0 6px", letterSpacing: 0.3 }}>
          FIELDS IN THIS BAY (OPTIONAL — you can create the bay empty and add product later)
        </div>
        {zoneRows.length === 0 && (
          <div style={{ fontSize: 12, color: "#5b6478", marginBottom: 4 }}>
            No fields added yet. The bay will be created empty — add product to it anytime from here or from Bay Detail.
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {zoneRows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", background: "#0e1420", border: "1px solid #232d40", borderRadius: 8, padding: 10 }}>
              <Field label="Field name"><input value={r.name} onChange={(e) => updateZoneRow(i, { name: e.target.value })} style={{ ...inputStyle, width: 140 }} /></Field>
              <Field label="Variety">
                <select value={r.variety} onChange={(e) => updateZoneRow(i, { variety: e.target.value })} style={{ ...inputStyle, width: 130 }}>
                  {varieties.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
              <Field label="Customer">
                <select value={r.customer} onChange={(e) => updateZoneRow(i, { customer: e.target.value })} style={{ ...inputStyle, width: 130 }}>
                  {customerOptions(customers, r.customer).map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label={`Pipe from (of ${bayPipeBound ?? "?"})`}>
                <input type="number" min="1" max={bayPipeBound || undefined} value={r.pipeFrom} onChange={(e) => updateZoneRow(i, { pipeFrom: e.target.value })} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 1" />
              </Field>
              <Field label="to">
                <input type="number" min="1" max={bayPipeBound || undefined} value={r.pipeTo} onChange={(e) => updateZoneRow(i, { pipeTo: e.target.value })} style={{ ...inputStyle, width: 90 }} placeholder="e.g. 15" />
              </Field>
              <Field label="Cwt/pipe at 18' (optional)"><input type="number" value={r.cwtPerPipe} onChange={(e) => updateZoneRow(i, { cwtPerPipe: e.target.value })} style={{ ...inputStyle, width: 130 }} placeholder="e.g. 3200" /></Field>
              <Button variant="ghost" onClick={() => removeZoneRow(i)} style={{ marginBottom: 10 }}>Remove</Button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={addZoneRow}><Plus size={14} /> Add field</Button>
        </div>
        {bayPipeCount !== "" && zoneRowPipeSum > Number(bayPipeCount) && (
          <div style={{ fontSize: 12, color: "#e0a63e", marginTop: 8 }}>
            Fields above add up to {zoneRowPipeSum} pipe, more than the {bayPipeCount} total entered for this bay — just a heads up, it'll still save.
          </div>
        )}
        {bayError && <div style={{ fontSize: 12, color: "#e08787", margin: "10px 0" }}>{bayError}</div>}
        {readOnly && <div style={{ fontSize: 12, color: "#f2c14e", margin: "10px 0" }}>Switch to the current season to add a bay.</div>}
        <div style={{ marginTop: 10 }}>
          <Button onClick={submitBay} disabled={readOnly}><Plus size={14} /> Create bay</Button>
        </div>
      </div>
      {/* existing structure — click into any field to edit it */}
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 700, color: "#eef1f6" }}>Current sites</div>
          {!readOnly && filledBayCount > 0 && (
            <Button variant="ghost" style={{ borderColor: "#4a2b2b", color: "#e08787" }} onClick={() => setShowEmptyAll(true)}>
              Empty all bays
            </Button>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "#6f7890", marginBottom: 10 }}>Click any name or value below to rename or correct it — changes save when you click away.</div>
        {showEmptyAll && (
          <div style={{ background: "#1c1414", border: "1px solid #4a2b2b", borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, color: "#f0d3d3", marginBottom: 8 }}>
              Empty all {filledBayCount} filled bay{filledBayCount !== 1 ? "s" : ""} across every site? This clears every
              current field/product assignment back to zero — bays, buildings, and locations stay put, and archived
              seasons aren't touched. You'll need to add product back to each bay afterward.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={() => setShowEmptyAll(false)}>Cancel</Button>
              <Button
                style={{ background: "#c65b5b", color: "#1a1408" }}
                onClick={() => { onEmptyAllBays(); setShowEmptyAll(false); }}
              >
                Yes, empty all bays
              </Button>
            </div>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {locations.map((loc) => {
            const buildingsHere = buildings.filter((b) => b.locationId === loc.id);
            const bayCountHere = bays.filter((bay) => buildingsHere.some((b) => b.id === bay.buildingId)).length;
            return (
            <div key={loc.id} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <MapPin size={13} color="#f2c14e" />
                <EditableInline value={loc.name} disabled={readOnly} onSave={(v) => onUpdateLocation(loc.id, { name: v })} width={180} />
                <EditableInline value={loc.address} disabled={readOnly} onSave={(v) => onUpdateLocation(loc.id, { address: v })} width={220} placeholder="address" />
                <EditableInline value={loc.lat} type="number" disabled={readOnly} onSave={(v) => onUpdateLocation(loc.id, { lat: v })} width={90} placeholder="lat" />
                <EditableInline value={loc.lng} type="number" disabled={readOnly} onSave={(v) => onUpdateLocation(loc.id, { lng: v })} width={90} placeholder="lng" />
                <DeleteButton
                  disabled={readOnly}
                  title="Delete location"
                  onConfirm={() => onDeleteLocation(loc.id)}
                  confirmMessage={`Delete "${loc.name}"? This also deletes its ${buildingsHere.length} building${buildingsHere.length !== 1 ? "s" : ""} and ${bayCountHere} bay${bayCountHere !== 1 ? "s" : ""}, along with everything logged in them. This can't be undone.`}
                />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                {buildingsHere.map((b) => {
                  const baysHere = bays.filter((bay) => bay.buildingId === b.id);
                  return (
                  <div key={b.id} style={{ paddingLeft: 16, borderLeft: "2px solid #232d40" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Building2 size={12} color="#8790a3" />
                      <EditableInline value={b.name} disabled={readOnly} onSave={(v) => onUpdateBuilding(b.id, { name: v })} width={220} />
                      <span style={{ fontSize: 11, color: "#6f7890" }}>approx. cwt/pipe (at 18')</span>
                      <EditableInline value={b.cwtPerPipe ?? ""} type="number" disabled={readOnly} onSave={(v) => onUpdateBuilding(b.id, { cwtPerPipe: v })} width={90} placeholder="—" />
                      <span style={{ fontSize: 11, color: "#6f7890" }}>default pile height</span>
                      <select value={b.pileHeight || 18} disabled={readOnly} onChange={(e) => onUpdateBuilding(b.id, { pileHeight: Number(e.target.value) })}
                        style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 12 }}>
                        {PILE_HEIGHT_OPTIONS.map((h) => <option key={h} value={h}>{h}'</option>)}
                      </select>
                      <DeleteButton
                        disabled={readOnly}
                        title="Delete building"
                        onConfirm={() => onDeleteBuilding(b.id)}
                        confirmMessage={`Delete "${b.name}"? This also deletes its ${baysHere.length} bay${baysHere.length !== 1 ? "s" : ""}, along with everything logged in them. This can't be undone.`}
                      />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                      {sortByNatural(baysHere, (bay) => bay.name).map((bay) => (
                        <BayRow key={bay.id} bay={bay} readOnly={readOnly} varieties={varieties} customers={customers}
                          onUpdateBayMeta={onUpdateBayMeta} onUpdateZoneMeta={onUpdateZoneMeta} onAddZoneToBay={onAddZoneToBay}
                          onEmptyBay={onEmptyBay} onDeleteBay={onDeleteBay} onDeleteZone={onDeleteZone} />
                      ))}
                      {baysHere.length === 0 && (
                        <div style={{ paddingLeft: 16, fontSize: 12, color: "#5b6478" }}>No bays yet.</div>
                      )}
                    </div>
                  </div>
                  );
                })}
                {buildingsHere.length === 0 && (
                  <div style={{ paddingLeft: 16, fontSize: 12.5, color: "#5b6478" }}>No buildings yet.</div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
// A bay in the Manage Sites structure tree. A bay can exist with zero fields
// — "No product assigned yet" — and product gets attached to it here (or
// from Bay Detail) whenever it's actually ready to be filled.
function BayRow({ bay, readOnly, varieties, customers, onUpdateBayMeta, onUpdateZoneMeta, onAddZoneToBay, onEmptyBay, onDeleteBay, onDeleteZone }) {
  const [adding, setAdding] = useState(false);
  return (
    <div style={{ paddingLeft: 16, borderLeft: "2px solid #1a2130" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Package size={12} color="#8790a3" />
        <EditableInline value={bay.name} disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { name: v })} width={140} />
        <span style={{ fontSize: 11, color: "#6f7890" }}>filled</span>
        <EditableInline value={bay.fillDate} type="date" disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { fillDate: v })} width={140} />
        <span style={{ fontSize: 11, color: "#6f7890" }}>total pipe</span>
        <EditableInline value={bay.pipeCount ?? ""} type="number" disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { pipeCount: v })} width={70} placeholder="—" />
        <span style={{ fontSize: 11, color: "#6f7890" }}>cwt/pipe at 18' (bay default)</span>
        <EditableInline value={bay.cwtPerPipe ?? ""} type="number" disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { cwtPerPipe: v })} width={90} placeholder="—" />
        <span style={{ fontSize: 11, color: "#6f7890" }}>pile height</span>
        <select value={bay.pileHeight || 18} disabled={readOnly} onChange={(e) => onUpdateBayMeta(bay.id, { pileHeight: Number(e.target.value) })}
          style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 12 }}>
          {PILE_HEIGHT_OPTIONS.map((h) => <option key={h} value={h}>{h}'</option>)}
        </select>
        {(bay.pileHeight || 18) === 9 && bay.cwtPerPipe > 0 && (
          <span style={{ fontSize: 11, color: "#e0a63e" }}>≈ {fmt(bay.cwtPerPipe * 0.5)} cwt/pipe effective</span>
        )}
        <span style={{ fontSize: 11, color: "#6f7890" }}>Agri-Stor bin</span>
        <EditableInline value={bay.agristorBinName ?? ""} disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { agristorBinName: v || null })} width={140} placeholder="not linked" />
        {!readOnly && bay.zones.length > 0 && (
          <button
            onClick={() => {
              if (window.confirm(`Empty "${bay.name}"? This removes all ${bay.zones.length} field${bay.zones.length !== 1 ? "s" : ""} currently assigned.`)) {
                onEmptyBay(bay.id);
              }
            }}
            style={{ border: "1px solid #4a2b2b", background: "transparent", color: "#e08787", borderRadius: 6, padding: "3px 9px", fontSize: 11, cursor: "pointer" }}
          >
            Empty bay
          </button>
        )}
        <DeleteButton
          disabled={readOnly}
          title="Delete bay"
          onConfirm={() => onDeleteBay(bay.id)}
          confirmMessage={`Delete "${bay.name}"? This removes the bay entirely${bay.zones.length ? `, including its ${bay.zones.length} field${bay.zones.length !== 1 ? "s" : ""}` : ""} and everything logged in it. This can't be undone.`}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        {bay.zones.map((z) => (
          <div key={z.id} style={{ paddingLeft: 20, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
            <ColorDot color={getVarietyColor(z.variety)} size={7} /><ColorDot color={getCustomerColor(z.customer)} size={7} />
            <EditableInline value={z.name} disabled={readOnly} onSave={(v) => onUpdateZoneMeta(bay.id, z.id, { name: v })} width={130} />
            <span style={{ color: "#6f7890" }}>
              pipe {formatPipeRanges(z.pipeRanges)} ({zonePipeCount(z)})
            </span>
            <select value={z.variety} disabled={readOnly} onChange={(e) => onUpdateZoneMeta(bay.id, z.id, { variety: e.target.value })}
              style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 12 }}>
              {varietyOptions(varieties, z.variety).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select value={z.customer} disabled={readOnly} onChange={(e) => onUpdateZoneMeta(bay.id, z.id, { customer: e.target.value })}
              style={{ ...inputStyle, width: "auto", padding: "3px 6px", fontSize: 12 }}>
              {customerOptions(customers, z.customer).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <DeleteButton
              disabled={readOnly}
              size={11}
              title="Delete field"
              onConfirm={() => onDeleteZone(bay.id, z.id)}
              confirmMessage={`Delete field "${z.name}"? This removes it from the bay along with everything logged for it. This can't be undone.`}
            />
          </div>
        ))}
        {bay.zones.length === 0 && (
          <div style={{ paddingLeft: 20, fontSize: 12, color: "#5b6478" }}>No product assigned yet.</div>
        )}
      </div>
      {!readOnly && (
        adding ? (
          <div style={{ marginLeft: 20, marginTop: 8 }}>
            <AddZoneForm
              bay={bay} varieties={varieties} customers={customers}
              nextName={`Field ${bay.zones.length + 1}`}
              onAdd={(z) => { onAddZoneToBay(bay.id, z); setAdding(false); }}
            />
            <Button variant="ghost" onClick={() => setAdding(false)} style={{ marginTop: 6 }}>Cancel</Button>
          </div>
        ) : (
          <div style={{ marginLeft: 20, marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setAdding(true)}><Plus size={13} /> Add product to this bay</Button>
          </div>
        )
      )}
    </div>
  );
}
/* ---------------------------------------------------------------
   Summary tab — pivot by variety / customer / location / bay
----------------------------------------------------------------*/
function resetBaysForNewSeason(bays, varieties) {
  return bays.map((b) => ({
    ...b,
    fillDate: "",
    zones: b.zones.map((z) => ({ ...z, variety: varieties[0] || z.variety, customer: "Unassigned" })),
  }));
}
function sortBaysByBuilding(bays, buildings) {
  const order = new Map(buildings.map((b, i) => [b.id, i]));
  return [...bays].sort((a, b) => (order.get(a.buildingId) ?? 999) - (order.get(b.buildingId) ?? 999));
}
function buildLedger(bays, statsById, buildingsById, locationsById) {
  const rows = [];
  bays.forEach((bay) => {
    const bs = statsById[bay.id];
    if (!bs) return;
    const building = buildingsById[bay.buildingId];
    const locationName = (building && locationsById[building.locationId]?.name) || "Unknown";
    let zonesCapacitySum = 0;
    bay.zones.forEach((zone) => {
      const zs = bs.zoneStats[zone.id];
      const base = { location: locationName, bay: bay.name, field: zone.name, variety: zone.variety };
      zonesCapacitySum += zs.capacityCwt;
      rows.push({ ...base, customer: zone.customer, metric: "In Storage", cwt: zs.currentCwt });
      rows.push({ ...base, customer: zone.customer, metric: "Capacity", cwt: zs.capacityCwt });
      rows.push({ ...base, customer: zone.customer, metric: "Shrink", cwt: zs.shrinkCwt });
      (zs.runs || []).forEach((r) => {
        rows.push({ ...base, customer: r.dest, metric: "Shipped", cwt: Number(r.cwt || 0) });
      });
    });
    // A bay's declared capacity (pipe count × cwt/pipe) can be bigger than
    // what's actually assigned to a field yet — a brand-new bay with no
    // product, or a field that doesn't cover every pipe. Count that leftover
    // as capacity too, just not attributed to any variety/customer, so
    // "Total capacity" reflects what you told the bay it can hold even
    // before there's product logged against it.
    const unassigned = Math.max(0, (bs.capacityCwt || 0) - zonesCapacitySum);
    if (unassigned > 0) {
      rows.push({
        location: locationName, bay: bay.name, field: "(unassigned pipe)", variety: "Unassigned", customer: "Unassigned",
        metric: "Capacity", cwt: unassigned,
      });
    }
  });
  return rows;
}
const DIM_OPTIONS = [
  { key: "variety", label: "Variety" },
  { key: "customer", label: "Customer" },
  { key: "location", label: "Location" },
  { key: "bay", label: "Bay" },
];
function SummaryTab({ bays, statsById, buildingsById, locationsById }) {
  const [dims, setDims] = useState(["variety"]);
  const ledger = useMemo(() => buildLedger(bays, statsById, buildingsById, locationsById), [bays, statsById, buildingsById, locationsById]);
  const toggleDim = (key) => setDims((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));
  const grouped = useMemo(() => {
    const map = new Map();
    ledger.forEach((row) => {
      const keyParts = dims.length ? dims.map((d) => row[d]) : ["All"];
      const key = keyParts.join(" · ");
      if (!map.has(key)) map.set(key, { key, labelParts: keyParts, capacity: 0, inStorage: 0, shipped: 0, shrink: 0 });
      const g = map.get(key);
      if (row.metric === "Capacity") g.capacity += row.cwt;
      if (row.metric === "In Storage") g.inStorage += row.cwt;
      if (row.metric === "Shipped") g.shipped += row.cwt;
      if (row.metric === "Shrink") g.shrink += row.cwt;
    });
    return Array.from(map.values()).sort((a, b) => b.capacity - a.capacity);
  }, [ledger, dims]);
  const totals = grouped.reduce((acc, g) => ({
    capacity: acc.capacity + g.capacity, inStorage: acc.inStorage + g.inStorage,
    shipped: acc.shipped + g.shipped, shrink: acc.shrink + g.shrink,
  }), { capacity: 0, inStorage: 0, shipped: 0, shrink: 0 });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 8, letterSpacing: 0.3 }}>GROUP BY (toggle any combination)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {DIM_OPTIONS.map((d) => (
            <button key={d.key} onClick={() => toggleDim(d.key)} style={{
              border: `1px solid ${dims.includes(d.key) ? "#e0a63e" : "#232d40"}`,
              background: dims.includes(d.key) ? "rgba(224,166,62,0.14)" : "transparent",
              color: dims.includes(d.key) ? "#f2c14e" : "#8790a3",
              borderRadius: 20, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600,
            }}>{d.label}</button>
          ))}
        </div>
      </div>
      <Legend bays={bays} />
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <StatBlock label="Total capacity" value={`${fmt(totals.capacity)} cwt`} />
        <StatBlock label="In storage" value={`${fmt(totals.inStorage)} cwt`} accent="#f2c14e" />
        <StatBlock label="Shipped" value={`${fmt(totals.shipped)} cwt`} />
        <StatBlock label="Shrink" value={`${fmt(totals.shrink)} cwt`} sub={totals.capacity ? `${((totals.shrink / totals.capacity) * 100).toFixed(2)}% of capacity` : ""} accent="#e08787" />
      </div>
      <div style={{ overflowX: "auto", border: "1px solid #232d40", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#141b28", textAlign: "left" }}>
              <th style={thStyle}>{dims.length ? dims.map((d) => DIM_OPTIONS.find((o) => o.key === d).label).join(" / ") : "Group"}</th>
              <th style={thStyle}>Capacity (cwt)</th>
              <th style={thStyle}>In Storage (cwt)</th>
              <th style={thStyle}>Fill %</th>
              <th style={thStyle}>Shipped (cwt)</th>
              <th style={thStyle}>Shrink (cwt)</th>
              <th style={thStyle}>Shrink %</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((g) => (
              <tr key={g.key} style={{ borderTop: "1px solid #232d40" }}>
                <td style={tdStyle}>
                  <b style={{ color: "#eef1f6", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {dims.length ? g.labelParts.map((part, i) => (
                      <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        {dims[i] === "variety" && <ColorDot color={getVarietyColor(part)} />}
                        {dims[i] === "customer" && <ColorDot color={getCustomerColor(part)} />}
                        {part}
                      </span>
                    )) : g.key}
                  </b>
                </td>
                <td style={tdStyle}>{fmt(g.capacity)}</td>
                <td style={{ ...tdStyle, color: "#f2c14e" }}>{fmt(g.inStorage)}</td>
                <td style={tdStyle}>{g.capacity ? Math.round((g.inStorage / g.capacity) * 100) : 0}%</td>
                <td style={tdStyle}>{fmt(g.shipped)}</td>
                <td style={{ ...tdStyle, color: g.shrink / (g.capacity || 1) > 0.08 ? "#e08787" : "#8fd19e" }}>{fmt(g.shrink)}</td>
                <td style={tdStyle}>{g.capacity ? ((g.shrink / g.capacity) * 100).toFixed(2) : "0.00"}%</td>
              </tr>
            ))}
            {grouped.length === 0 && (
              <tr><td colSpan={7} style={{ ...tdStyle, color: "#5b6478" }}>No data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const thStyle = { padding: "9px 12px", fontSize: 11, color: "#8790a3", letterSpacing: 0.3, fontWeight: 600 };
const tdStyle = { padding: "9px 12px", color: "#c7cede" };
/* ---------------------------------------------------------------
   Overview cards (yard tab footer)
----------------------------------------------------------------*/
function OverviewCards({ bays, statsById, onSelect }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
      {bays.map((b) => {
        const s = statsById[b.id] || {};
        return (
          <div key={b.id} onClick={() => onSelect(b.id)} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14, cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 700, color: "#eef1f6", fontSize: 14 }}>{b.name}</div>
              <ChevronRight size={15} color="#5b6478" />
            </div>
            <div style={{ fontSize: 11.5, color: "#8790a3", marginBottom: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {b.zones.map((z) => (
                <span key={z.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <ColorDot color={getVarietyColor(z.variety)} size={7} /><ColorDot color={getCustomerColor(z.customer)} size={7} /> {z.variety}
                </span>
              ))}
            </div>
            <div style={{ height: 8, background: "#0e1420", borderRadius: 4, overflow: "hidden", display: "flex" }}>
              {b.zones.map((z) => {
                const zs = (s.zoneStats || {})[z.id];
                const pct = s.capacityCwt ? ((zs?.currentCwt || 0) / s.capacityCwt) * 100 : 0;
                return (
                  <div key={z.id} style={{
                    width: `${pct}%`, height: "100%", background: getVarietyColor(z.variety),
                    borderBottom: `2px solid ${getCustomerColor(z.customer)}`, boxSizing: "border-box",
                  }} />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }}>
              <span style={{ color: "#c7cede" }}>{fmt(s.currentCwt)} cwt</span>
              <span style={{ color: "#8790a3" }}>{Math.round((s.fillPct || 0) * 100)}% full</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
/* =================================================================
   App
==================================================================*/
export default function PotatoStorage() {
  const [locations, setLocations] = useState(DEFAULT_LOCATIONS);
  const [buildings, setBuildings] = useState(DEFAULT_BUILDINGS);
  const [bays, setBays] = useState(DEFAULT_BAYS);
  const [dataById, setDataById] = useState({});
  const [inspections, setInspections] = useState([]);
  const [customers, setCustomers] = useState(DEFAULT_CUSTOMERS);
  const [varieties, setVarieties] = useState(DEFAULT_VARIETIES);
  const [products, setProducts] = useState(DEFAULT_PRODUCTS);
  const [applicators, setApplicators] = useState(DEFAULT_APPLICATORS);
  const [seasons, setSeasons] = useState(DEFAULT_SEASONS);
  const [selectedSeasonId, setSelectedSeasonId] = useState(DEFAULT_SEASONS[0].id);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("yard");
  const [selectedLocationId, setSelectedLocationId] = useState(DEFAULT_LOCATIONS[0].id);
  const [selectedId, setSelectedId] = useState(DEFAULT_BAYS[0].id);
  const [showNewSeason, setShowNewSeason] = useState(false);
  useEffect(() => {
    (async () => {
      const locs0 = await loadJSON(LOCATIONS_KEY, null);
      const locList = locs0 && Array.isArray(locs0) && locs0.length ? locs0 : DEFAULT_LOCATIONS;
      if (!locs0) await saveJSON(LOCATIONS_KEY, DEFAULT_LOCATIONS);
      setLocations(locList);
      const blds0 = await loadJSON(BUILDINGS_KEY, null);
      const bldList = blds0 && Array.isArray(blds0) && blds0.length ? blds0 : DEFAULT_BUILDINGS;
      if (!blds0) await saveJSON(BUILDINGS_KEY, DEFAULT_BUILDINGS);
      setBuildings(bldList);
      const cfg = await loadJSON(CONFIG_KEY, null);
      const bayList = cfg && Array.isArray(cfg) && cfg.length ? cfg : DEFAULT_BAYS;
      if (!cfg) await saveJSON(CONFIG_KEY, DEFAULT_BAYS);
      setBays(bayList);
      const dataEntries = {};
      for (const b of bayList) {
        dataEntries[b.id] = await loadJSON(bayDataKey(b.id), emptyBayData(b));
      }
      setDataById(dataEntries);
      const insp = await loadJSON(INSPECTIONS_KEY, []);
      setInspections(insp);
      const custs = await loadJSON(CUSTOMERS_KEY, null);
      const custList = custs && Array.isArray(custs) && custs.length ? custs : DEFAULT_CUSTOMERS;
      if (!custs) await saveJSON(CUSTOMERS_KEY, DEFAULT_CUSTOMERS);
      setCustomers(custList);
      const varList0 = await loadJSON(VARIETIES_KEY, null);
      const varList = varList0 && Array.isArray(varList0) && varList0.length ? varList0 : DEFAULT_VARIETIES;
      if (!varList0) await saveJSON(VARIETIES_KEY, DEFAULT_VARIETIES);
      setVarieties(varList);
      const prods0 = await loadJSON(PRODUCTS_KEY, null);
      const prodList = prods0 && Array.isArray(prods0) && prods0.length ? prods0 : DEFAULT_PRODUCTS;
      if (!prods0) await saveJSON(PRODUCTS_KEY, DEFAULT_PRODUCTS);
      setProducts(prodList);
      const apps0 = await loadJSON(APPLICATORS_KEY, null);
      const appList = apps0 && Array.isArray(apps0) ? apps0 : DEFAULT_APPLICATORS;
      if (!apps0) await saveJSON(APPLICATORS_KEY, DEFAULT_APPLICATORS);
      setApplicators(appList);
      const seasons0 = await loadJSON(SEASONS_KEY, null);
      const seasonList = seasons0 && Array.isArray(seasons0) && seasons0.length ? seasons0 : DEFAULT_SEASONS;
      if (!seasons0) await saveJSON(SEASONS_KEY, DEFAULT_SEASONS);
      setSeasons(seasonList);
      const active = seasonList.find((s) => s.snapshot === null) || seasonList[seasonList.length - 1];
      setSelectedSeasonId(active.id);
      setLoaded(true);
    })();
  }, []);
  const activeSeason = useMemo(() => seasons.find((s) => s.snapshot === null) || seasons[seasons.length - 1], [seasons]);
  const isReadOnly = activeSeason ? selectedSeasonId !== activeSeason.id : false;
  const selectedSeason = seasons.find((s) => s.id === selectedSeasonId) || activeSeason;
  const displayBays = isReadOnly && selectedSeason?.snapshot ? selectedSeason.snapshot.bays : bays;
  const displayDataById = isReadOnly && selectedSeason?.snapshot ? selectedSeason.snapshot.dataById : dataById;
  const displayInspections = isReadOnly && selectedSeason?.snapshot ? selectedSeason.snapshot.inspections : inspections;
  const statsById = useMemo(() => {
    const out = {};
    displayBays.forEach((b) => { out[b.id] = computeBayStats(b, displayDataById[b.id] || emptyBayData(b)); });
    return out;
  }, [displayBays, displayDataById]);
  const buildingsById = useMemo(() => Object.fromEntries(buildings.map((b) => [b.id, b])), [buildings]);
  const locationsById = useMemo(() => Object.fromEntries(locations.map((l) => [l.id, l])), [locations]);
  // Default display order everywhere: alphabetical (numeric-aware). Bays stay
  // grouped by building — sorting bay names first, then grouping by building
  // in alphabetical building order, keeps each building's bays contiguous
  // (the yard view's spacing logic depends on that) while still landing in
  // alpha order both between and within buildings.
  const sortedLocations = useMemo(() => sortByNatural(locations, (l) => l.name), [locations]);
  const sortedBuildings = useMemo(() => sortByNatural(buildings, (b) => b.name), [buildings]);
  const sortedCustomers = useMemo(() => sortByNatural(customers), [customers]);
  const sortedVarieties = useMemo(() => sortByNatural(varieties), [varieties]);
  const sortedProducts = useMemo(() => sortByNatural(products, (p) => p.name), [products]);
  const sortedApplicators = useMemo(() => sortByNatural(applicators), [applicators]);
  const selectedLocation = locationsById[selectedLocationId] || sortedLocations[0];
  const locationBays = useMemo(() => {
    const filtered = displayBays.filter((b) => buildingsById[b.buildingId]?.locationId === selectedLocationId);
    return sortBaysByBuilding(sortByNatural(filtered, (b) => b.name), sortedBuildings);
  }, [displayBays, buildingsById, sortedBuildings, selectedLocationId]);
  useEffect(() => {
    if (!locationBays.length) return;
    if (!locationBays.find((b) => b.id === selectedId)) setSelectedId(locationBays[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId, selectedSeasonId, locationBays.map((b) => b.id).join(",")]);
  // If the currently-selected location gets deleted, fall back to whatever's
  // first in the list rather than pointing at nothing.
  useEffect(() => {
    if (sortedLocations.length && !sortedLocations.find((l) => l.id === selectedLocationId)) {
      setSelectedLocationId(sortedLocations[0].id);
    }
  }, [sortedLocations, selectedLocationId]);
  const updateZoneData = useCallback((bayId, zoneId, updater) => {
    if (isReadOnly) return;
    setDataById((prev) => {
      const bayData = prev[bayId] || {};
      const zones = bayData.zones || {};
      const zoneData = zones[zoneId] || { pipeChecks: [], cwtRuns: [] };
      const nextZoneData = updater(zoneData);
      const nextBayData = { ...bayData, zones: { ...zones, [zoneId]: nextZoneData } };
      const next = { ...prev, [bayId]: nextBayData };
      saveJSON(bayDataKey(bayId), nextBayData);
      return next;
    });
  }, [isReadOnly]);
  const onAddPipeCheck = useCallback((bayId, zoneId, entry) => {
    if (isReadOnly) return;
    const bay = bays.find((b) => b.id === bayId);
    const zone = bay?.zones.find((z) => z.id === zoneId);
    if (!bay || !zone) return;
    const bayPipeBound = bay.pipeCount || bay.zones.reduce((s, z) => s + zonePipeCount(z), 0) || null;
    const rangesOk = (entry.ranges || []).every((r) => rangeFitsBay(r, bayPipeBound));
    if (!rangesOk) return; // defensive — the Log Pipe form already validates this before calling in
    updateZoneData(bayId, zoneId, (zd) => ({ ...zd, pipeChecks: [...(zd.pipeChecks || []), entry] }));
    if (entry.type === "fill") {
      // Filling can grow a field's footprint into pipe it didn't cover
      // before — extend pipeRanges and refresh the cached pipeCount.
      setBays((prev) => {
        const next = prev.map((b) => {
          if (b.id !== bayId) return b;
          return {
            ...b,
            zones: b.zones.map((z) => {
              if (z.id !== zoneId) return z;
              const merged = new Set([...pipeRangeSet(z.pipeRanges), ...pipeRangeSet(entry.ranges)]);
              return { ...z, pipeRanges: [...(z.pipeRanges || []), ...entry.ranges], pipeCount: merged.size };
            }),
          };
        });
        saveJSON(CONFIG_KEY, next);
        return next;
      });
    }
  }, [updateZoneData, isReadOnly, bays]);
  const onAddCwtRun = useCallback((bayId, zoneId, entry) => {
    updateZoneData(bayId, zoneId, (zd) => ({ ...zd, cwtRuns: [...(zd.cwtRuns || []), entry] }));
  }, [updateZoneData]);
  const onAddTemp = useCallback((bayId, entry) => {
    if (isReadOnly) return;
    setDataById((prev) => {
      const bayData = prev[bayId] || {};
      const nextBayData = { ...bayData, tempLogs: [...(bayData.tempLogs || []), entry] };
      const next = { ...prev, [bayId]: nextBayData };
      saveJSON(bayDataKey(bayId), nextBayData);
      return next;
    });
  }, [isReadOnly]);
  // Deletes one manual temperature entry by its position in this bay's
  // tempLogs array — the array index is how TemperatureTab identifies a
  // specific row, since older entries (logged before individual delete was
  // added) don't carry their own id.
  const onDeleteTemp = useCallback((bayId, index) => {
    if (isReadOnly) return;
    setDataById((prev) => {
      const bayData = prev[bayId] || {};
      const logs = bayData.tempLogs || [];
      const nextBayData = { ...bayData, tempLogs: logs.filter((_, i) => i !== index) };
      const next = { ...prev, [bayId]: nextBayData };
      saveJSON(bayDataKey(bayId), nextBayData);
      return next;
    });
  }, [isReadOnly]);
  const onAddInspection = useCallback((entry) => {
    if (isReadOnly) return;
    setInspections((prev) => {
      const next = [...prev, entry];
      saveJSON(INSPECTIONS_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  const onAddCustomer = useCallback((name) => {
    setCustomers((prev) => {
      if (prev.some((c) => c.toLowerCase() === name.toLowerCase())) return prev;
      const next = [...prev, name];
      saveJSON(CUSTOMERS_KEY, next);
      return next;
    });
  }, []);
  const onUpdateZoneCustomer = useCallback((bayId, zoneId, customer) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId
        ? { ...b, zones: b.zones.map((z) => z.id === zoneId ? { ...z, customer } : z) }
        : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  const onAddVariety = useCallback((name) => {
    setVarieties((prev) => {
      if (prev.some((v) => v.toLowerCase() === name.toLowerCase())) return prev;
      const next = [...prev, name];
      saveJSON(VARIETIES_KEY, next);
      return next;
    });
  }, []);
  const onUpdateZoneVariety = useCallback((bayId, zoneId, variety) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId
        ? { ...b, zones: b.zones.map((z) => z.id === zoneId ? { ...z, variety } : z) }
        : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  const onAddProduct = useCallback((product) => {
    setProducts((prev) => {
      const next = [...prev, product];
      saveJSON(PRODUCTS_KEY, next);
      return next;
    });
  }, []);
  const onUpdateProductRestrictions = useCallback((productId, restrictedCustomers) => {
    setProducts((prev) => {
      const next = prev.map((p) => p.id === productId ? { ...p, restrictedCustomers } : p);
      saveJSON(PRODUCTS_KEY, next);
      return next;
    });
  }, []);
  const onAddApplicator = useCallback((name) => {
    setApplicators((prev) => {
      if (prev.some((a) => a.toLowerCase() === name.toLowerCase())) return prev;
      const next = [...prev, name];
      saveJSON(APPLICATORS_KEY, next);
      return next;
    });
  }, []);
  const onAddSproutApplication = useCallback((bayId, zoneId, entry) => {
    updateZoneData(bayId, zoneId, (zd) => ({ ...zd, sproutApplications: [...(zd.sproutApplications || []), entry] }));
  }, [updateZoneData]);
  const onAddLocation = useCallback((location) => {
    setLocations((prev) => {
      const next = [...prev, location];
      saveJSON(LOCATIONS_KEY, next);
      return next;
    });
  }, []);
  const onUpdateLocation = useCallback((locationId, patch) => {
    setLocations((prev) => {
      const next = prev.map((l) => l.id === locationId ? { ...l, ...patch } : l);
      saveJSON(LOCATIONS_KEY, next);
      return next;
    });
  }, []);
  const onAddBuilding = useCallback((building) => {
    setBuildings((prev) => {
      const next = [...prev, building];
      saveJSON(BUILDINGS_KEY, next);
      return next;
    });
  }, []);
  const onUpdateBuilding = useCallback((buildingId, patch) => {
    setBuildings((prev) => {
      const next = prev.map((b) => b.id === buildingId ? { ...b, ...patch } : b);
      saveJSON(BUILDINGS_KEY, next);
      return next;
    });
  }, []);
  const onAddBay = useCallback((bay) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = [...prev, bay];
      saveJSON(CONFIG_KEY, next);
      return next;
    });
    const initData = emptyBayData(bay);
    setDataById((prev) => ({ ...prev, [bay.id]: initData }));
    saveJSON(bayDataKey(bay.id), initData);
    setSelectedLocationId(buildingsById[bay.buildingId]?.locationId || selectedLocationId);
    setSelectedId(bay.id);
  }, [buildingsById, selectedLocationId, isReadOnly]);
  const onUpdateBayMeta = useCallback((bayId, patch) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId ? { ...b, ...patch } : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  const onUpdateZoneMeta = useCallback((bayId, zoneId, patch) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId
        ? { ...b, zones: b.zones.map((z) => z.id === zoneId ? { ...z, ...patch } : z) }
        : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  // Attaches a new field/product to a bay that already exists — this is how
  // an empty bay (created with no product yet) gets filled in later, and how
  // a bay gets a second field without having to have known about it upfront.
  const onAddZoneToBay = useCallback((bayId, zone) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId ? { ...b, zones: [...b.zones, zone] } : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  // Clears every field out of a single bay — the reverse of onAddZoneToBay.
  // Used once a bay has fully run out and is ready to sit empty until it's
  // filled again; the bay itself (and its history in past seasons) stays.
  // Only clears the STRUCTURAL assignment (which fields currently sit in
  // this bay) — it used to also blow away dataById[bayId] entirely, which
  // silently deleted every one of those fields' pipeChecks/cwtRuns/Sprout
  // Nip history (and even this bay's own tempLogs) the moment it ran. Now
  // it leaves dataById untouched: a zone's records just become orphaned
  // (unreferenced by any current field) rather than erased, so re-adding
  // "the same" field later doesn't silently resurrect old numbers, but
  // nothing is destroyed. Use onDeleteZone for an actual, permanent erase
  // of one field's records.
  const onEmptyBay = useCallback((bayId) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId ? { ...b, zones: [], fillDate: "" } : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  // Bulk version of onEmptyBay — empties every bay across every site in one
  // go (e.g. at full cleanout time). Bay/building/location structure and
  // archived seasons are untouched; only the current season's product
  // assignments are cleared.
  // Same fix as onEmptyBay above — structural-only, dataById (and every
  // field's history within it) is left alone.
  const onEmptyAllBays = useCallback(() => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => ({ ...b, zones: [], fillDate: "" }));
      saveJSON(CONFIG_KEY, next);
      return next;
    });
  }, [isReadOnly]);
  // Deletes a single field from a bay — unlike emptying a bay, this drops
  // that one field's logged history (checks/runs) for good. The confirming
  // prompt happens at the UI layer before this is called.
  const onDeleteZone = useCallback((bayId, zoneId) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.map((b) => b.id === bayId ? { ...b, zones: b.zones.filter((z) => z.id !== zoneId) } : b);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
    setDataById((prev) => {
      const bayData = prev[bayId];
      if (!bayData?.zones?.[zoneId]) return prev;
      const zones = { ...bayData.zones };
      delete zones[zoneId];
      const nextBayData = { ...bayData, zones };
      const next = { ...prev, [bayId]: nextBayData };
      saveJSON(bayDataKey(bayId), nextBayData);
      return next;
    });
  }, [isReadOnly]);
  // Deletes a bay entirely — its structure and everything logged in it.
  // The building/location it lived in is untouched.
  const onDeleteBay = useCallback((bayId) => {
    if (isReadOnly) return;
    setBays((prev) => {
      const next = prev.filter((b) => b.id !== bayId);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
    setDataById((prev) => {
      if (!prev[bayId]) return prev;
      const next = { ...prev };
      delete next[bayId];
      return next;
    });
    deleteJSON(bayDataKey(bayId));
  }, [isReadOnly]);
  // Deletes a building and cascades to every bay inside it (and each bay's
  // logged history). The UI confirms the bay count with the user first.
  const onDeleteBuilding = useCallback((buildingId) => {
    if (isReadOnly) return;
    const bayIdsHere = bays.filter((b) => b.buildingId === buildingId).map((b) => b.id);
    setBuildings((prev) => {
      const next = prev.filter((b) => b.id !== buildingId);
      saveJSON(BUILDINGS_KEY, next);
      return next;
    });
    setBays((prev) => {
      const next = prev.filter((b) => b.buildingId !== buildingId);
      saveJSON(CONFIG_KEY, next);
      return next;
    });
    setDataById((prev) => {
      const next = { ...prev };
      bayIdsHere.forEach((id) => delete next[id]);
      return next;
    });
    bayIdsHere.forEach((id) => deleteJSON(bayDataKey(id)));
  }, [isReadOnly, bays]);
  // Deletes a location and cascades to every building and bay under it. The
  // UI confirms the building/bay counts with the user first.
  const onDeleteLocation = useCallback((locationId) => {
    if (isReadOnly) return;
    const buildingIdsHere = buildings.filter((b) => b.locationId === locationId).map((b) => b.id);
    const bayIdsHere = bays.filter((b) => buildingIdsHere.includes(b.buildingId)).map((b) => b.id);
    setLocations((prev) => {
      const next = prev.filter((l) => l.id !== locationId);
      saveJSON(LOCATIONS_KEY, next);
      return next;
    });
    setBuildings((prev) => {
      const next = prev.filter((b) => b.locationId !== locationId);
      saveJSON(BUILDINGS_KEY, next);
      return next;
    });
    setBays((prev) => {
      const next = prev.filter((b) => !buildingIdsHere.includes(b.buildingId));
      saveJSON(CONFIG_KEY, next);
      return next;
    });
    setDataById((prev) => {
      const next = { ...prev };
      bayIdsHere.forEach((id) => delete next[id]);
      return next;
    });
    bayIdsHere.forEach((id) => deleteJSON(bayDataKey(id)));
  }, [isReadOnly, buildings, bays]);
  const onStartNewSeason = useCallback((label) => {
    const newSeasonId = uid("season");
    setSeasons((prev) => {
      const withArchive = prev.map((s) => s.id === activeSeason?.id
        ? { ...s, snapshot: { bays, dataById, inspections } }
        : s);
      const next = [...withArchive, { id: newSeasonId, label: label || `Season ${withArchive.length + 1}`, snapshot: null }];
      saveJSON(SEASONS_KEY, next);
      return next;
    });
    const resetBays = resetBaysForNewSeason(bays, varieties);
    setBays(resetBays);
    saveJSON(CONFIG_KEY, resetBays);
    const resetData = {};
    resetBays.forEach((b) => { resetData[b.id] = emptyBayData(b); saveJSON(bayDataKey(b.id), resetData[b.id]); });
    setDataById(resetData);
    setInspections([]);
    saveJSON(INSPECTIONS_KEY, []);
    setSelectedSeasonId(newSeasonId);
  }, [activeSeason, bays, dataById, inspections, varieties]);
  const selectedBay = displayBays.find((b) => b.id === selectedId) || locationBays[0];
  const NAV = [
    { id: "yard", label: "3D Yard", icon: Warehouse },
    { id: "map", label: "Map", icon: MapIcon },
    { id: "detail", label: "Bay Detail", icon: Package },
    { id: "summary", label: "Summary", icon: BarChart3 },
    { id: "manage", label: "Manage Sites", icon: Building2 },
    { id: "customers", label: "Customers", icon: Users },
    { id: "varieties", label: "Varieties", icon: Sprout },
    { id: "temp", label: "Temperature", icon: Thermometer },
    { id: "sproutnip", label: "Sprout Nip", icon: FlaskConical },
  ];
  if (!loaded) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0e1420", color: "#8790a3", fontFamily: "'JetBrains Mono', monospace" }}>
        loading cellar data…
      </div>
    );
  }
  return (
    <div style={{ height: "100%", minHeight: 640, display: "flex", flexDirection: "column", background: "#0e1420", fontFamily: "Inter, system-ui, sans-serif", color: "#eef1f6" }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #232d40", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.3 }}>POTATO STORAGE</div>
            <div style={{ fontSize: 12, color: "#8790a3", display: "flex", alignItems: "center", gap: 4 }}>
              <MapPin size={12} /> {selectedLocation?.address}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: "#6f7890", letterSpacing: 0.5, marginBottom: 3 }}>SITE</div>
            <select value={selectedLocationId} onChange={(e) => setSelectedLocationId(e.target.value)}
              style={{ ...inputStyle, width: "auto", fontSize: 13, fontWeight: 600, padding: "6px 10px" }}>
              {sortedLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 10.5, color: "#6f7890", letterSpacing: 0.5, marginBottom: 3 }}>SEASON</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={selectedSeasonId} onChange={(e) => setSelectedSeasonId(e.target.value)}
                style={{ ...inputStyle, width: "auto", fontSize: 13, fontWeight: 600, padding: "6px 10px" }}>
                {[...seasons].reverse().map((s) => (
                  <option key={s.id} value={s.id}>{s.label}{s.snapshot === null ? " (current)" : ""}</option>
                ))}
              </select>
              <button onClick={() => setShowNewSeason(true)} title="Archive this season and start a new one" style={{
                border: "1px solid #2b3549", background: "transparent", color: "#8790a3", borderRadius: 6,
                padding: "6px 8px", cursor: "pointer", fontSize: 12,
              }}><Plus size={13} /></button>
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, background: "#141b28", borderRadius: 8, padding: 4, border: "1px solid #232d40", flexWrap: "wrap" }}>
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button key={n.id} onClick={() => setTab(n.id)} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6, border: "none",
                cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                background: active ? "#e0a63e" : "transparent", color: active ? "#1a1408" : "#c7cede",
              }}>
                <Icon size={14} /> {n.label}
              </button>
            );
          })}
        </div>
      </div>
      {showNewSeason && (
        <NewSeasonPrompt
          activeSeasonLabel={activeSeason?.label}
          onCancel={() => setShowNewSeason(false)}
          onConfirm={(label) => { onStartNewSeason(label); setShowNewSeason(false); }}
        />
      )}
      {isReadOnly && (
        <div style={{ background: "rgba(224,166,62,0.1)", borderBottom: "1px solid #3a3320", padding: "8px 20px", fontSize: 12.5, color: "#f2c14e", display: "flex", alignItems: "center", gap: 8 }}>
          <Layers size={13} /> Viewing <b>{selectedSeason?.label}</b> — archived, read-only.
          <button onClick={() => setSelectedSeasonId(activeSeason?.id)} style={{ background: "none", border: "none", color: "#f2c14e", textDecoration: "underline", cursor: "pointer", fontSize: 12.5, padding: 0 }}>
            Return to {activeSeason?.label}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {tab === "yard" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {locationBays.length === 0 ? (
              <EmptySiteNotice onManage={() => setTab("manage")} />
            ) : (
              <>
                <div style={{ flex: 1, minHeight: 380 }}>
                  <Scene3D key={selectedLocationId} bays={locationBays} statsById={statsById} selectedId={selectedId} mode="yard" buildingsById={buildingsById}
                    onSelect={(id) => { setSelectedId(id); setTab("detail"); }} />
                </div>
                <div style={{ padding: 16, borderTop: "1px solid #232d40", display: "flex", flexDirection: "column", gap: 14 }}>
                  <Legend bays={locationBays} />
                  <OverviewCards bays={locationBays} statsById={statsById} onSelect={(id) => { setSelectedId(id); setTab("detail"); }} />
                </div>
              </>
            )}
          </div>
        )}
        {tab === "map" && (
          <div style={{ flex: 1, minHeight: 380 }}>
            <MapTab locations={sortedLocations} bays={displayBays} buildingsById={buildingsById} statsById={statsById}
              onSelectLocation={(id) => { setSelectedLocationId(id); setTab("yard"); }} />
          </div>
        )}
        {tab === "detail" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {locationBays.length === 0 ? (
              <EmptySiteNotice onManage={() => setTab("manage")} />
            ) : selectedBay && (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                  {locationBays.map((b) => (
                    <button key={b.id} onClick={() => setSelectedId(b.id)} style={{
                      border: `1px solid ${b.id === selectedId ? "#e0a63e" : "#232d40"}`,
                      background: b.id === selectedId ? "rgba(224,166,62,0.12)" : "transparent",
                      color: b.id === selectedId ? "#f2c14e" : "#8790a3",
                      borderRadius: 20, padding: "5px 12px", fontSize: 12.5, cursor: "pointer", fontWeight: 600,
                    }}>{b.name}</button>
                  ))}
                </div>
                <BayDetail bay={selectedBay} data={displayDataById[selectedBay.id] || emptyBayData(selectedBay)} stats={statsById[selectedBay.id]}
                  customers={sortedCustomers} varieties={sortedVarieties} readOnly={isReadOnly} onAddPipeCheck={onAddPipeCheck} onAddCwtRun={onAddCwtRun}
                  onUpdateZoneCustomer={onUpdateZoneCustomer} onUpdateZoneVariety={onUpdateZoneVariety} onAddZoneToBay={onAddZoneToBay}
                  onUpdateZoneMeta={onUpdateZoneMeta} onEmptyBay={onEmptyBay} onDeleteZone={onDeleteZone} />
              </>
            )}
          </div>
        )}
        {tab === "summary" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <SummaryTab bays={displayBays} statsById={statsById} buildingsById={buildingsById} locationsById={locationsById} />
          </div>
        )}
        {tab === "manage" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <ManageTab locations={sortedLocations} buildings={sortedBuildings} bays={bays} varieties={sortedVarieties} customers={sortedCustomers} readOnly={isReadOnly}
              onAddLocation={onAddLocation} onAddBuilding={onAddBuilding} onAddBay={onAddBay}
              onUpdateLocation={onUpdateLocation} onUpdateBuilding={onUpdateBuilding} onUpdateBayMeta={onUpdateBayMeta} onUpdateZoneMeta={onUpdateZoneMeta}
              onAddZoneToBay={onAddZoneToBay} onEmptyBay={onEmptyBay} onEmptyAllBays={onEmptyAllBays}
              onDeleteLocation={onDeleteLocation} onDeleteBuilding={onDeleteBuilding} onDeleteBay={onDeleteBay} onDeleteZone={onDeleteZone} />
          </div>
        )}
        {tab === "customers" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <CustomersTab customers={sortedCustomers} bays={displayBays} onAdd={onAddCustomer} />
          </div>
        )}
        {tab === "varieties" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <VarietiesTab varieties={sortedVarieties} bays={displayBays} onAdd={onAddVariety} />
          </div>
        )}
        {tab === "temp" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {locationBays.length === 0 ? <EmptySiteNotice onManage={() => setTab("manage")} /> : (
              <TemperatureTab bays={locationBays} dataById={displayDataById} onAddTemp={onAddTemp} onDeleteTemp={onDeleteTemp} readOnly={isReadOnly} />
            )}
          </div>
        )}
        {tab === "sproutnip" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {locationBays.length === 0 ? <EmptySiteNotice onManage={() => setTab("manage")} /> : (
              <SproutNipTab bays={locationBays} dataById={displayDataById} customers={sortedCustomers} products={sortedProducts} applicators={sortedApplicators}
                readOnly={isReadOnly} onAddSproutApplication={onAddSproutApplication} onAddProduct={onAddProduct}
                onUpdateProductRestrictions={onUpdateProductRestrictions} onAddApplicator={onAddApplicator} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
