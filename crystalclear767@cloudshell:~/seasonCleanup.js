// Season-record cleanup for the AgWorld sync.
//
// The sync writes one record per field per season (fields/{id}/seasons/{seasonId})
// but used to leave a record behind when AgWorld stopped returning that field
// for that season (for example, a field taken out of the 2027 season while it
// still sits in 2026 and 2028). The leftover kept showing the field on that
// year's schedule. After each sync, this removes the records AgWorld did not
// return for a season it fetched successfully.
//
// Safety: if one season would lose more than 25 records AND more than 10% of
// its records in a single run, nothing is removed for that season and the run
// logs a warning instead. That would mean AgWorld sent back a partial answer
// (or something unusual happened), not a handful of fields being taken out.

const MIN_SAFE_REMOVALS = 25;
const MAX_SAFE_SHARE = 0.1;

// existing: [{ fieldId }]; writtenIds: Set of field ids AgWorld returned.
// Returns { stale: [indexes into existing], blocked: boolean }.
function planSeasonCleanup(existing, writtenIds) {
  const stale = [];
  existing.forEach((e, i) => { if (!writtenIds.has(String(e.fieldId))) stale.push(i); });
  const limit = Math.max(MIN_SAFE_REMOVALS, Math.floor(existing.length * MAX_SAFE_SHARE));
  return { stale, blocked: stale.length > limit };
}

// writtenBySeason: { [seasonId]: Set of field ids written this run } (only
// seasons that were fetched successfully). Returns { removed, blockedSeasons }.
async function removeStaleSeasonRecords(db, writtenBySeason) {
  let removed = 0;
  const blockedSeasons = [];
  for (const [seasonId, writtenIds] of Object.entries(writtenBySeason)) {
    const snap = await db.collectionGroup('seasons').where('seasonId', '==', String(seasonId)).get();
    const docs = snap.docs.filter((d) => d.ref.parent && d.ref.parent.parent);
    const existing = docs.map((d) => ({ fieldId: d.ref.parent.parent.id }));
    const plan = planSeasonCleanup(existing, writtenIds);
    if (!plan.stale.length) continue;
    if (plan.blocked) {
      console.warn(`Season ${seasonId}: ${plan.stale.length} of ${docs.length} records were not returned by AgWorld; too many to remove automatically, leaving them.`);
      blockedSeasons.push(String(seasonId));
      continue;
    }
    for (let i = 0; i < plan.stale.length; i += 400) {
      const batch = db.batch();
      plan.stale.slice(i, i + 400).forEach((idx) => batch.delete(docs[idx].ref));
      await batch.commit();
    }
    removed += plan.stale.length;
    console.log(`Season ${seasonId}: removed ${plan.stale.length} leftover field records.`);
  }
  return { removed, blockedSeasons };
}

module.exports = { removeStaleSeasonRecords, planSeasonCleanup };
