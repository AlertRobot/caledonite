# Calendite

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
   - Authentication: turn on Google. Under Settings, Authorised domains, add `alertrobot.github.io`.
   - Cloud Messaging: under Web Push certificates, generate a key pair and copy the key into `js/config.js` (`FIREBASE.vapidKey`).
   - Project settings, Service accounts: generate a new private key (a JSON file). Keep it private.
2. **Open the app**, sign in with Google and fill in the first-time form (your name, your partner's name and Google email).
3. **Sync script** (script.google.com, signed in as Ethan): new project called "Calendite sync". Paste in `apps-script/Code.gs`, and in Project Settings tick "Show appsscript.json" and paste `apps-script/appsscript.json`.
   - Script properties: `PROJECT_ID` (the Firebase project id) and `SA_JSON` (the whole service account JSON, pasted by you).
   - Deploy, New deployment, Web app, execute as Me, access Anyone. Copy the web app address into a `WEBAPP_URL` script property.
   - Run `setupProject` and allow access when Google asks.
4. **Sophie**: share the script project with her Google account (Share, Editor). She opens it while signed in as herself, picks `connectMe`, presses Run and allows access. That's it.
5. **More accounts** (second Gmail, work Google account): add the email in the app under Settings, Account. Then open the script while signed in to that account and run `connectMe`.

## Files

- `index.html`, `css/app.css`, `js/*.js`: the app. `js/logic.js` works out who's doing what, shifts, sleep after nights, dinner, and when you're both free.
- `sw.js`: offline support and notifications.
- `apps-script/`: the calendar sync.
- `firestore.rules`: who can read and write what.
