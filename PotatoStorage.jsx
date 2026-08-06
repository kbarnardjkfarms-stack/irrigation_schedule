import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import {
  Warehouse, Thermometer, ClipboardCheck, Package, TrendingDown, Map as MapIcon,
  Plus, ChevronRight, MapPin, Gauge, BarChart3, AlertTriangle, Check, Layers, Users, Sprout, Building2,
} from "lucide-react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase.js"; // AIO's existing Firebase project — same login, no second sign-in

/* =================================================================
   NORLAND CELLARS — seed data (pulled from the 2025 storage workbook)
   1200 N. Meridian, Rupert, ID
   Zones = the field/lot divisions physically stored within each bay.
   Each zone owns a slice of the bay's tubes, so fill + shrink are
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
  return Array.from(set.entries());
}
function allCustomers(bays) {
  const set = new Map();
  bays.forEach((b) => b.zones.forEach((z) => set.set(z.customer, getCustomerColor(z.customer))));
  return Array.from(set.entries());
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
// total capacity figure from the workbook, not tube-level detail yet. Tube
// count of 30 is nominal — cwt/tube is derived so the capacity stays accurate
// (capacity = tubeCount * cwtPerTube) until the real tube count is entered.
function placeholderZone(id, capacity, tubes = 30) {
  return [{ id, name: "Field 1", variety: "Burbank", customer: "Unassigned", tubeCount: tubes, cwtPerTube: Math.round((capacity / tubes) * 100) / 100 }];
}

const DEFAULT_BAYS = [
  {
    id: "n8", name: "Norland #8", buildingId: "bldg-n89",
    fillDate: "2025-10-16", cwtPerTube: 3200,
    zones: [
      { id: "n8z1", name: "Field A — North End", variety: "Burbank", customer: "Unassigned", tubeCount: 19 },
      { id: "n8z2", name: "Field B — South End", variety: "Burbank", customer: "Unassigned", tubeCount: 15 },
    ],
  },
  {
    id: "n9", name: "Norland #9", buildingId: "bldg-n89",
    fillDate: "2025-09-25", cwtPerTube: 3200,
    zones: [
      { id: "n9z1", name: "Hawaii 05", variety: "Burbank", customer: "Simplot", tubeCount: 25 },
      { id: "n9z2", name: "Hawaii 3 & 7", variety: "Burbank", customer: "Unassigned", tubeCount: 6 },
    ],
  },
  {
    id: "n10", name: "Norland #10", buildingId: "bldg-n1011",
    fillDate: "2025-09-20", cwtPerTube: 2440,
    zones: [{ id: "n10z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", tubeCount: 40 }],
  },
  {
    id: "n11", name: "Norland #11", buildingId: "bldg-n1011",
    fillDate: "2025-09-17", cwtPerTube: 2440,
    zones: [{ id: "n11z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", tubeCount: 40 }],
  },
  {
    id: "n12", name: "Norland #12", buildingId: "bldg-n12",
    fillDate: "2025-09-12", cwtPerTube: 2750,
    zones: [{ id: "n12z1", name: "Field 1", variety: "Ranger", customer: "Unassigned", tubeCount: 36 }],
  },
  // Remsburg — capacities from the 2025 workbook's CAPACITY SUMMARY tab.
  { id: "rems1", name: "Remsburg #1", buildingId: "bldg-r12", fillDate: "", cwtPerTube: null, zones: placeholderZone("rems1z1", 56710) },
  { id: "rems2", name: "Remsburg #2", buildingId: "bldg-r12", fillDate: "", cwtPerTube: null, zones: placeholderZone("rems2z1", 56710) },
  { id: "rems3", name: "Remsburg #3", buildingId: "bldg-r3", fillDate: "", cwtPerTube: null, zones: placeholderZone("rems3z1", 73250) },
  // Paul — capacities from the workbook (Straight/Angle bays).
  { id: "paul1", name: "Paul #1", buildingId: "bldg-p12", fillDate: "", cwtPerTube: null, zones: placeholderZone("paul1z1", 98914) },
  { id: "paul2", name: "Paul #2", buildingId: "bldg-p12", fillDate: "", cwtPerTube: null, zones: placeholderZone("paul2z1", 98914) },
  { id: "paul3", name: "Paul #3", buildingId: "bldg-p34", fillDate: "", cwtPerTube: null, zones: placeholderZone("paul3z1", 98914) },
  { id: "paul4", name: "Paul #4", buildingId: "bldg-p34", fillDate: "", cwtPerTube: null, zones: placeholderZone("paul4z1", 98914) },
  // Watco-Dutchman — capacities from the workbook where available; #5/#6 are
  // estimated to match the rest of the complex and flagged for correction.
  { id: "watco1", name: "Watco #1", buildingId: "bldg-w12", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco1z1", 96192) },
  { id: "watco2", name: "Watco #2", buildingId: "bldg-w12", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco2z1", 96192) },
  { id: "watco3", name: "Watco #3", buildingId: "bldg-w34", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco3z1", 96192) },
  { id: "watco4", name: "Watco #4", buildingId: "bldg-w34", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco4z1", 96192) },
  { id: "watco5", name: "Watco #5", buildingId: "bldg-w56", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco5z1", 96192) },
  { id: "watco6", name: "Watco #6", buildingId: "bldg-w56", fillDate: "", cwtPerTube: null, zones: placeholderZone("watco6z1", 96192) },
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
const CONFIG_KEY = "norland-bays-config-v3";
const bayDataKey = (id) => `norland-bay-data-v2:${id}`;
const INSPECTIONS_KEY = "norland-inspections-v2";
const CUSTOMERS_KEY = "norland-customers-v2";
const DEFAULT_CUSTOMERS = ["Lamb Weston", "Simplot", "McCain", "Mart Fresh", "Mart Frozen", "Grimmway"];
const VARIETIES_KEY = "norland-varieties-v2";
const DEFAULT_VARIETIES = [
  "Burbank", "Ranger", "Dakota", "Clearwater", "Teton", "Norkotah", "Reveille",
  "G3 Burbank", "G3 Reveille", "Ciklamen", "Nordaana", "907-15", "9426", "Gala",
];

const emptyZoneData = (zoneId) => ({ tubeChecks: [], cwtRuns: SEED_RUNS[zoneId] ? [...SEED_RUNS[zoneId]] : [] });
const emptyBayData = (bay) => ({
  zones: Object.fromEntries(bay.zones.map((z) => [z.id, emptyZoneData(z.id)])),
  tempLogs: [],
});

const fmt = (n, d = 0) => (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const todayStr = () => new Date().toISOString().slice(0, 10);
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

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

/* ---------------------------------------------------------------
   Derived stats — per zone (field), then rolled up per bay
----------------------------------------------------------------*/
function computeZoneStats(bay, zone, zoneData) {
  const tc = zoneData?.tubeChecks || [];
  const latest = tc.length ? tc[tc.length - 1] : null;
  const tubesRemaining = latest ? latest.tubesRemaining : 0;
  const tubesFilled = Math.max(0, zone.tubeCount - tubesRemaining);
  const cwtPerTube = zone.cwtPerTube || bay.cwtPerTube;
  const currentCwt = tubesFilled * cwtPerTube;
  const capacityCwt = zone.tubeCount * cwtPerTube;
  const fillPct = capacityCwt > 0 ? Math.min(1, currentCwt / capacityCwt) : 0;

  const runs = zoneData?.cwtRuns || [];
  const totalRun = runs.reduce((s, r) => s + Number(r.cwt || 0), 0);
  const initialCwt = zone.initialFillCwt ?? capacityCwt;
  const shrinkCwt = initialCwt - (totalRun + currentCwt);
  const shrinkPct = initialCwt > 0 ? shrinkCwt / initialCwt : 0;

  return {
    tubesRemaining, tubesFilled, cwtPerTube, currentCwt, capacityCwt, fillPct,
    totalRun, initialCwt, shrinkCwt, shrinkPct, runs,
    lastCheckDate: latest ? latest.date : null,
  };
}

