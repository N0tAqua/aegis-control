# Aegis Control

Discord protection bot, licence server and web dashboard in one project.

- `src/` — the bot (discord.js) and its features
- `server/worker.js` — the Aegis HTTP API, written as a Cloudflare Worker
- `server/node/` — adapters that run that same API on plain Node (SQLite + disk)
- `scripts/selfhost.mjs` — single process: API + dashboard + bot
- `electron/` + `renderer/` — the Windows desktop app

## Run the whole server on one host

```
npm install
PORT=8099 ADMIN_TOKEN=change-me DISCORD_TOKEN=<bot token> npm run selfhost
```

Open `http://localhost:8099`. The console prints the first-run **owner key**;
register with it, then create licence keys. Data lives in `host-data/`
(SQLite database, uploaded updates, bot settings). Node 22.5+ is required,
Node 24 recommended.

Step-by-step for Wispbyte (Node image, git pull, env vars) is in
[SELFHOST.md](SELFHOST.md).

## Desktop app

```
npm start        # run the Electron app
npm run dist     # build the portable .exe into dist/
```

The app has no built-in server address. Set `AEGIS_API_URL`, or save the address
(for example `http://your-host:14651`) in `%APPDATA%\aegis-control\api-url.txt`,
and it uses that. Without one it says so and calls nothing, so it can never fall
back to an old or unrelated server.

## Building from GitHub

`.github/workflows/build.yml` builds the portable `.exe` on every push to `main`
and attaches it to the release for the version in `package.json`. Bump that
version to publish an update that installed apps see as newer.

The download page (`/download`) and `/api/releases/latest` — which the app uses
for updates — read that GitHub release. The repository comes from `repository`
in `package.json`, or from `AEGIS_GITHUB_REPO=owner/repo` when set, so the server
does not have to be told where the builds live.
