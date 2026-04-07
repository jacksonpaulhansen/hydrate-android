# Hydrate

Hydrate now ships as two companion apps that share the same hydration model:

- `Android companion app`
  Runs from `index.html` / `src/main.ts`
  Owns reminder scheduling and Android notifications
- `Even Hub glasses app`
  Runs from `glasses.html` / `src/glasses.ts`
  Pushes the Hydrate HUD to G2 through `@evenrealities/even_hub_sdk`

## What Syncs

Both apps can:

- add and remove hydration entries
- edit goal, reminder, and quick-add settings
- sign into the same Google account
- auto-sync on open
- auto-refresh every 5 seconds

## Run Locally

1. Install once:
   - `npm install`
2. Create `.env` from `.env.example` and fill in Firebase Web app values
3. In Firebase Console, enable:
   - Google sign-in in Authentication
   - Cloud Firestore
4. Start Vite:
   - `npm run dev`
5. Open either page:
   - Android companion: `http://127.0.0.1:5173/`
   - Glasses app preview: `http://127.0.0.1:5173/glasses.html`

## Android App

1. Build and sync web assets into Android:
   - `npm run build:app`
2. Open Android Studio:
   - `npm run android`

The Android app is still the reminder owner. Reminder settings now sync automatically from the cloud, so when the glasses app changes them the phone app picks them up and reschedules reminders on the next sync pass.

## Even Hub / G2 App

- `app.json` now points to `glasses.html`
- local EHPK builds also package `glasses.html` as the Even Hub entrypoint
- the G2 app pushes a text HUD summary and a list-based quick add control to the glasses
- the G2 app uses the same Firebase account state as the phone app for hydration sync

## Debug Notes

- Android companion debug toggle: `Ctrl+Shift+D`
- Glasses app debug toggle: `Ctrl+Shift+D`
- Glasses app double click: exits through `shutDownPageContainer(0)` when running inside Even Hub
