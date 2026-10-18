#!/usr/bin/env node
// tools/server.mjs — static file server + zero-dependency WebSocket for MineWeb co-op.
//
//   node tools/server.mjs [port] [root]
//
// One process serves the game and speaks WebSocket on the same port, so a LAN session is
// just "everyone opens http://<host>:8137/ and runs /connect ws://<host>:8137/".
//
// Why hand-rolled: Node ships a WebSocket *client* but no server, and this project has no
// dependencies. Only what the game needs is implemented — text frames, ping/pong, close —
// and anything else (binary, fragmented control frames) is rejected rather than guessed at.
//
// Wire protocol (JSON text frames):
//   client -> server  {t:'join', name}
//                     {t:'move', x, y, z, yaw, pitch}
//                     {t:'edit', x, y, z, block}
//                     {t:'chat', msg}
//   server -> client  {t:'welcome', id, seed, time, players:[...], edits:[[x,y,z,block],...]}
//                     {t:'join', id, name, player}
//                     {t:'leave', id}
//                     {t:'move', id, ...}
//                     {t:'edit', x, y, z, block, id}
//                     {t:'chat', id, name, msg}
//                     {t:'error', msg}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const PORT = Number(process.argv[2] || 8138);
const STATE_FILE = path.join(ROOT, 'net-world.json');
const WORLD_H = 128;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ world state
const state = {
  seed: 'mineweb',
  time: 0.3,
  // key "x,y,z" -> block id, replayed to every new player
  edits: new Map(),
  players: new Map(),   // id -> {name, x, y, z, yaw, pitch}
  nextId: 1,
};

// restore any saved world; the file is optional and written on a debounce after edits
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved && typeof saved.seed === 'string') state.seed = saved.seed;
  if (saved && Array.isArray(saved.edits)) {
    for (const [x, y, z, block] of saved.edits) state.edits.set(`${x},${y},${z}`, block);
  }
} catch (e) { /* first run */ }

// Persist synchronously on every edit. A debounce would be cheaper, but on Windows a
// killed process gets TerminateProcess and never runs its timers or exit handlers, so a
// debounced save silently loses the tail of the log. The file is small and edits are rare.
function saveNow() {
  try {
    const edits = [];
    for (const [key, block] of state.edits) {
      const [x, y, z] = key.split(',').map(Number);
      edits.push([x, y, z, block]);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ seed: state.seed, edits }));
  } catch (e) { /* disk full or read-only: keep playing in memory */ }
}

// ------------------------------------------------------------------ static files
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  // never serve outside the project root
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(data);
  });
});

// ------------------------------------------------------------------ WebSocket
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.id = 0;
    this.name = 'guest';
    this.alive = true;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // a very chatty client must not be able to grow this without bound
    if (this.buf.length > 1 << 20) { this.close(); return; }
    for (;;) {
      const frame = decodeFrame(this.buf);
      if (!frame) return;
      this.buf = this.buf.subarray(frame.total);
      if (frame.opcode === 0x8) { this.close(); return; }
      if (frame.opcode === 0x9) { this.sendRaw(0xA, frame.payload); continue; }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode !== 0x1) { this.send({ t: 'error', msg: 'only text frames are supported' }); this.close(); return; }
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch (e) { continue; }
      handleMessage(this, msg);
    }
  }

  sendRaw(opcode, payload = Buffer.alloc(0)) {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(opcode, payload)); } catch (e) { this.destroy(); }
  }

  send(obj) {
    this.sendRaw(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close() {
    this.sendRaw(0x8);
    try { this.socket.end(); } catch (e) { /* already gone */ }
    this.destroy();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    peers.delete(this);
    if (this.id) { state.players.delete(this.id); broadcast({ t: 'leave', id: this.id }); }
  }
}

const peers = new Set();

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off); off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off); off += 8;
    if (big > BigInt(1 << 20)) return { opcode: 0x8, payload: Buffer.alloc(0), total: buf.length };
    len = Number(big);
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4); off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, total: off + len };
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  peers.add(new Peer(socket));
});

// ------------------------------------------------------------------ protocol
function broadcast(msg, except) {
  for (const p of peers) if (p !== except && p.alive && p.id) p.send(msg);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function handleMessage(peer, msg) {
  switch (msg.t) {
    case 'join': {
      peer.id = state.nextId++;
      peer.name = String(msg.name || 'guest').slice(0, 24);
      const player = { name: peer.name, x: 0, y: 80, z: 0, yaw: 0, pitch: 0 };
      state.players.set(peer.id, player);
      const edits = [];
      for (const [key, block] of state.edits) {
        const [x, y, z] = key.split(',').map(Number);
        edits.push([x, y, z, block]);
      }
      peer.send({
        t: 'welcome', id: peer.id, seed: state.seed, time: state.time, edits,
        players: [...state.players.entries()].filter(([id]) => id !== peer.id)
          .map(([id, pl]) => ({ id, ...pl })),
      });
      broadcast({ t: 'join', id: peer.id, name: peer.name, player }, peer);
      console.log(`[net] ${peer.name} joined as #${peer.id} (${peers.size} online, ${state.edits.size} edits)`);
      break;
    }
    case 'move': {
      if (!peer.id) return;
      const pl = state.players.get(peer.id);
      if (!pl) return;
      pl.x = Number(msg.x) || 0;
      pl.y = Number(msg.y) || 0;
      pl.z = Number(msg.z) || 0;
      pl.yaw = Number(msg.yaw) || 0;
      pl.pitch = Number(msg.pitch) || 0;
      broadcast({ t: 'move', id: peer.id, x: pl.x, y: pl.y, z: pl.z, yaw: pl.yaw, pitch: pl.pitch }, peer);
      break;
    }
    case 'edit': {
      if (!peer.id) return;
      const x = Math.round(Number(msg.x)), y = Math.round(Number(msg.y)), z = Math.round(Number(msg.z));
      const block = Math.round(Number(msg.block));
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      if (!Number.isFinite(block) || block < 0 || block > 255) return;
      if (y < 0 || y >= WORLD_H) return;
      // the server is the authority for the edit log, so a new joiner replays it
      state.edits.set(`${x},${y},${z}`, block);
      saveNow();
      broadcast({ t: 'edit', id: peer.id, x, y, z, block }, peer);
      break;
    }
    case 'chat': {
      if (!peer.id) return;
      const text = String(msg.msg || '').slice(0, 200);
      if (text) broadcast({ t: 'chat', id: peer.id, name: peer.name, msg: text });
      break;
    }
    default:
      peer.send({ t: 'error', msg: 'unknown message type: ' + msg.t });
  }
}

server.listen(PORT, () => {
  console.log(`MineWeb server on http://127.0.0.1:${PORT}/  (websocket ws://127.0.0.1:${PORT}/)`);
  console.log(`  root: ${ROOT}`);
  console.log(`  seed: ${state.seed}`);
  console.log('  in the game: /connect ws://127.0.0.1:' + PORT + '/');
  void clamp;
});
