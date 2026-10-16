'use strict';
/*
 * Lowfly multiplayer server.
 *   - serves index.html at /
 *   - relays pilot state over a WebSocket at /ws
 *   - keeps the roster, scores and the shared clock
 * Run: npm install && npm start     (PORT, MAX_PLAYERS and ALLOWED_ORIGINS are optional env vars)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 32;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const INDEX = path.join(__dirname, 'index.html');

const players = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end('index.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok ' + players.size);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 2048,
  verifyClient: info => !ORIGINS.length || ORIGINS.includes(info.origin)
});

/* ---- helpers ---- */
const fin = n => typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e7;
const int = (n, lo, hi) => (Number.isInteger(n) && n >= lo && n <= hi) ? n : null;
function vec(a, len) {
  if (!Array.isArray(a) || a.length !== len) return null;
  for (let i = 0; i < len; i++) if (!fin(a[i])) return null;
  return a.slice();
}
function cleanName(n) {
  return String(n == null ? '' : n).replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Pilot';
}
function uniqueName(base) {
  const taken = new Set([...players.values()].map(p => p.name.toLowerCase()));
  let name = base, k = 2;
  while (taken.has(name.toLowerCase())) name = base.slice(0, 13) + ' ' + (k++);
  return name;
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(except, obj) {
  const msg = JSON.stringify(obj), isState = obj.t === 's';
  for (const p of players.values()) {
    if (p === except || p.ws.readyState !== 1) continue;
    if (isState && p.ws.bufferedAmount > 32768) continue;   // slow client: drop position updates
    p.ws.send(msg);
  }
}
function broadcastRoster() {
  broadcast(null, {
    t: 'roster',
    list: [...players.values()].map(p => ({ id: p.id, name: p.name, plane: p.plane, score: p.score }))
  });
}

/* ---- connections ---- */
wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'server full'); return; }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const me = { id: nextId++, ws, name: '', plane: 0, score: 0, alive: false, joined: false, tokens: 100, last: Date.now() };

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    const now = Date.now();                                  // rate limit: about 100 messages per second
    me.tokens = Math.min(100, me.tokens + (now - me.last) / 10); me.last = now;
    if (me.tokens < 1) return;
    me.tokens--;

    if (m.t === 'hello') {
      if (me.joined) return;
      me.name = uniqueName(cleanName(m.name));
      me.plane = int(m.plane, 0, 2) || 0;
      me.joined = true;
      players.set(me.id, me);
      send(ws, { t: 'welcome', id: me.id, name: me.name, now: Date.now() });
      broadcastRoster();
      return;
    }
    if (!me.joined) return;

    switch (m.t) {
      case 's': {                                            // pilot state, about 15 per second
        const p = int(m.p, 0, 2), q = vec(m.q, 4), v = vec(m.v, 3), c = vec(m.c, 4);
        if (p === null || !q || !v || !c || !fin(m.x) || !fin(m.y) || !fin(m.z)) return;
        me.alive = true; me.plane = p;
        broadcast(me, { t: 's', id: me.id, p, x: m.x, y: m.y, z: m.z, q, v, c, f: m.f ? 1 : 0 });
        break;
      }
      case 'msl': {
        const mid = int(m.mid, 0, 1e9), p = vec(m.p, 3), v = vec(m.v, 3);
        if (mid === null || !p || !v) return;
        broadcast(me, { t: 'msl', id: me.id, mid, p, v });
        break;
      }
      case 'mend': {
        const mid = int(m.mid, 0, 1e9), p = vec(m.p, 3);
        if (mid === null || !p) return;
        broadcast(me, { t: 'mend', id: me.id, mid, p, b: m.b ? 1 : 0 });
        break;
      }
      case 'out':                                            // left the air: crashed or went back to the menu
        me.alive = false;
        broadcast(me, { t: 'out', id: me.id, boom: m.boom ? 1 : 0 });
        break;
      case 'hit': {                                          // the shooter reports damage, the victim applies it
        const to = int(m.to, 1, 1e9), target = players.get(to);
        if (!target || target === me || !target.alive || !fin(m.d)) return;
        send(target.ws, { t: 'hit', from: me.id, d: Math.max(1, Math.min(100, Math.round(m.d))) });
        break;
      }
      case 'died': {
        const by = players.get(int(m.by, 1, 1e9));
        if (!me.alive || !by || by === me) return;
        me.alive = false;
        by.score++;
        broadcast(null, { t: 'feed', text: by.name + ' shot down ' + me.name });
        broadcastRoster();
        break;
      }
      case 'tk': {                                           // a shared target drone was shot down
        const i = int(m.i, 0, 63);
        if (i === null) return;
        broadcast(me, { t: 'tk', i });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (players.delete(me.id) && me.joined) {
      broadcast(null, { t: 'out', id: me.id, boom: 0 });
      broadcastRoster();
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {                                          // drop connections that stopped answering pings
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log('Lowfly listening on http://localhost:' + PORT));
