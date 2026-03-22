# Even G2 Base App

Minimal template for Even Hub simulator-first development.

## One-time setup

1. Put your target URL in `app.config.json`:
   - `publishUrl`: the URL you want encoded into the QR code.
2. Install dependencies once:
   - `npm install`

## Daily use (no manual npm commands)

1. Run `run-even-sim.ps1` (double-click or PowerShell).
2. It starts:
   - local app dev server (`127.0.0.1:5173`)
   - local control bridge (`127.0.0.1:8787`)
   - Even Hub simulator (if found)
3. In the app page, click **Publish**:
   - choose git user and repo from config menus (or manual entry)
   - performs git add/commit/push
   - triggers `publish-qr.ps1`
   - generates `publish-qr.png` and opens `publish-qr.html`
4. Click **Link Git/Repo** to run a guided wizard:
   - pre-fills git name/email when possible
   - asks GitHub username + repo name
   - opens GitHub sign-in/create-repo pages
   - writes git/publish URLs to `app.config.json`
   - updates local git origin remote
5. Click **Reboot App** any time to restart local app services (`5173` + `8787`) and relaunch the runner.

## Important

- **Publish does not deploy your app**. It only creates a QR from `publishUrl`.
- For real glasses testing, `publishUrl` must be reachable by your phone/Even app.
