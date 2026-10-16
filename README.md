# Lowfly

Low-poly flight sim with online multiplayer.

## Run it

```
npm install
npm start
```

Open http://localhost:8080 in two browser tabs, click **Go online** in each, then take off.

`server.js` serves `index.html` and the WebSocket endpoint (`/ws`) from the same port, so one process is the whole site.

## Put it on a website

- Needs a host that can run a long-lived Node process (a VPS, Fly.io, Railway, Render, and so on). Static-only hosts such as GitHub Pages or Netlify cannot run the server.
- Serve it over HTTPS. The page then connects with `wss://` on its own. If you use a reverse proxy (nginx, Caddy), make sure it forwards WebSocket upgrades for `/ws`.
- To host the page on one domain and the server on another, open the page with `?server=wss://your-server.example.com/ws`.
- Optional environment variables: `PORT` (default 8080), `MAX_PLAYERS` (default 32), `ALLOWED_ORIGINS` (comma-separated list of origins allowed to connect, for example `https://lowfly.example.com`).
- Health check: `GET /healthz`.

## How it works

- Everyone runs their own flight physics. Each pilot sends position, rotation, velocity, control positions and a firing flag about 15 times a second. The server relays this to the other pilots, who draw smoothed aircraft with name tags and see tracers and missiles.
- The shooter decides whether a bullet or missile hit and tells the victim, who takes the damage (100 hp; a bullet does 5, a missile 70). The server counts kills for the scoreboard and the kill feed.
- Target drones use a shared clock, so everyone sees them in the same place, and a drone shot down by one pilot disappears for all.
- Offline play still works: the game only connects when you press **Go online**.

## Known limits

- Hits are decided on the shooter's side, so a modified client could cheat. Fine for friends; a public game would need server-side checks.
- Aircraft do not collide with each other.
- There is one shared world for everybody who connects.
- Other pilots' missiles fly straight on other screens. Only the owner's missile homes, and the owner's result is what counts.
