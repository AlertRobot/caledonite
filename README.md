# Caledonite

Your calendars, side by side. A phone app (installable from Chrome) for Ethan and Sophie that pulls everything from Google Calendar, shows what each other is up to, finds time you're both free, handles requests (plan something, favours, keep time free, heads up), and knows about shifts and sleep after nights.

Try it with made-up data: open the app with `?demo=ethan` or `?demo=sophie` on the end of the address.

## How it fits together

- **The app** (this repo) is a static web app on GitHub Pages. It works offline and installs from Chrome.
- **Firebase** (free Spark plan) holds the shared bits: requests, notes, shift changes, settings, and the calendar copies. Google sign-in only; `firestore.rules` lets in just the two emails in the household.
- **Google Calendar stays the master copy.** The sync script in `apps-script/` runs on each Google account every 10 minutes. It reads the calendars that account can see (including shared family and friends calendars), writes a full copy for its owner and a privacy-filtered copy for the partner (work becomes one "Working" block, or "Busy", or nothing), adds and changes events the app asks for, and sends notifications.
- Notifications use Firebase Cloud Messaging (free).

## One-time setup

1. **Firebase project** (console.firebase.google.com): create a project, add a Web app, and copy its config into `js/config.js` (`FIREBASE.config`).
   - Firestore: create a database (London, `europe-west2`), then paste `firestore.rules` into Rules and publish.
   - Firestore, Indexes, Composite: add an index on the collection `notify` with `sent` Ascending then `sendAfter` Ascending (query scope Collection). The sync then reads only the notifications that are due, not every one waiting (Peckish queues a week of them). Until it's built, the sync reads them all, as before.
   - Authentication: turn on Google. Under Settings, Authorised domains, add `alertrobot.github.io`.
   - Cloud Messaging: under Web Push certificates, generate a key pair and copy the key into `js/config.js` (`FIREBASE.vapidKey`).
   - Project settings, Service accounts: generate a new private key (a JSON file). Keep it private.
2. **Open the app**, sign in with Google and fill in the first-time form (your name, your partner's name and Google email).
3. **Sync script** (script.google.com, signed in as Ethan): new project called "Caledonite sync". Paste in `apps-script/Code.gs`, and in Project Settings tick "Show appsscript.json" and paste `apps-script/appsscript.json`.
   - Script properties: `PROJECT_ID` (the Firebase project id) and `SA_JSON` (the whole service account JSON, pasted by you).
   - Two web app deployments (Deploy, New deployment, Web app), both from this project:
     - **Ping**: execute as Me, access Anyone. Copy its address into a `PING_URL` script property.
     - **Connect**: execute as User accessing the web app, access Anyone with a Google account. Copy its address into `CONNECT_URL`.
   - Run `setupProject` and allow access when Google asks.
   - After any change to the code, give both deployments a new version (Deploy, Manage deployments, Edit, New version).
4. **Sophie**: in the app, Settings, Calendars shows her the connect page. She opens it signed in as herself, allows access and taps Connect my calendar. Don't share the script project with her: anyone who can edit it can read the service account key in Script properties.
5. **More accounts** (second Gmail, work Google account): add the email in the app under Settings, Account. Then open the connect page while signed in to that account and tap Connect my calendar.

## Tests

- `node --test test/logic.test.mjs test/sync.test.mjs test/ui.test.mjs` runs the logic checks, a few checks of the sync script, and Playwright checks of the demo at phone size (`node test/serve.mjs` serves the folder on its own if you want to look).
- `test/budgie-link.test.mjs` needs Budgie's local test server (see the top of the file).

## Files

- `index.html`, `css/app.css`, `js/*.js`: the app. `js/logic.js` works out who's doing what, shifts, sleep after nights, dinner, and when you're both free.
- `sw.js`: offline support and notifications.
- `apps-script/`: the calendar sync.
- `firestore.rules`: who can read and write what.
