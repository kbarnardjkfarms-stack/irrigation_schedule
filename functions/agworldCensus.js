// Agworld activity census (Nov 2026) — one-time discovery tool
//
// Question it answers: do Agworld *plans* (planned activities for next
// season) come through the API, and what do they carry that the Operations
// schedule could use (due date, timing, area, fields, equipment)?
//
// The API docs list an activity_type filter ("e.g. workorder,
// recommendation") but never list the values, and their examples only show
// ActualActivity and WorkOrder. So this reads every activity updated since
// Jan 1 2026 and tallies what is really there, without writing anything back
// to Agworld (the API is read-only anyway).
//
// Usage: open
//   https://us-central1-irrigation-schedule-f8b69.cloudfunctions.net/agworldActivityCensus
// It answers with counts only (types, categories, timings, equipment names,
// job titles, date ranges). One raw example per activity type is saved to
// Firestore diagnostics/agworldActivityCensus, which only the Firebase
// console can see — no people's names go out on the open link.
//
// Remove once the Operations plan sync is built; like
// testAgworldApplicationEndpoints, it's a discovery tool.

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const MAX_PAGES = 120;
// Values worth trying on the activity_type filter in case plans are only
// returned when asked for by name.
const TYPE_PROBES = ['PlannedActivity', 'Planned', 'Plan', 'PlanActivity', 'BudgetActivity', 'Recommendation', 'WorkOrder', 'ActualActivity'];

function tally(map, key, extra) {
  const k = key == null || key === '' ? '(blank)' : String(key);
  const t = map[k] || (map[k] = { n: 0 });
  t.n++;
  if (extra) extra(t);
}
const top = (map, n = 60) => Object.entries(map).sort((a, b) => b[1].n - a[1].n).slice(0, n).reduce((o, [k, v]) => ((o[k] = v), o), {});
const dateOnly = (s) => (s ? String(s).slice(0, 10) : null);

function makeExports(AGWORLD_TOKEN, agworldGet) {
  const agworldActivityCensus = onRequest({ secrets: [AGWORLD_TOKEN], timeoutSeconds: 540, memory: '1GiB' }, async (req, res) => {
    const token = AGWORLD_TOKEN.value();
    const since = String(req.query.since || '2026-01-01');
    const out = { since, pages: 0, activities: 0, truncated: false, byType: {}, probes: {} };
    try {
      // 1. Everything updated since `since`.
      const all = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const params = new URLSearchParams({ 'page[number]': String(page), 'page[size]': '100', updated_at: `${since}T00:00:00Z` });
        const json = await agworldGet('/user_api/v1/activities', params, token);
        out.pages = page;
        all.push(...(json.data || []));
        if (!json.data || json.data.length < 100) break;
        if (page === MAX_PAGES) out.truncated = true;
      }
      out.activities = all.length;

      const byType = {}, category = {}, status = {}, jobStatus = {}, phase = {}, timing = {}, assets = {}, assetCats = {}, titles = {}, seasons = {}, keys = {};
      const samples = {};
      all.forEach((a) => {
        const x = a.attributes || {};
        Object.keys(x).forEach((k) => { keys[k] = (keys[k] || 0) + 1 });
        const type = x.activity_type || a.type || '(blank)';
        tally(byType, type, (t) => {
          t.completed = (t.completed || 0) + (x.completed ? 1 : 0);
          t.withDueAt = (t.withDueAt || 0) + (x.due_at ? 1 : 0);
          t.withAssets = (t.withAssets || 0) + ((x.farm_assets || []).length ? 1 : 0);
          const d = dateOnly(x.due_at || x.completed_at || x.started_at || x.created_at);
          if (d) { if (!t.from || d < t.from) t.from = d; if (!t.to || d > t.to) t.to = d }
          const acres = Number(String(x.area && (x.area.value ?? x.area)).replace(/[^0-9.]/g, ''))
          if (Number.isFinite(acres)) t.area = Math.round((t.area || 0) + acres);
        });
        tally(category, `${type} · ${x.activity_category || '(no category)'}`);
        tally(status, `${type} · ${x.activity_status || '(none)'}`);
        if (x.job_status) tally(jobStatus, `${type} · ${x.job_status}`);
        tally(phase, `${type} · ${x.season_phase || '(none)'}`);
        if (x.timing) tally(timing, `${type} · ${x.timing}`);
        (x.farm_assets || []).forEach((fa) => { tally(assets, `${fa.category || '?'} · ${fa.name || fa.id}`); tally(assetCats, fa.category) });
        tally(titles, `${type} · ${x.title || '(untitled)'}`);
        (x.activity_fields || []).forEach((f) => tally(seasons, `${type} · season ${f.season_id}`));
        if (!samples[type]) samples[type] = a;
      });
      Object.assign(out, {
        byType, attributeKeys: keys,
        categories: top(category), activityStatus: top(status), jobStatus: top(jobStatus), seasonPhase: top(phase),
        timing: top(timing), farmAssetCategories: top(assetCats), farmAssets: top(assets, 80), titles: top(titles, 80), seasons: top(seasons)
      });

      // 2. Ask for each possible type by name, in case plans are hidden
      //    unless filtered for.
      for (const t of TYPE_PROBES) {
        try {
          const json = await agworldGet('/user_api/v1/activities', new URLSearchParams({ activity_type: t, 'page[size]': '5' }), token);
          out.probes[t] = { returned: (json.data || []).length, types: [...new Set((json.data || []).map((a) => (a.attributes || {}).activity_type))], meta: json.meta || null };
          if ((json.data || []).length && !samples[`probe:${t}`]) samples[`probe:${t}`] = json.data[0];
        } catch (err) {
          out.probes[t] = { error: String(err.message).slice(0, 200) };
        }
      }

      await admin.firestore().collection('diagnostics').doc('agworldActivityCensus').set({
        ranAt: admin.firestore.FieldValue.serverTimestamp(), summary: JSON.stringify(out), samples: JSON.stringify(samples).slice(0, 600000)
      });
      res.json(out);
    } catch (err) {
      console.error('agworldActivityCensus failed', err);
      res.status(500).json({ error: String(err.message).slice(0, 500), partial: out });
    }
  });
  return { agworldActivityCensus };
}

module.exports = { makeExports };
