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

## Step 2a fixes: Spray admin, farm managers, weather on past-due jobs

- **Spray admin** (`Users.jsx`, `firestore.rules`, `App.jsx`, `functions/sprayActions.js`, `functions/spraySync.js`):
  a checkbox on a login. ONLY logins with it checked can change the spray schedule (assign operators, Done,
  move, remove, crew list, Sync AgWorld). AIO Admin, Owner and Farm manager logins can view it, nothing more.
  The person running the spray operation is the Spray admin; please don't check it for anyone else without
  asking them.
- **Farm managers see their own jobs first** (`Spray.jsx`, `sprayMath.js`, `styles.css`): a "Your farms"
  section at the top (their name on the job, or a farm on their AIO login), then the rest of the schedule.
- **Farm manager + Call button** (`functions/spraySync.js`): the manager comes from the first line of the
  AgWorld comment, as before; if there isn't one, it's the AIO Farm manager whose farms include the job's
  farm (Users screen). Their phone number from Users rides along on the job, so everyone gets the Call
  button. This replaces the Google app's Managers tab. Fills in on the next hourly sync.
- **Weather on past-due jobs** (`Spray.jsx`): they show today's weather, since that's when they'd get done.

## People from the spray Google Sheet (Managers + Operators tabs)

AIO's Users list no longer decides who a job's farm manager is. Outside people with AIO logins never
end up on a job, a Call button or a Done email. The spray schedule's Google Sheet is the list again:

| Tab | Columns AIO reads | Used for |
|---|---|---|
| Managers | name, phone, farms, email, **notify** | The job's manager when the AgWorld comment has none (farms column), the Call button, Done emails |
| Operators | name, crew, rig, phone, active, aliases | The operator dropdown on jobs. Pay, licenses and emails are NOT copied into AIO. |

**notify** (Managers tab): `all` gets every Done email, `spreads` gets Ag Rows spread Done emails.
Rows with notify don't need farms. So Done emails go to: the `all` people + the job's farm manager,
plus the `spreads` people on Ag Rows spread jobs. (Sending is step 4; the recipients are worked out here.)

| File | What |
|---|---|
| `functions/sprayContacts.js` | Reads both tabs with the Sheets API (hourly `syncSprayContacts`, and `syncSprayContactsNow` for the Refresh button, Spray admins only). Writes `sprayContacts` (server only, no browser rule) and `sprayOperators`. An empty or failed read never wipes the lists. |
| `functions/spraySync.js` | Manager + phone come from `sprayContacts` instead of AIO Users. |
| `functions/sprayActions.js` | In-app crew editing is off (the sheet is the list). |
| `functions/index.js` | Two new lines at the bottom: `syncSprayContacts`, `syncSprayContactsNow`. |
| `Spray.jsx` | Crew tab: read-only list from the sheet, Refresh, and the sheet link. Call button uses the sheet's phone. |

Setup, once:
1. Spray → Crew → paste the spray Google Sheet link → **Link + read**. The box shows the address AIO
   reads with; share the sheet with that address as **Viewer**, then press **Refresh from sheet**.
2. If it says the Google Sheets API is turned off, open the link it gives (Firebase project owner) and
   press Enable, then Refresh again.
3. Managers tab: add a `notify` column; put `all` on the operation lead's row and `spreads` on the
   operations manager's row.

## "Field is done" alerts on phones

When a job is marked Done in the app, or the sync sees it closed in AgWorld, a phone alert is queued in
`sprayAlerts/{jobKey}` for the Managers-tab people: `all` (the person running the spray operation), the
job's farm manager, and `spreads` on Ag Rows spread jobs. It waits 90 seconds so Undo can take it back;
`sprayAlerter` (every 2 minutes) sends what's due with Firebase Cloud Messaging. No outside service, no keys.

