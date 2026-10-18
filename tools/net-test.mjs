#!/usr/bin/env node
// tools/net-test.mjs — exercises the multiplayer protocol against a live server.
//
// Starts tools/server.mjs on a scratch port, connects two Node WebSocket clients, and
// checks the parts of the protocol the browser client depends on:
//
//   - join returns a welcome with an id, the seed and the edit log
//   - an edit made by one player reaches the other and lands in the log
//   - a player who joins later receives the earlier edit in their welcome snapshot
//   - movement and chat are relayed
//   - the edit log survives a server restart (state file round-trip)
//
// Node 22+ ships a global WebSocket client, so this needs no dependencies either.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.argv[2] || 8139);
const URL = `ws://127.0.0.1:${PORT}/`;
const STATE = path.join(ROOT, 'net-world.json');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stop = (child) => new Promise((res) => { child.once('exit', res); child.kill(); });

function startServer() {
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), String(PORT)], {
    cwd: ROOT, stdio: 'ignore',
  });
  return child;
}

/** Minimal client that records everything it receives. */
function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    ws.onmessage = (ev) => { try { inbox.push(JSON.parse(ev.data)); } catch (e) { /* ignore */ } };
    ws.onerror = (e) => reject(new Error('socket error'));
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', name })); resolve({ ws, inbox }); };
  });
}

const waitFor = async (inbox, pred, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const found = inbox.find(pred);
    if (found) return found;
    await sleep(20);
  }
  return null;
};

// start from a clean state file so the replay check is meaningful
try { fs.rmSync(STATE, { force: true }); } catch (e) { /* ignore */ }

let server = startServer();
await sleep(600);

try {
  // ---- two players join
  const a = await connect('alice');
  const welcomeA = await waitFor(a.inbox, (m) => m.t === 'welcome');
  check('join returns a welcome', !!welcomeA && typeof welcomeA.id === 'number',
    welcomeA && `id=${welcomeA.id}`);
  check('welcome carries a seed', !!welcomeA && typeof welcomeA.seed === 'string',
    welcomeA && welcomeA.seed);

  const b = await connect('bob');
  const welcomeB = await waitFor(b.inbox, (m) => m.t === 'welcome');
  check('second player gets their own id', !!welcomeB && welcomeB.id !== welcomeA.id);
  const joinSeen = await waitFor(a.inbox, (m) => m.t === 'join' && m.name === 'bob');
  check('existing player is told about the newcomer', !!joinSeen);

  // ---- an edit reaches the other client
  a.ws.send(JSON.stringify({ t: 'edit', x: 5, y: 70, z: -3, block: 4 }));
  const editSeen = await waitFor(b.inbox, (m) => m.t === 'edit' && m.x === 5 && m.y === 70 && m.z === -3);
  check('edits are relayed to other players', !!editSeen && editSeen.block === 4);

  // ---- movement and chat relay
  a.ws.send(JSON.stringify({ t: 'move', x: 1, y: 2, z: 3, yaw: 0.5, pitch: -0.2 }));
  const moveSeen = await waitFor(b.inbox, (m) => m.t === 'move' && m.id === welcomeA.id);
  check('movement is relayed', !!moveSeen && Math.abs(moveSeen.x - 1) < 1e-6);
  a.ws.send(JSON.stringify({ t: 'chat', msg: 'hello' }));
  const chatSeen = await waitFor(b.inbox, (m) => m.t === 'chat' && m.msg === 'hello');
  check('chat is relayed', !!chatSeen && chatSeen.name === 'alice');

  // ---- a late joiner replays the edit log
  const c = await connect('carol');
  const welcomeC = await waitFor(c.inbox, (m) => m.t === 'welcome');
  const replayed = welcomeC && welcomeC.edits.some(([x, y, z, block]) => x === 5 && y === 70 && z === -3 && block === 4);
  check('a late joiner receives the edit log', !!replayed,
    welcomeC && `${welcomeC.edits.length} edits`);

  // ---- bad input is refused rather than crashing the server
  a.ws.send(JSON.stringify({ t: 'edit', x: 0, y: 999, z: 0, block: 1 }));
  const errSeen = await waitFor(a.inbox, (m) => m.t === 'error', 400);
  check('out-of-range edits are dropped', !errSeen);   // silently ignored, server stays up

  for (const cl of [a, b, c]) cl.ws.close();
  await sleep(300);

  // ---- the state file survives a restart
  await stop(server);
  await sleep(300);
  const saved = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  check('the edit log is persisted', Array.isArray(saved.edits) && saved.edits.length >= 1,
    `${saved.edits.length} edits`);

  server = startServer();
  await sleep(600);
  const d = await connect('dave');
  const welcomeD = await waitFor(d.inbox, (m) => m.t === 'welcome');
  const survived = welcomeD && welcomeD.edits.some(([x, y, z]) => x === 5 && y === 70 && z === -3);
  check('a restarted server replays the saved log', !!survived);
  d.ws.close();
} catch (err) {
  check('protocol test ran without throwing', false, err.message);
} finally {
  try { await stop(server); } catch (e) { /* ignore */ }
  try { fs.rmSync(STATE, { force: true }); } catch (e) { /* ignore */ }
}

console.log('');
console.log(failures.length ? `${failures.length} failed: ${failures.join(', ')}` : 'all multiplayer checks passed');
process.exitCode = failures.length ? 1 : 0;
// let the child process handles finish closing; forcing exit here trips a libuv assertion
await sleep(200);
