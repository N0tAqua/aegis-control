# Running Aegis on one server (Wispbyte)

One Node process serves the API, the dashboard and the Discord bot, with the
database stored as a SQLite file and uploads on disk. No Cloudflare, no second
host, no request allowance.

## 1. Create the server

1. Wispbyte → **Create Server** → pick the **Node.js** image (Node 24 if the
   image list offers it, Node 22 also works).
2. Note the **Address** on Console → Server info (`node.wispbyte.com:12345`).
   The number after `:` is your port.

## 2. Upload the project

Upload the project folder with **Files** or SFTP (or let the panel pull it from
GitHub). Keep the folder layout intact: `index.js`, `package.json`, `src/`,
`server/` and `scripts/` must sit in the server root.

If the panel shows *"Startup file not found … no .js files in the root folder"*,
the upload landed in a subfolder (for example `aegis/index.js`) or nothing has
been uploaded yet. Either move the contents up one level, or point **Startup →
JS_FILE** at that path (`aegis/index.js`).

## 3. Startup and variables

**Startup** → startup file `index.js` (or Startup Command `node index.js`).
`index.js` only boots `scripts/selfhost.mjs`.

**Startup** → environment variables:

| Name | Value |
| --- | --- |
| `PORT` | the port from your Address (`12345`) |
| `DISCORD_TOKEN` | your bot token |
| `ADMIN_TOKEN` | any long random string |
| `NODE_ENV` | `production` (stops the panel installing Electron, which this server never uses) |
| `AEGIS_ALWAYS_RUN` | `1` |

`PORT` is required — the container reaches your app on that exact port.
`ADMIN_TOKEN` only seeds the session secret; it is not a login.

Optional once the dashboard works: create a host token under **Host runner**,
then add `AEGIS_HOST_TOKEN=<token>` and restart. That switches the bot to the
runner, which adds in-dashboard start/stop.

## 4. Sign in

Open the Address in a browser (or add a subdomain under **Subdomains**). The
first visit shows the **owner key** — register the owner account with it. Then
create licence keys for your users as usual.

Existing accounts and keys on the old hosted site do **not** move across: this is
a fresh database, so create a new owner account and new licence keys here.

## 5. Point the desktop app at it (optional)

The web dashboard already does everything. For the app, set `AEGIS_API_URL` to
`http://your-address:port` before launching, or save the same URL in
`%APPDATA%\aegis-control\api-url.txt`.

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
