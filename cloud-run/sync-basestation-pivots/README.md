# sync-basestation-pivots

Reads BaseStation3 (Valley) and AgSense 365 pivot status every 10 minutes and writes it to the `pivots` collection in Firestore (status, direction, position, pressure, wet/dry, and the status label / red-fault fields shown under each pivot icon in AIO).

- Runs as a Cloud Run service `sync-basestation-pivots` in `us-central1`, project `irrigation-schedule-f8b69`. Cloud Scheduler job `sync-basestation-pivots-schedule` calls it every 10 minutes.
- Login comes from the service's environment variables `BASESTATION3_USERNAME` and `BASESTATION3_PASSWORD`. They are NOT in this repo and must never be committed.
- Reads the pivot list from the `pivots` collection; skips `statusSource: 'fieldnet'` (FieldNET pivots are read by the FieldNET sync in `functions/`). AgSense devices (`statusSource: 'farmList'`) are read from the farm device list.
- Look-only test: call the service with `?peek=<rtu id, guid or part of a name>`; it writes nothing.

## This folder is NOT deployed by GitHub

Nothing in GitHub deploys this service. This folder is a copy of what is running, kept so it is not lost and can be reviewed.

To change it: edit `index.js` here, then in the Google Cloud console open Cloud Run > `sync-basestation-pivots` > Source tab, open `index.js`, select all, paste the new file, and deploy. Leave `package.json` alone unless the dependencies change. Then update the copy here so the two match.

Check that they match: the newest zip in `gs://run-sources-irrigation-schedule-f8b69-us-central1/services/sync-basestation-pivots/` is what is deployed.

Copy last checked against the deployed version: Nov 10, 2026 (index.js sha256 starts 2b879a4f63cd1d7d).
