# Spray schedule module (drone crew + Ag Rows)

Moving the Google Apps Script spray schedule into AIO, one step at a time. The old Google app keeps
running until this is proven, so nothing changes for the crews yet.

## Steps

1. **AgWorld sync on the server** ✓
2. Spray screens in AIO: **2a Schedule + Crew list** ← this change; then Calendar, Map, Acres, Season log, Records, Costs
3. No-login crew links (drone pilots, Ag Rows office and operators)
4. Emails (Done notices, Robby's spread alerts, 6pm wind warning, Monday summary, monthly drone records)
5. One-time import from the Google Sheet (Operators, Managers, Drones, Hours, Costs, flight logs, Season log)
6. Side-by-side testing, then switch over

## Step 1: what it adds

| File | What |
|---|---|
| `functions/spraySync.js` | The sync. Same rules as the Google app: Ground Spraying / Ground Spreading labels, drone words, chemigation / fumigation / injection / boom sprayer left out, rec → work order → actual as one job, gallons / GPA / conditions from the actual, removed jobs come back when AgWorld changes them. Field pins come from AIO's `fieldBoundaries` (no more map sheet). |
| `functions/index.js` | Three new functions at the bottom (nothing else touched): `syncSprayJobs` (hourly), `syncSprayJobsFull` (nightly 2:07), `syncSprayJobsNow` (Admin/Owner, from the app later). They use the existing `AGWORLD_API_TOKEN` secret. |
| `firestore.rules` | Read access to the spray collections for Admin, Owner and Farm manager logins with the `spray` module. No browser writes. |
| `Users.jsx` | "Spray schedule" added to the module checkboxes. |

### Firestore

- `sprayJobs/{jobKey}`: written only by the sync, one doc per job on the schedule.
- `sprayJobState/{jobKey}`: what people do in the app (operator, done, moved, removed, flight log), plus Season log rows from AgWorld. It outlives the job doc, so history stays.
- `sprayMeta/sync`: last run times, saved AgWorld filter values, the run lock.
- `spraySyncLog/{id}`: one doc per run with counts, what was skipped and why, and any error.

## After merging

Pushing `functions/**` or `firestore.rules` to `main` deploys automatically (Deploy Cloud Functions workflow).

1. The first hourly run only looks back two days. To fill the whole season right away, wait for the
   2:07 am full check, or run `syncSprayJobsFull` once from the Google Cloud console
   (Cloud Scheduler → the job for `syncSprayJobsFull` → Force run).
2. Check Firestore → `spraySyncLog`: the newest doc should show `fetched` in the thousands on a full
   check, `kept` in the tens, and `error` empty. `skipped` lists what was left out and why.
3. Spot-check `sprayJobs` against the Google app's Jobs tab: same jobs, same fields and acres.

## Step 2a: Schedule screen + Crew list

| File | What |
|---|---|
| `Spray.jsx` | The Spray module: Schedule (operator lanes, job cards with weather at the field pin, PDF / Directions / Call / Done, details with assign operator, move date, remove), done jobs, removed jobs with Restore, and the Crew list (Admin). |
| `sprayMath.js` | Plain logic for the screens (merging jobs with app state, lanes, day labels, weather summary, wind colors). |
| `functions/sprayActions.js` | `sprayAct`: every change (assign, done, undo, move, remove, restore, crew list) goes through here with role checks. Admin/Owner: everything. Farm manager: view only. |
| `functions/index.js` | One new line: `exports.sprayAct`. |
| `functions/spraySync.js` | Job pins: AgWorld's field outline first, then the AIO Farm Map outline with the same name (`farmFields`), so fields AgWorld has no outline for still get a pin and weather. |
| `firestore.rules` | Read access to `sprayOperators` (same audience as the other spray collections). |
| `App.jsx` | Spray tile on the home screen and the page itself (Admin, Owner, Farm manager with the `spray` module). |
| `styles.css` | `.spray-*` styles, appended at the end. The Spray screens are dark (easier on the eyes in the field); the rest of AIO is unchanged. |

To see it: Users → your login → make sure **Spray schedule** is checked (Admin/Owner always have it).
Add the crew under Spray → **Crew** first, so operators can be picked on jobs.

Not yet in 2a (coming next): the drone flight log on Done, emails on Done, Calendar, Map, Acres,
Season log, Records, Costs, crew links.