A phone gets alerts once its person taps **Turn on alerts** on the Spray screen. Their AIO login must match
their Managers-tab row by email (or name); AIO logins not on the sheet never get alerts. iPhone: AIO must be
added to the Home Screen (Safari → Share → Add to Home Screen) and opened from that icon first.

AgWorld closings only alert for jobs that were on the schedule, weren't already Done in the app, and finished
in the last 2 days, so the first full sync never alerts for the whole season.

| File | What |
|---|---|
| `functions/sprayAlerts.js` | Queue / cancel / send alerts; `sprayPushSetup` saves a phone, turns it off, or sends its owner a test. `sprayAlerts` and `sprayPushTokens` have no Firestore rules (server only). |
| `functions/sprayActions.js` | Done queues the alert, Undo cancels it. |
| `functions/spraySync.js` | Job closed in AgWorld → alert (following the job from work order to actual). |
| `functions/index.js` | Two lines: `sprayAlerter`, `sprayPushSetup`. |
| `sprayPush.js`, `push-sw.js`, `vite.config.js` | The phone side: permission + push code, and showing the alert. `push-sw.js` is loaded into AIO's service worker (`importScripts`), copied into the build like the icons. |
| `Spray.jsx`, `styles.css` | The alerts bar under the header (Turn on / Send a test / Turn off). The Done toast says how many people get the alert. |

## Crew links (no sign-in): Ag Rows operators and drone pilots

Spray → Crew → **Make link** next to someone on the sheet's Operators tab, then **Send link** (opens the phone's
share sheet, or copies it). The link opens `/crew/<code>`: their jobs first ("Yours"), then all of their crew's jobs,
with weather, PDF, Directions, Call and **Done** (+ Undo). Ag Rows links see every Ag Rows job; drone links see drone
jobs only. No assigning, moving or removing. **New link** replaces the old one; **Turn off** stops it right away.
Done from a link sends the same field-done phone alert.

| File | What |
|---|---|
| `functions/sprayCrewLinks.js` | `sprayCrew` (the link page: load / Done / Undo, no sign-in; the code is the key), `sprayLinkAdmin` (Spray admins: list / make / turn off). Codes live in `sprayLinks` (no Firestore rule, server only). |
| `functions/index.js` | Two lines: `sprayCrew`, `sprayLinkAdmin`. |
| `main.jsx` | `/crew/<code>` renders the crew page instead of the app (like `/watch/<farm>`). |
| `Spray.jsx` | `SprayCrew` page; Make / Send / New / Turn off link buttons in the Crew tab; Done on cards for crew links. |

When every crew member has an AIO link, the Google app can be switched off; its old links stop working with it.

## Operators and Managers tabs (no more Google Sheet)

The spray Google Sheet isn't read any more. Everything lives in the Spray module (Spray admins only):

- **Operators** (was Crew): add / edit / delete operators: name, Ag Rows or Drone, phone, other spellings,
  Active, and their no-login link (Make / Send / New / Turn off). Drone pilots also carry the **drone (and
  trailer)** they run; it rides onto drone jobs they're put on. Ag Rows jobs carry just the operator (no rig).
- **Managers**: farm managers for the spray schedule, separate from AIO's Users list: name, phone, email
  (the one they sign into AIO with, so alerts find their phone), farms (AIO's farm list), and field-done
  alerts: Their farms / All jobs / Spreads. A manager's farms make them the manager on those jobs when the
  AgWorld comment names nobody (name + Call button). The managers already in AIO from the sheet carry over.

| File | What |
|---|---|
| `Spray.jsx`, `styles.css` | Operators tab (form back, no rig except a pilot's drone), Managers tab, job details pick just the operator. |
| `functions/sprayActions.js` | `saveOperator` / `deleteOperator` back; `listManagers` / `saveManager` / `deleteManager` (Spray admins). |
| `functions/sprayContacts.js` | Sheet reader switched off (its two functions stay exported but do nothing); manager checks for saving. |
| `functions/sprayAlerts.js`, `functions/spraySync.js` | Comments only: managers come from the Managers tab. |