function computeBayStats(bay, bayData) {
  const zoneStats = {};
  let currentCwt = 0, capacityCwt = 0, totalRun = 0, initialCwt = 0, shrinkCwt = 0;
  bay.zones.forEach((z) => {
    const zs = computeZoneStats(bay, z, bayData?.zones?.[z.id]);
    zoneStats[z.id] = zs;
    currentCwt += zs.currentCwt; capacityCwt += zs.capacityCwt;
    totalRun += zs.totalRun; initialCwt += zs.initialCwt; shrinkCwt += zs.shrinkCwt;
  });
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
function buildPileFrustumGeometry(widthBottom, widthTop, depthBottom, depthTop) {
  const hwb = widthBottom / 2, hwt = widthTop / 2, hdb = depthBottom / 2, hdt = depthTop / 2;
  const b0 = new THREE.Vector3(-hwb, 0, -hdb), b1 = new THREE.Vector3(hwb, 0, -hdb);
  const b2 = new THREE.Vector3(hwb, 0, hdb), b3 = new THREE.Vector3(-hwb, 0, hdb);
  const t0 = new THREE.Vector3(-hwt, 1, -hdt), t1 = new THREE.Vector3(hwt, 1, -hdt);
  const t2 = new THREE.Vector3(hwt, 1, hdt), t3 = new THREE.Vector3(-hwt, 1, hdt);
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

  const totalTubes = bay.zones.reduce((s, z) => s + z.tubeCount, 0) || 1;
  const innerW = W * 0.86;
  let zCursor = -L / 2;
  const zoneMeshes = {};
  bay.zones.forEach((zone, zi) => {
    const depth = (zone.tubeCount / totalTubes) * L;
    const varietyColor = getVarietyColor(zone.variety);
    const customerColor = getCustomerColor(zone.customer);
    const pileDepth = Math.max(0.3, depth - 0.3);
    const pileTopDepth = pileDepth * TOP_RATIO;     // ends slope inward, same ratio as the walls
    const pileTopWidth = innerW * TOP_RATIO;         // sides slope inward too, matching the building taper

    const mat = new THREE.MeshStandardMaterial({ color: varietyColor, roughness: 0.95, side: THREE.DoubleSide });
    const pile = new THREE.Mesh(buildPileFrustumGeometry(innerW, pileTopWidth, pileDepth, pileTopDepth), mat);
    pile.castShadow = true;
    pile.position.set(0, 0, zCursor + depth / 2);

    // customer cap — thin colored slab that rides on the (narrower) top of the
    // pile as it fills, so variety (body) and customer (cap) both read at a glance
    const capMat = new THREE.MeshStandardMaterial({ color: customerColor, roughness: 0.6, metalness: 0.1 });
    const cap = new THREE.Mesh(new THREE.BoxGeometry(pileTopWidth * 0.94, 0.28, pileTopDepth * 0.9), capMat);
    cap.position.set(0, 0.14, zCursor + depth / 2);
    cap.castShadow = true;

    if (zi > 0) {
      const dividerMat = new THREE.MeshBasicMaterial({ color: "#f2c14e" });
      const divider = new THREE.Mesh(new THREE.BoxGeometry(innerW + 0.3, 0.06, 0.06), dividerMat);
      divider.position.set(0, 0.03, zCursor);
      g.add(divider);
    }

    const stripCount = Math.min(10, zone.tubeCount);
    const stripGroup = new THREE.Group();
    for (let t = 0; t < stripCount; t++) {
      const tubeMat = new THREE.MeshStandardMaterial({ color: "#9aa4b8", metalness: 0.6, roughness: 0.35 });
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, innerW * 0.9, 10), tubeMat);
      tube.rotation.z = Math.PI / 2;
      tube.position.set(0, 0.09, zCursor + (depth / stripCount) * (t + 0.5));
      stripGroup.add(tube);
      tube.userData = { zoneId: zone.id, tubeIndex: t };
    }
    g.add(stripGroup);

    zoneMeshes[zone.id] = { pile, cap, stripGroup, stripCount, depthStart: zCursor, depth, innerW };
    g.add(pile);
    g.add(cap);
    zCursor += depth;
  });

  return { group: g, zoneMeshes, maxH: H * 0.82 };
}

