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

The app talks to `https://aegis-license-server-6z1s1v.freebuff.site` unless
`AEGIS_API_URL` is set (or `%APPDATA%\aegis-control\api-url.txt` holds a URL),
which is how it is pointed at a self-hosted server.
