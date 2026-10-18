// tools/shot.mjs — start a world in real Chrome and capture a batch of camera setups.
// Usage: node tools/shot.mjs [url] [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const OUT = process.argv[3] || 'shots';
const PORT = 9500 + Math.floor(Math.random() * 300);
const PROFILE = path.join(os.tmpdir(), 'mineweb-shot-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((c) => c && fs.existsSync(c));
if (!chrome) throw new Error('chrome not found');

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  '--window-size=1440,810', '--window-position=0,0', '--hide-scrollbars',
  '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  fs.mkdirSync(OUT, { recursive: true });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* retry */ }
    if (!target) await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push(msg.params.entry.text);
    else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push((d?.exception?.description || d?.text || 'exception').split('\n').slice(0, 3).join(' | '));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
    return { value: r.result?.result?.value };
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1424, height: 715, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ARG });
  await sleep(2200);
  await evaluate('window.__MINEWEB__.startNewGame("mineweb-demo")');
  for (let i = 0; i < 600; i++) {
    const r = await evaluate('!!(window.__MINEWEB__.running && window.__MINEWEB__.player)');
    if (r.value) break;
    await sleep(250);
  }
  await evaluate('(() => { const g = window.__MINEWEB__; g.settings.vsync = false; g.settings.maxFps = 240; g.dpr = 1; g.resize(); return true; })()');
  const shots = [];
  const setup = async (name, script, wait = 1500) => {
    await evaluate(script);
    await sleep(wait);
    shots.push(await shot(name));
  };

  // 1. ground level, looking at the horizon
  await setup('01-ground.png', `(() => { const g = window.__MINEWEB__; g.uiMode='playing';
    const p = g.player; p.mode='creative'; p.flying=false; p.pitch=-0.06;
    p.y = g.world.findSurfaceY(Math.floor(p.x), Math.floor(p.z)) + 0.2;
    g.dayTime = 0.28; return true; })()`, 2500);

  // 2. aerial
  await setup('02-aerial.png', `(() => { const g = window.__MINEWEB__; const p = g.player;
    p.flying = true; p.y += 42; p.pitch = -0.5; return true; })()`, 2600);

  // 3. sunset
  await setup('03-sunset.png', `(() => { const g = window.__MINEWEB__; g.dayTime = 0.50;
    const p = g.player; p.y -= 30; p.pitch = 0.02; return true; })()`, 2200);

  // 4. night with a torch-lit camp the harness builds
  await setup('04-night-torches.png', `(() => { const g = window.__MINEWEB__; const p = g.player;
    g.dayTime = 0.78;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      g.world.setBlockAt(x + dx, y, z + dz, 5);
      if (Math.abs(dx) === 3 || Math.abs(dz) === 3) g.world.setBlockAt(x + dx, y + 1, z + dz, 4);
    }
    for (const [dx, dz] of [[-2,-2],[2,-2],[-2,2],[2,2]]) g.world.setBlockAt(x + dx, y + 1, z + dz, 30);
    g.world.setBlockAt(x, y + 4, z, 28);
    // look down at the camp from a little height so the torches are actually in frame
    p.flying = true; p.y += 6; p.pitch = -0.30; return true; })()`, 2600);

  // 5. underwater / lake
  await setup('05-water.png', `(() => { const g = window.__MINEWEB__; const p = g.player;
    g.dayTime = 0.3; p.flying = true; p.pitch = -0.25;
    // find the nearest water surface column
    let best = null;
    for (let r = 4; r <= 90 && !best; r += 2) {
      for (let a = 0; a < 24; a++) {
        const ang = a / 24 * Math.PI * 2;
        const x = Math.floor(p.x + Math.cos(ang) * r), z = Math.floor(p.z + Math.sin(ang) * r);
        const y = g.world.findSurfaceY(x, z);
        if (g.world.isLiquidAt(x, y - 1, z)) { best = [x + 0.5, y + 3, z + 0.5]; break; }
      }
    }
    if (best) { p.x = best[0]; p.y = best[1]; p.z = best[2]; }
    return !!best; })()`, 2800);

  // 6. inventory
  await setup('06-inventory.png', `(() => { const g = window.__MINEWEB__; g.openInventory(); return true; })()`, 900);

  // 7. held item + block outline close-up on a wall of blocks
  await setup('07-held-item.png', `(() => { const g = window.__MINEWEB__; g.closeInventory(); g.uiMode = 'playing';
    const p = g.player; p.flying = true; p.pitch = 0.05; g.dayTime = 0.3;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    for (let i = 0; i < 8; i++) g.world.setBlockAt(x - 4, y + i - 2, z + 3, i % 2 ? 4 : 5);
    for (let i = 0; i < 8; i++) g.world.setBlockAt(x + 4 + i, y - 1, z + 3, [2,4,19,21,22,24,20,23][i]);
    p.y += 1; return true; })()`, 2600);

  // 8. debug overlay on
  await setup('08-debug.png', `(() => { const g = window.__MINEWEB__; g.hud.debugVisible = true;
    g.hud.debug.classList.remove('hidden'); g.hud.updateDebug(g.debugText()); return true; })()`, 700);

  console.log(JSON.stringify({ shots, logs: logs.slice(0, 12) }, null, 2));
  await send('Browser.close');
} finally {
  try { ws?.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
