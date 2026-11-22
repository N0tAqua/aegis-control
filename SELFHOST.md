# Running Aegis on one server (Wispbyte)

One Node process serves the API, the dashboard and the Discord bot, with the
database stored as a SQLite file and uploads on disk. No Cloudflare, no second
host, no request allowance.

## 1. Create the server

1. Wispbyte → **Create Server** → pick the **Node.js** image (Node 24 if the
   image list offers it, Node 22 also works).
2. Note the **Address** on Console → Server info (`node.wispbyte.com:12345`).
   The number after `:` is your port.

## 2. Get the code onto the server

Easiest is git: fill in **Git Repo Address** with the repository URL and
**Install Branch** with `main`, then enable **auto update**. The panel clones the
whole tree, so nothing can go missing.

Uploading by hand also works (Files or SFTP). Keep the folder layout intact:
`index.js`, `package.json`, `src/`, `server/` and `scripts/` must sit in the
server root. If the panel shows *"Startup file not found … no .js files in the
root folder"*, the upload landed in a subfolder or stopped half way — re-upload
from `src/features/` inwards until every folder matches the repository.

## 3. Startup and variables

**Startup** → Startup Command (this also makes **auto update** actually pull):

```bash
if [ -d .git ]; then git pull --ff-only; fi; if [ -f /home/container/package.json ]; then /usr/local/bin/npm install --omit=dev --no-audit --no-fund; fi; /usr/local/bin/node /home/container/index.js
```

`index.js` only boots `scripts/selfhost.mjs`. `--ff-only` keeps the pull from
inventing a merge commit, and `--omit=dev` stops the panel installing Electron.

**Startup** → environment variables:

| Name | Value |
| --- | --- |
| `PORT` | the port from your Address (`12345`) |
| `DISCORD_TOKEN` | your bot token |
| `ADMIN_TOKEN` | any long random string |
| `NODE_ENV` | `production` (stops the panel installing Electron, which this server never uses) |

`PORT` is required — the container reaches your app on that exact port.
`ADMIN_TOKEN` only seeds the session secret; it is not a login.

## 4. Start and stop the bot without stopping the server

The bot runs under a host runner on this same machine, so **Start** and **Stop**
in the dashboard and the app control only the bot: the API, the dashboard and
the website stay up. That is set up automatically — on a fresh install the
server creates the runner token itself, tells you in the log
(`host : runner token created, so dashboard start/stop works`) and starts the
bot online. Nothing to copy and nothing to run on your PC.

| Variable | Effect |
| --- | --- |
| `AEGIS_HOST_RUNNER=0` | do not run the bot on this host at all |
| `AEGIS_HOST_TOKEN` | pin the runner token instead of the generated one |
| `AEGIS_ALWAYS_RUN=1` | the bot ignores Stop and stays up (crashes already restart it) |

If a token was already created in the dashboard, the server leaves it alone —
that token may belong to a runner on another machine. Set `AEGIS_HOST_TOKEN` to
that value instead if you want the runner here.

## 5. Sign in

Open the Address in a browser (or add a subdomain under **Subdomains**). The
first visit shows the **owner key** — register the owner account with it. Then
create licence keys for your users as usual.

Existing accounts and keys on the old hosted site do **not** move across: this is
a fresh database, so create a new owner account and new licence keys here.

## 6. Point the desktop app at it (optional)

The web dashboard already does everything. For the app, set `AEGIS_API_URL` to
`http://your-address:port` before launching, or save the same URL in
`%APPDATA%\aegis-control\api-url.txt`. The app has no fallback address, so until
one is set it tells you where to put it and calls nothing.

## What is stored where

- `host-data/aegis.sqlite` — accounts, keys, sessions, dashboard tokens
- `host-data/files/` — published app updates
- `host-data/bot/` — bot settings, logs and saved run state

Back these up by copying `host-data`. The free plan has 1 GB of disk, which fits
roughly two published builds plus the database.

## Running it locally first

```
PORT=8099 ADMIN_TOKEN=local npm run selfhost
```

The console prints the first-run owner key, so you can register without the
desktop app. Requires Node 22.5+ (Node 24 recommended) for the built-in SQLite
driver.
