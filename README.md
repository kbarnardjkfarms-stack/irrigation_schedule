# Grindstone Irrigation Schedule — PWA

A mobile-friendly, offline-first rebuild of the irrigation scheduling workbook.

**A note on file layout:** this project is set up flat — every file sits at
the top level (no `src/` folder) — specifically so it uploads cleanly
through GitHub's drag-and-drop web uploader, which doesn't reliably
preserve subfolders. If you later move this to a proper local setup with
GitHub Desktop or `git`, it'll work exactly the same either way; the flat
layout was purely a workaround for the browser upload step.

The Cloud Functions code (the Agworld sync) is **not included in this
upload** for the same reason — it needs its own `package.json` in a
`functions` folder, which the flat layout can't accommodate. See "Adding
the Agworld sync later" near the bottom for how to add that back in once
you're comfortable with GitHub Desktop or ready to deploy for real.

Field list (52 fields, acres, crop, ditch rider, GPM demand) is seeded from
your spreadsheet in `fields.json`. Crew members tap AM/PM buttons per
field per day; changes sync automatically across every phone when connected,
and queue locally when the signal drops in the field.

## How the offline part works
- The app itself (HTML/JS/CSS) is cached by a service worker, so it opens
  with zero signal once someone has loaded it once.
- Schedule data lives in Firestore with offline persistence turned on — every
  device keeps a full local copy. Toggling a shift writes to that local copy
  instantly, then queues to sync the moment connectivity returns. No manual
  "sync" button needed.
- If two people are offline and toggle the same field/shift before either
  reconnects, the last write to actually reach the server wins — each toggle
  is stamped with who changed it and when, so nothing disappears silently.

## One-time setup (about 15 minutes, all free tier)

1. **Create a Firebase project**
   - Go to https://console.firebase.google.com → "Add project" → name it
     (e.g. "grindstone-irrigation") → skip Google Analytics (not needed).

2. **Register a web app**
   - In the project, click the `</>` (web) icon → nickname it → "Register app".
   - Firebase shows you a `firebaseConfig` object. Copy it.

3. **Paste your config**
   - Open `firebase.js` and replace the `firebaseConfig` placeholder
     values with the ones you copied.

4. **Turn on Firestore**
   - In the Firebase console: Build → Firestore Database → "Create database"
     → start in production mode → pick a region close to you.

5. **Install tools and dependencies**
   ```bash
   npm install -g firebase-tools
   npm install
   firebase login
   firebase init hosting   # choose "Use an existing project", pick yours,
                            # public directory: dist, single-page app: yes,
                            # don't overwrite firebase.json if asked
   ```

6. **Deploy**
   ```bash
   npm run deploy
   ```
   This builds the app and publishes it to a URL like
   `https://grindstone-irrigation.web.app` — that's the link the crew opens
   and can "Add to Home Screen" on their phones for a full-screen app icon.

## Running it locally first (optional but recommended)
```bash
npm install
npm run dev
```
Opens at http://localhost:5173 — test it, toggle some shifts, then deploy.

## Syncing the field list from Agworld

The `functions/` folder has a Cloud Function that pulls your field list
(name, crop, acres, farm) from Agworld's read-only API and merges it into
Firestore — automatically every morning, plus an on-demand trigger for
testing. Your GPM, ditch rider, and diversion point stay exactly as you've
entered them in the app; the sync only ever touches the fields Agworld
actually knows about.

**Important:** treat any Agworld API token as a secret, the same as a
password. It should never be pasted into chat, committed to a file, or put
in client-side code — only stored via Firebase's secret manager, below.

1. **Get an API token from Agworld**
   - Agworld's API is read-only and token-based. If you don't already have
     a token, contact Agworld support to request API access:
     https://help.agworld.com/en/articles/2497766-how-to-contact-agworld-customer-success
   - If a token has ever been shared outside Agworld's own token
     management screen (e.g. pasted in an email or chat), treat it as
     compromised and generate a new one before using it here.

2. **Check your Agworld region**
   - `functions/index.js` defaults to the US instance
     (`https://us.agworld.co`). If your account is on a different region,
     update `AGWORLD_BASE_URL` at the top of that file (Australia:
     `https://my.agworld.com.au`, New Zealand: `https://nz.agworld.co`).

3. **Store the token as a Firebase secret** (never in the code itself)
   ```bash
   firebase functions:secrets:set AGWORLD_API_TOKEN
   ```
   Paste the token when prompted. Firebase stores it encrypted and injects
   it only into this function at runtime.

4. **Deploy the function**
   ```bash
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```

5. **Test it**
   - After deploy, Firebase gives you a URL for `syncAgworldFieldsNow`.
     Open it in a browser once to confirm it pulls fields into Firestore
     (check the `fields` collection in the Firebase console). After that,
     it runs on its own every morning at 5am.

If your Agworld account covers more than this one operation, uncomment and
set `FARM_ID_FILTER` in `functions/index.js` to scope the sync to just your
farm(s) — otherwise it pulls every field your token has access to.

## Adding the Agworld sync later
The Cloud Function that pulls your field list from Agworld wasn't included
in this upload (see the note at the top). Once you're using GitHub Desktop
or comfortable with a couple more steps, you can add it back in:
1. In GitHub Desktop (or the GitHub website's "Create new file" button,
   typing `functions/index.js` as the filename — GitHub creates the folder
   automatically when you type a path with a slash in it), add two files:
   `functions/index.js` and `functions/package.json`.
2. Ask me for that code again and I'll regenerate it to match.

## Where to go from here
- **Pull real pivot data instead of manual toggles**: this is a natural
  next step once the BaseStation3 wet-hours API access is sorted out —
  a scheduled job could write actual "on" hours into the same Firestore
  collection, so the app shows real pivot status next to the planned
  schedule instead of only what the crew marks by hand.
- **Ditch rider rollups**: the demand-by-ditch-rider math from the
  DITCH RIDER sheet isn't wired in yet — happy to add that view (sum of
  AM/PM demand per rider, matching your existing tab) once you've seen
  this running.
- **Fertilizer / chemical schedules**: same pattern could extend to those
  two sheets if useful.
- **Access control**: right now anyone with the link can edit (no login),
  which matches how the spreadsheet works today. If you want a simple PIN
  or per-user login later, that's a small addition.