function applyZoneFill(zoneMeshes, zoneStatsById, maxH) {
  Object.entries(zoneMeshes).forEach(([zoneId, m]) => {
    const stats = zoneStatsById[zoneId];
    const fillPct = stats?.fillPct || 0;

    // The pile stays topped out near full height and instead recedes along the
    // bay's length as it's pulled out — draining from the low-Z (near) end,
    // which matches the exposed-tube end below, toward the untouched far end.
    // Both the leading (draining) edge and the far edge keep the natural
    // sloped taper, so the front is always a diagonal, not a flat cut.
    const remainingDepth = Math.max(0.35, fillPct * m.depth);
    const topWidth = m.innerW * PILE_TAPER;
    const topDepth = remainingDepth * PILE_TAPER;

    m.pile.geometry.dispose();
    m.pile.geometry = buildPileFrustumGeometry(m.innerW, topWidth, remainingDepth, topDepth);
    m.pile.scale.set(1, maxH, 1);
    const centerZ = m.depthStart + m.depth - remainingDepth / 2;
    m.pile.position.set(0, 0, centerZ);

    if (m.cap) {
      m.cap.scale.z = remainingDepth / m.depth;
      m.cap.position.set(0, maxH + 0.14, centerZ);
    }

    const remaining = stats?.tubesRemaining || 0;
    const total = stats ? stats.tubesFilled + stats.tubesRemaining : 0;
    const emptyFrac = total > 0 ? remaining / total : 0;
    const emptyCount = Math.round(emptyFrac * m.stripCount);
    m.stripGroup.children.forEach((tube, i) => {
      tube.material.color.set(i < emptyCount ? "#c7ccd4" : "#4a4238");
      tube.visible = fillPct < 0.94 || i < emptyCount;
    });
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
      const { group, zoneMeshes, maxH } = buildBayGroup(bay, DIMS);
      group.position.x = xPositions[i];
      buildingGroup.add(group);
      bayMeshes[bay.id] = { group, zoneMeshes, maxH };

      const ringMat = new THREE.MeshBasicMaterial({ color: "#f2c14e", transparent: true, opacity: 0.85 });
      const ring = new THREE.Mesh(new THREE.RingGeometry(DIMS.W * 0.7, DIMS.W * 0.78, 32), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(group.position.x, 0.02, 0);
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
        Object.entries(m.zoneMeshes).forEach(([zoneId, zm]) => {
          const worldZ = zm.depthStart + zm.depth / 2;
          const p = new THREE.Vector3(0, m.maxH + 1.6, worldZ).add(m.group.position);
          p.project(camera);
          newLabels.push({
            key: `${bay.id}:${zoneId}`, bayId: bay.id, zoneId,
            x: (p.x * 0.5 + 0.5) * mount.clientWidth,
            y: (-p.y * 0.5 + 0.5) * mount.clientHeight,
            visible: p.z < 1,
          });
        });
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
      if (bayStats) applyZoneFill(m.zoneMeshes, bayStats.zoneStats, m.maxH);
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
            <div style={{ color: "#9aa4b8" }}>{zone.variety} · {zone.customer} · {zs.tubesFilled}/{zone.tubeCount} tubes · {Math.round(zs.fillPct * 100)}%</div>
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

function MapTab({ location, bays, statsById, onSelect }) {
  const mountRef = useRef(null);
  const mapRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !mountRef.current || mapRef.current) return;
      if (mountRef.current._leaflet_id) delete mountRef.current._leaflet_id; // guard against a stray re-init on a reused container
      const map = L.map(mountRef.current, { zoomControl: true }).setView([location.lat, location.lng], 18);

      const imagery = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { attribution: "Tiles &copy; Esri", maxZoom: 20 }
      ).addTo(map);
      const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
      });
      L.control.layers({ "Satellite (Esri)": imagery, "Streets (OSM)": streets }, {}, { position: "topright" }).addTo(map);

      const cols = 3;
      bays.forEach((bay, i) => {
        const dx = (i % cols - 1) * 0.00012;
        const dz = Math.floor(i / cols) * 0.00012;
        const lat = location.lat + dz;
        const lng = location.lng + dx;
        const stats = statsById[bay.id] || {};
        const primaryZone = bay.zones[0];
        const varietyColor = getVarietyColor(primaryZone.variety);
        const customerColor = getCustomerColor(primaryZone.customer);
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:16px;height:16px;border-radius:4px;overflow:hidden;border:2px solid #0e1420;box-shadow:0 0 0 1px rgba(255,255,255,0.4)">
                   <div style="height:60%;background:${varietyColor}"></div>
                   <div style="height:40%;background:${customerColor}"></div>
                 </div>`,
          iconSize: [16, 16],
        });
        const marker = L.marker([lat, lng], { icon }).addTo(map);
        const zoneRows = bay.zones.map((z) => {
          const zs = stats.zoneStats?.[z.id];
          return `<div style="display:flex;align-items:center;gap:5px;margin-top:3px">
                    <span style="width:8px;height:8px;border-radius:50%;background:${getVarietyColor(z.variety)};display:inline-block"></span>
                    <span style="width:8px;height:8px;border-radius:50%;background:${getCustomerColor(z.customer)};display:inline-block"></span>
                    ${z.name} — ${z.variety}, ${z.customer} (${zs ? Math.round(zs.fillPct * 100) : 0}%)
                  </div>`;
        }).join("");
        marker.bindPopup(
          `<div style="font-family:sans-serif;font-size:13px;min-width:190px">
             <b>${bay.name}</b><br/>
             ${zoneRows}
             <div style="margin-top:6px">${fmt(stats.currentCwt)} / ${fmt(stats.capacityCwt)} cwt (${Math.round((stats.fillPct || 0) * 100)}%)</div>
             <a href="#" data-bay="${bay.id}" style="color:#c17a3b">View bay →</a>
           </div>`
        );
        marker.on("popupopen", () => {
          const link = document.querySelector(`a[data-bay="${bay.id}"]`);
          if (link) link.onclick = (e) => { e.preventDefault(); onSelect(bay.id); };
        });
      });

      const marker0 = L.marker([location.lat, location.lng]).addTo(map);
      marker0.bindPopup(`<b>${location.name}</b><br/>${location.address}`);

      mapRef.current = map;
      setReady(true);
    });
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.id]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%", background: "#141b28" }} />
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#8790a3", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
          loading map…
        </div>
      )}
      <div style={{ position: "absolute", bottom: 10, left: 10, background: "rgba(14,20,32,0.82)", border: "1px solid #2b3549", borderRadius: 6, padding: "6px 10px", fontSize: 11, color: "#8790a3", maxWidth: 280 }}>
        Basemap: Esri World Imagery (satellite, no key required). Pin location is approximate — nudge it once you confirm the exact parcel.
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
function customerOptions(customers, currentValue) {
  const opts = ["Unassigned", ...customers];
  if (currentValue && !opts.includes(currentValue)) opts.push(currentValue); // keep legacy values visible
  return opts;
}

function varietyOptions(varieties, currentValue) {
  const opts = [...varieties];
  if (currentValue && !opts.includes(currentValue)) opts.push(currentValue); // keep legacy values visible
  return opts;
}

function NewSeasonPrompt({ activeSeasonLabel, onCancel, onConfirm }) {
  const [label, setLabel] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: "#141b28", border: "1px solid #2b3549", borderRadius: 12, padding: 22, width: 420, maxWidth: "90vw" }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#eef1f6", marginBottom: 8 }}>Start a new season</div>
        <div style={{ fontSize: 12.5, color: "#8790a3", marginBottom: 14, lineHeight: 1.5 }}>
          This archives <b>{activeSeasonLabel}</b> as a read-only historical record and resets every bay's fields —
          variety, customer, fill date, tube checks, cwt runs, and inspections — for a fresh season. Bays, buildings,
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
   Bay detail panel (per-zone tube checks + cwt runs) + interior 3D
----------------------------------------------------------------*/
function BayDetail({ bay, data, stats, customers, varieties, readOnly, onAddTubeCheck, onAddCwtRun, onUpdateZoneCustomer, onUpdateZoneVariety }) {
  const [zoneId, setZoneId] = useState(bay.zones[0].id);
  useEffect(() => { setZoneId(bay.zones[0].id); }, [bay.id]);
  const zone = bay.zones.find((z) => z.id === zoneId);
  const zoneData = data.zones[zoneId] || { tubeChecks: [], cwtRuns: [] };
  const zs = stats.zoneStats[zoneId];

  const [tubesRemaining, setTubesRemaining] = useState("");
  const [checkDate, setCheckDate] = useState(todayStr());
  const [checkNote, setCheckNote] = useState("");
  const [runDate, setRunDate] = useState(todayStr());
  const [runDest, setRunDest] = useState(zone?.customer || "Unassigned");
  const [runCwt, setRunCwt] = useState("");
  useEffect(() => { setRunDest(zone?.customer || "Unassigned"); }, [zoneId]);

  const submitCheck = () => {
    if (tubesRemaining === "" || isNaN(Number(tubesRemaining))) return;
    onAddTubeCheck(bay.id, zoneId, { date: checkDate, tubesRemaining: Number(tubesRemaining), note: checkNote });
    setTubesRemaining(""); setCheckNote("");
  };
  const submitRun = () => {
    if (!runCwt || isNaN(Number(runCwt))) return;
    onAddCwtRun(bay.id, zoneId, { date: runDate, dest: runDest, cwt: Number(runCwt) });
    setRunCwt(""); setRunDest("");
  };

  const tubeChecks = [...(zoneData.tubeChecks || [])].reverse();
  const cwtRuns = [...(zoneData.cwtRuns || [])].reverse();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, color: "#eef1f6" }}>{bay.name}</h2>
        <div style={{ color: "#8790a3", fontSize: 12.5, marginTop: 3 }}>
          Filled {bay.fillDate} · {bay.zones.length} field{bay.zones.length > 1 ? "s" : ""} · {bay.zones.reduce((s, z) => s + z.tubeCount, 0)} tubes total
        </div>
      </div>

      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
        <StatBlock label="Bay inventory" value={`${fmt(stats.currentCwt)} cwt`} sub={`${Math.round(stats.fillPct * 100)}% of ${fmt(stats.capacityCwt)} cwt`} accent="#f2c14e" />
        <StatBlock label="Total run out" value={`${fmt(stats.totalRun)} cwt`} />
        <StatBlock label="Bay shrink" value={`${fmt(stats.shrinkCwt)} cwt`} sub={`${(stats.shrinkPct * 100).toFixed(2)}%`} accent={stats.shrinkPct > 0.08 ? "#e08787" : "#8fd19e"} />
      </div>

      <div>
        <div style={{ fontSize: 11, color: "#8790a3", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
          <Layers size={13} /> INTERIOR VIEW — FIELD DIVISION
        </div>
        <div style={{ height: 300, background: "#0e1420", border: "1px solid #232d40", borderRadius: 10, overflow: "hidden" }}>
          <Scene3D bays={[bay]} statsById={{ [bay.id]: stats }} mode="interior" onSelect={() => {}} />
        </div>
        <div style={{ marginTop: 8 }}><Legend bays={[bay]} /></div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {bay.zones.map((z) => (
          <button key={z.id} onClick={() => setZoneId(z.id)} style={{
            border: `1px solid ${z.id === zoneId ? "#e0a63e" : "#232d40"}`,
            background: z.id === zoneId ? "rgba(224,166,62,0.12)" : "transparent",
            color: z.id === zoneId ? "#f2c14e" : "#8790a3",
            borderRadius: 20, padding: "6px 14px", fontSize: 12.5, cursor: "pointer", fontWeight: 600,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}>
            <ColorDot color={getVarietyColor(z.variety)} /><ColorDot color={getCustomerColor(z.customer)} />
            {z.name} <span style={{ opacity: 0.7 }}>· {z.variety} · {z.customer}</span>
          </button>
        ))}
      </div>

      {zone && zs && (
        <>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16 }}>
            <StatBlock label={`${zone.name} inventory`} value={`${fmt(zs.currentCwt)} cwt`} sub={`${Math.round(zs.fillPct * 100)}% of ${fmt(zs.capacityCwt)} cwt · ${zs.tubesFilled}/${zone.tubeCount} tubes`} accent="#f2c14e" />
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
                <Gauge size={16} color="#f2c14e" /> Log tube check — {zone.name}
              </div>
              <div style={{ fontSize: 12, color: "#8790a3", marginBottom: 10 }}>
                Enter how many of this field's tubes are still empty (uncovered) — cwt is calculated automatically.
              </div>
              <Field label="Date"><input type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} style={inputStyle} /></Field>
              <Field label={`Tubes remaining (empty), out of ${zone.tubeCount}`}>
                <input type="number" min="0" max={zone.tubeCount} value={tubesRemaining} onChange={(e) => setTubesRemaining(e.target.value)} style={inputStyle} placeholder="e.g. 4" />
              </Field>
              <Field label="Note (optional)"><input value={checkNote} onChange={(e) => setCheckNote(e.target.value)} style={inputStyle} /></Field>
              {tubesRemaining !== "" && !isNaN(Number(tubesRemaining)) && (
                <div style={{ fontSize: 12.5, color: "#c7cede", marginBottom: 10 }}>
                  → {zone.tubeCount - Number(tubesRemaining)} tubes filled = <b style={{ color: "#f2c14e" }}>{fmt((zone.tubeCount - Number(tubesRemaining)) * zs.cwtPerTube)} cwt</b>
                </div>
              )}
              <Button onClick={submitCheck} disabled={readOnly}><Plus size={14} /> Add check</Button>
              <div style={{ marginTop: 14, maxHeight: 150, overflowY: "auto" }}>
                {tubeChecks.length === 0 && <div style={{ color: "#5b6478", fontSize: 12 }}>No checks logged yet.</div>}
                {tubeChecks.map((c, i) => (
                  <div key={i} style={{ fontSize: 12, color: "#c7cede", padding: "6px 0", borderTop: "1px solid #232d40" }}>
                    <b>{c.date}</b> — {c.tubesRemaining} empty ({zone.tubeCount - c.tubesRemaining} filled)
                    {c.note && <div style={{ color: "#8790a3" }}>{c.note}</div>}
                  </div>
                ))}
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

function TemperatureTab({ bays, dataById, onAddTemp, readOnly }) {
  const [bayId, setBayId] = useState(bays[0]?.id);
  const bay = bays.find((b) => b.id === bayId);
  const totalTubes = bay ? bay.zones.reduce((s, z) => s + z.tubeCount, 0) : 0;

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
            {Array.from({ length: totalTubes }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
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
        <StatBlock label="Current Δ T (top − bottom)" value={latestDelta != null ? `${latestDelta > 0 ? "+" : ""}${latestDelta}°F` : "—"}
          sub={latestStatus ? latestStatus.note : "need a Top and a Bottom reading on the same date"}
          accent={latestStatus ? latestStatus.color : undefined} />
        <StatBlock label="Average Δ T (all days)" value={avgDelta != null ? `${avgDelta > 0 ? "+" : ""}${avgDelta}°F` : "—"}
          sub={avgDelta != null ? `across ${allDeltas.length} day${allDeltas.length === 1 ? "" : "s"} of readings` : "need a Top and a Bottom reading on the same date"}
          accent={avgStatus ? avgStatus.color : undefined} />
      </div>
      <div style={{ fontSize: 11.5, color: "#6f7890" }}>
        Every reading in this bay counts, from any pipe. Same-day readings of the same position are averaged first;
        Δ T comes from that day's average Top and average Bottom — it doesn't matter which pipes they were taken at, only that they share a date.
        Target Δ T is ~1.5°F once cured. Flagged amber under ~0.5°F (too tight — check airflow), red over 3°F (too wide).
        In the first {CURING_DAYS} days after fill, up to ~5°F is normal and won't be flagged.
      </div>

      <div style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 16, height: 320 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, color: "#eef1f6" }}>{bay?.name} — all pipes, top vs. bottom over time</div>
        {series.length === 0 ? (
          <div style={{ color: "#5b6478", fontSize: 13 }}>No readings yet for this bay.</div>
        ) : (
          <ResponsiveContainer width="100%" height="88%">
            <LineChart data={series} margin={{ right: 8 }}>
              <CartesianGrid stroke="#232d40" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="#8790a3" fontSize={11} />
              <YAxis yAxisId="temp" stroke="#8790a3" fontSize={11} domain={["dataMin - 2", "dataMax + 2"]} label={{ value: "°F", angle: -90, position: "insideLeft", fill: "#8790a3", fontSize: 11 }} />
              <YAxis yAxisId="delta" orientation="right" stroke="#a06bd6" fontSize={11} domain={["dataMin - 1", "dataMax + 1"]} label={{ value: "Δ T °F", angle: 90, position: "insideRight", fill: "#a06bd6", fontSize: 11 }} />
              <Tooltip contentStyle={{ background: "#0e1420", border: "1px solid #2b3549", fontSize: 12 }} labelStyle={{ color: "#eef1f6" }} />
              <Line yAxisId="temp" type="monotone" dataKey="top" stroke="#f2c14e" strokeWidth={2} dot={{ r: 3 }} name="Top °F (avg)" connectNulls />
              <Line yAxisId="temp" type="monotone" dataKey="bottom" stroke="#5fb0d6" strokeWidth={2} dot={{ r: 3 }} name="Bottom °F (avg)" connectNulls />
              <Line yAxisId="delta" type="monotone" dataKey="delta" stroke="#a06bd6" strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2 }} name="Δ T" connectNulls />
            </LineChart>
          </ResponsiveContainer>
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
                    <td style={{ ...tdStyle, color: "#5fb0d6" }}>{r.bottom ? `${r.bottom.temp}°F` : "—"}</td>
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
    const map = new Map(customers.map((c) => [c, { fields: 0, tubes: 0 }]));
    bays.forEach((bay) => bay.zones.forEach((z) => {
      if (!map.has(z.customer)) map.set(z.customer, { fields: 0, tubes: 0 });
      const u = map.get(z.customer);
      u.fields += 1; u.tubes += z.tubeCount;
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
            const u = usage.get(c) || { fields: 0, tubes: 0 };
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
    const map = new Map(varieties.map((v) => [v, { fields: 0, tubes: 0 }]));
    bays.forEach((bay) => bay.zones.forEach((z) => {
      if (!map.has(z.variety)) map.set(z.variety, { fields: 0, tubes: 0 });
      const u = map.get(z.variety);
      u.fields += 1; u.tubes += z.tubeCount;
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
            const u = usage.get(v) || { fields: 0, tubes: 0 };
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
function ManageTab({ locations, buildings, bays, varieties, customers, readOnly, onAddLocation, onAddBuilding, onAddBay, onUpdateLocation, onUpdateBuilding, onUpdateBayMeta, onUpdateZoneMeta }) {
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
  const [bldgError, setBldgError] = useState("");

  const submitBuilding = () => {
    const trimmed = bldgName.trim();
    if (!trimmed || !bldgLocationId) return;
    if (buildings.some((b) => b.locationId === bldgLocationId && b.name.toLowerCase() === trimmed.toLowerCase())) {
      setBldgError(`"${trimmed}" already exists at this location.`); return;
    }
    onAddBuilding({ id: uid("bldg"), name: trimmed, locationId: bldgLocationId });
    setBldgName(""); setBldgError("");
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
  const [zoneRows, setZoneRows] = useState([{ name: "Field 1", variety: varieties[0] || "", customer: "Unassigned", tubeCount: "30", cwtPerTube: "" }]);
  const [bayError, setBayError] = useState("");

  const updateZoneRow = (i, patch) => setZoneRows((rows) => rows.map((r, ri) => ri === i ? { ...r, ...patch } : r));
  const addZoneRow = () => setZoneRows((rows) => [...rows, { name: `Field ${rows.length + 1}`, variety: varieties[0] || "", customer: "Unassigned", tubeCount: "30", cwtPerTube: "" }]);
  const removeZoneRow = (i) => setZoneRows((rows) => rows.length > 1 ? rows.filter((_, ri) => ri !== i) : rows);

  const submitBay = () => {
    const trimmed = bayName.trim();
    if (!trimmed) { setBayError("Give the bay a name."); return; }
    if (!bayBuildingId) { setBayError("Pick or create a building first."); return; }
    for (const r of zoneRows) {
      if (!r.name.trim() || !r.variety || !Number(r.tubeCount) || Number(r.tubeCount) <= 0) {
        setBayError("Every field needs a name, variety, and a tube count greater than 0."); return;
      }
    }
    const bayId = uid("bay");
    const zones = zoneRows.map((r) => ({
      id: uid("zone"), name: r.name.trim(), variety: r.variety, customer: r.customer || "Unassigned",
      tubeCount: Number(r.tubeCount), ...(r.cwtPerTube ? { cwtPerTube: Number(r.cwtPerTube) } : {}),
    }));
    onAddBay({
      id: bayId, name: trimmed, buildingId: bayBuildingId, fillDate: bayFillDate,
      cwtPerTube: zones.every((z) => z.cwtPerTube) ? null : 2500, zones,
    });
    setBayName(""); setZoneRows([{ name: "Field 1", variety: varieties[0] || "", customer: "Unassigned", tubeCount: "30", cwtPerTube: "" }]);
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
        </div>

        <div style={{ fontSize: 11, color: "#8790a3", margin: "10px 0 6px", letterSpacing: 0.3 }}>FIELDS IN THIS BAY</div>
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
              <Field label="Tubes"><input type="number" min="1" value={r.tubeCount} onChange={(e) => updateZoneRow(i, { tubeCount: e.target.value })} style={{ ...inputStyle, width: 80 }} /></Field>
              <Field label="Cwt/tube (optional)"><input type="number" value={r.cwtPerTube} onChange={(e) => updateZoneRow(i, { cwtPerTube: e.target.value })} style={{ ...inputStyle, width: 130 }} placeholder="e.g. 3200" /></Field>
              <Button variant="ghost" onClick={() => removeZoneRow(i)} style={{ marginBottom: 10 }}>Remove</Button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={addZoneRow}><Plus size={14} /> Add field</Button>
        </div>

        {bayError && <div style={{ fontSize: 12, color: "#e08787", margin: "10px 0" }}>{bayError}</div>}
        {readOnly && <div style={{ fontSize: 12, color: "#f2c14e", margin: "10px 0" }}>Switch to the current season to add a bay.</div>}
        <div style={{ marginTop: 10 }}>
          <Button onClick={submitBay} disabled={readOnly}><Plus size={14} /> Create bay</Button>
        </div>
      </div>

      {/* existing structure — click into any field to edit it */}
      <div>
        <div style={{ fontWeight: 700, marginBottom: 4, color: "#eef1f6" }}>Current sites</div>
        <div style={{ fontSize: 11.5, color: "#6f7890", marginBottom: 10 }}>Click any name or value below to rename or correct it — changes save when you click away.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {locations.map((loc) => (
            <div key={loc.id} style={{ background: "#141b28", border: "1px solid #232d40", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <MapPin size={13} color="#f2c14e" />
                <EditableInline value={loc.name} onSave={(v) => onUpdateLocation(loc.id, { name: v })} width={180} />
                <EditableInline value={loc.address} onSave={(v) => onUpdateLocation(loc.id, { address: v })} width={220} placeholder="address" />
                <EditableInline value={loc.lat} type="number" onSave={(v) => onUpdateLocation(loc.id, { lat: v })} width={90} placeholder="lat" />
                <EditableInline value={loc.lng} type="number" onSave={(v) => onUpdateLocation(loc.id, { lng: v })} width={90} placeholder="lng" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
                {buildings.filter((b) => b.locationId === loc.id).map((b) => (
                  <div key={b.id} style={{ paddingLeft: 16, borderLeft: "2px solid #232d40" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Building2 size={12} color="#8790a3" />
                      <EditableInline value={b.name} onSave={(v) => onUpdateBuilding(b.id, { name: v })} width={220} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                      {bays.filter((bay) => bay.buildingId === b.id).map((bay) => (
                        <div key={bay.id} style={{ paddingLeft: 16, borderLeft: "2px solid #1a2130" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <Package size={12} color="#8790a3" />
                            <EditableInline value={bay.name} disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { name: v })} width={140} />
                            <span style={{ fontSize: 11, color: "#6f7890" }}>filled</span>
                            <EditableInline value={bay.fillDate} type="date" disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { fillDate: v })} width={140} />
                            <span style={{ fontSize: 11, color: "#6f7890" }}>cwt/tube (bay default)</span>
                            <EditableInline value={bay.cwtPerTube ?? ""} type="number" disabled={readOnly} onSave={(v) => onUpdateBayMeta(bay.id, { cwtPerTube: v })} width={90} placeholder="—" />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                            {bay.zones.map((z) => (
                              <div key={z.id} style={{ paddingLeft: 20, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
                                <ColorDot color={getVarietyColor(z.variety)} size={7} /><ColorDot color={getCustomerColor(z.customer)} size={7} />
                                <EditableInline value={z.name} disabled={readOnly} onSave={(v) => onUpdateZoneMeta(bay.id, z.id, { name: v })} width={130} />
                                <span style={{ color: "#6f7890" }}>tubes</span>
                                <EditableInline value={z.tubeCount} type="number" disabled={readOnly} onSave={(v) => onUpdateZoneMeta(bay.id, z.id, { tubeCount: v })} width={70} />
                                <span style={{ color: "#6f7890" }}>{z.variety} · {z.customer}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      {bays.filter((bay) => bay.buildingId === b.id).length === 0 && (
                        <div style={{ paddingLeft: 16, fontSize: 12, color: "#5b6478" }}>No bays yet.</div>
                      )}
                    </div>
                  </div>
                ))}
                {buildings.filter((b) => b.locationId === loc.id).length === 0 && (
                  <div style={{ paddingLeft: 16, fontSize: 12.5, color: "#5b6478" }}>No buildings yet.</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
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
    bay.zones.forEach((zone) => {
      const zs = bs.zoneStats[zone.id];
      const base = { location: locationName, bay: bay.name, field: zone.name, variety: zone.variety };
      rows.push({ ...base, customer: zone.customer, metric: "In Storage", cwt: zs.currentCwt });
      rows.push({ ...base, customer: zone.customer, metric: "Capacity", cwt: zs.capacityCwt });
      rows.push({ ...base, customer: zone.customer, metric: "Shrink", cwt: zs.shrinkCwt });
      (zs.runs || []).forEach((r) => {
        rows.push({ ...base, customer: r.dest, metric: "Shipped", cwt: Number(r.cwt || 0) });
      });
    });
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
  const selectedLocation = locationsById[selectedLocationId] || locations[0];

  const locationBays = useMemo(() => {
    const filtered = displayBays.filter((b) => buildingsById[b.buildingId]?.locationId === selectedLocationId);
    return sortBaysByBuilding(filtered, buildings);
  }, [displayBays, buildingsById, buildings, selectedLocationId]);

  useEffect(() => {
    if (!locationBays.length) return;
    if (!locationBays.find((b) => b.id === selectedId)) setSelectedId(locationBays[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLocationId, selectedSeasonId, locationBays.map((b) => b.id).join(",")]);

  const updateZoneData = useCallback((bayId, zoneId, updater) => {
    if (isReadOnly) return;
    setDataById((prev) => {
      const bayData = prev[bayId] || {};
      const zones = bayData.zones || {};
      const zoneData = zones[zoneId] || { tubeChecks: [], cwtRuns: [] };
      const nextZoneData = updater(zoneData);
      const nextBayData = { ...bayData, zones: { ...zones, [zoneId]: nextZoneData } };
      const next = { ...prev, [bayId]: nextBayData };
      saveJSON(bayDataKey(bayId), nextBayData);
      return next;
    });
  }, [isReadOnly]);

  const onAddTubeCheck = useCallback((bayId, zoneId, entry) => {
    updateZoneData(bayId, zoneId, (zd) => ({ ...zd, tubeChecks: [...(zd.tubeChecks || []), entry] }));
  }, [updateZoneData]);

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
    { id: "checks", label: "Inspections", icon: ClipboardCheck },
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
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
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
            <MapTab key={selectedLocationId} location={selectedLocation} bays={locationBays} statsById={statsById} onSelect={(id) => { setSelectedId(id); setTab("detail"); }} />
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
                  customers={customers} varieties={varieties} readOnly={isReadOnly} onAddTubeCheck={onAddTubeCheck} onAddCwtRun={onAddCwtRun}
                  onUpdateZoneCustomer={onUpdateZoneCustomer} onUpdateZoneVariety={onUpdateZoneVariety} />
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
            <ManageTab locations={locations} buildings={buildings} bays={bays} varieties={varieties} customers={customers} readOnly={isReadOnly}
              onAddLocation={onAddLocation} onAddBuilding={onAddBuilding} onAddBay={onAddBay}
              onUpdateLocation={onUpdateLocation} onUpdateBuilding={onUpdateBuilding} onUpdateBayMeta={onUpdateBayMeta} onUpdateZoneMeta={onUpdateZoneMeta} />
          </div>
        )}

        {tab === "customers" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <CustomersTab customers={customers} bays={displayBays} onAdd={onAddCustomer} />
          </div>
        )}

        {tab === "varieties" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <VarietiesTab varieties={varieties} bays={displayBays} onAdd={onAddVariety} />
          </div>
        )}

        {tab === "temp" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {locationBays.length === 0 ? <EmptySiteNotice onManage={() => setTab("manage")} /> : (
              <TemperatureTab bays={locationBays} dataById={displayDataById} onAddTemp={onAddTemp} readOnly={isReadOnly} />
            )}
          </div>
        )}

        {tab === "checks" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            {locationBays.length === 0 ? <EmptySiteNotice onManage={() => setTab("manage")} /> : (
              <InspectionsTab bays={locationBays} inspections={displayInspections} onAdd={onAddInspection} readOnly={isReadOnly} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
