// tools/bench.mjs — drives real Chrome over the DevTools Protocol to
//   1. load MineWeb,
//   2. start a world,
//   3. measure sustained FPS (average, 1% low, p99 frame time),
//   4. capture screenshots,
// and print a JSON report. No npm dependencies: Chrome is launched directly and we speak
// CDP over the built-in WebSocket client.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const OUT_DIR = process.argv[3] || path.join(process.cwd(), 'shots');
const SECONDS = Number(process.argv[4] || 12);
const PORT = 9223 + Math.floor(Math.random() * 200);
const PROFILE = path.join(os.tmpdir(), 'mineweb-bench-' + process.pid);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ }
  }
  throw new Error('Chrome/Edge not found; set CHROME_PATH');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up: ' + url);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
    });
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = cdp.handlers.get(msg.method);
        if (list) for (const h of list) h(msg.params);
      }
    });
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 60000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: false,
    });
    if (res.exceptionDetails) {
      throw new Error('page eval failed: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }

  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }
}

async function main() {
  const chrome = findChrome();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,900',
    '--window-position=0,0',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const child = spawn(chrome, args, { stdio: 'ignore', detached: false });
  const report = { url: URL_ARG, chrome, port: PORT };
  let cdp;
  try {
    const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find((t) => t.type === 'page') || list[0];
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

    const consoleErrors = [];
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') consoleErrors.push(p.entry.text);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception');
    });

    await cdp.send('Page.navigate', { url: URL_ARG });
    await sleep(2500);

    report.title = await cdp.evaluate('document.title');
    report.canvasOk = await cdp.evaluate('!!document.getElementById("game")');
    report.boot = await cdp.evaluate(`(() => ({
      hasGame: !!window.__MINEWEB__,
      fatalVisible: !document.getElementById('fatal').classList.contains('hidden'),
      fatalText: document.getElementById('fatal-text').textContent.slice(0, 4000),
      hasWebGL2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return 'throw:' + e.message; } })(),
    }))()`);
    if (!report.boot.hasGame) {
      report.consoleErrors = consoleErrors;
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Start a game with a fixed seed so runs are comparable.
    console.error('[bench] starting world…');
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; if (!g) return false;
      document.getElementById('seed-input').value = 'mineweb-bench';
      return true; })()`);
    await cdp.evaluate('window.__MINEWEB__.startNewGame("mineweb-bench")');
    // wait for the loading overlay to disappear
    let readyMs = 0;
    for (let i = 0; i < 180; i++) {
      const ready = await cdp.evaluate('(() => { const g = window.__MINEWEB__; return !!(g && g.running && g.uiMode === "playing" && g.player && g.player.inventory); })()');
      if (ready) break;
      readyMs += 500;
      await sleep(500);
    }
    console.error('[bench] world ready after', readyMs, 'ms');
    report.started = await cdp.evaluate('!!(window.__MINEWEB__.running && window.__MINEWEB__.player)');
    if (!report.started) {
      report.loadingState = await cdp.evaluate(`(() => { const g = window.__MINEWEB__; return {
        running: g.running, uiMode: g.uiMode, hasWorld: !!g.world,
        chunks: g.world ? g.world.chunks.size : -1,
        fatal: document.getElementById('fatal-text').textContent.slice(0, 2000),
      }; })()`);
      report.consoleErrors = consoleErrors;
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    await sleep(2000);

    // FPS sampling inside the page: count real frames over a window.
    const sample = await cdp.evaluate(`new Promise((resolve) => {
      const times = [];
      let last = performance.now();
      const start = last;
      function tick(now) {
        times.push(now - last);
        last = now;
        if (now - start < ${SECONDS * 1000}) requestAnimationFrame(tick);
        else {
          const sorted = times.slice(1).sort((a, b) => a - b);
          const n = sorted.length;
          const mean = sorted.reduce((a, b) => a + b, 0) / n;
          const p99 = sorted[Math.floor(n * 0.99)];
          const p50 = sorted[Math.floor(n * 0.5)];
          const worst = sorted[n - 1];
          resolve({
            frames: n,
            seconds: (now - start) / 1000,
            avgFps: 1000 / mean,
            medianFrameMs: p50,
            fps1pctLow: 1000 / p99,
            worstFrameMs: worst,
            p99FrameMs: p99,
          });
        }
      }
      requestAnimationFrame(tick);
    })`);
    report.sample = sample;

    report.engine = await cdp.evaluate(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
      return {
        seed: w.seed,
        chunks: w.chunks.size,
        viewDistance: w.viewDistance,
        mobs: g.mobs.length,
        items: g.items.length,
        playerPos: [p.x, p.y, p.z],
        biome: w.biomeNameAt(Math.floor(p.x), Math.floor(p.z)),
        drawCalls: g.renderer.stats.draws,
        quads: g.renderer.stats.quads,
        culled: g.renderer.stats.culled,
        glRenderer: (() => { const gl = g.renderer.gl; const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })(),
        worldMemoryMB: Number(w.estimateMemoryMB().toFixed(2)),
      }; })()`);

    report.shots = [];
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '01-ground.png')));

    // fly up for an aerial shot
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; const p = g.player;
      p.mode = 'creative'; p.flying = true; p.y += 34; p.pitch = -0.42; return true; })()`);
    await sleep(1600);
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '02-aerial.png')));

    // night + a torch-lit view
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; g.dayTime = 0.75; g.player.y -= 30; g.player.pitch = 0.05; return true; })()`);
    await sleep(1500);
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '03-night.png')));

    // under water / cave-ish: dig down a few blocks
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; const p = g.player;
      g.dayTime = 0.28; p.y -= 6; p.pitch = 0.2; const x = Math.floor(p.x), z = Math.floor(p.z);
      for (let y = Math.floor(p.y) - 2; y < Math.floor(p.y) + 3; y++)
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) g.world.setBlockAt(x + dx, y, z + dz, 0);
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) g.world.setBlockAt(x + dx, Math.floor(p.y) + 3, z + dz, 30);
      return true; })()`);
    await sleep(1800);
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '04-cave-torch.png')));

    // walk test: run forward and measure FPS while the world streams new chunks
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; g.hud.hidePause(); g.uiMode = 'playing';
      const p = g.player; p.mode = 'survival'; p.flying = false; p.pitch = 0;
      p.health = 20; p.hunger = 20;
      window.__walkStart = [p.x, p.z]; return true; })()`);
    await sleep(300);
    await cdp.evaluate(`(() => { const g = window.__MINEWEB__; g.input.keys.add('KeyW'); return true; })()`);
    await sleep(3000);
    const streamSample = await cdp.evaluate(`new Promise((resolve) => {
      const times = []; let last = performance.now(); const start = last;
      function tick(now) { times.push(now - last); last = now;
        if (now - start < 4000) requestAnimationFrame(tick);
        else { const s = times.slice(1).sort((a,b)=>a-b); const mean = s.reduce((a,b)=>a+b,0)/s.length;
          resolve({ avgFps: 1000/mean, fps1pctLow: 1000/s[Math.floor(s.length*0.99)], frames: s.length }); } }
      requestAnimationFrame(tick); })`);
    await cdp.evaluate(`(() => { window.__MINEWEB__.input.keys.delete('KeyW'); return true; })()`);
    report.streaming = streamSample;
    report.walked = await cdp.evaluate(`(() => { const g = window.__MINEWEB__;
      const [x0, z0] = window.__walkStart;
      return Number(Math.hypot(g.player.x - x0, g.player.z - z0).toFixed(2)); })()`);
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '05-walking.png')));

    // inventory screen
    await cdp.evaluate('window.__MINEWEB__.openInventory()');
    await sleep(700);
    report.shots.push(await cdp.screenshot(path.join(OUT_DIR, '06-inventory.png')));
    report.inventorySlots = await cdp.evaluate('document.querySelectorAll("#inventory .slot").length');
    await cdp.evaluate('window.__MINEWEB__.closeInventory()');

    report.consoleErrors = consoleErrors.slice(0, 20);
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) { /* ignore */ }
    try { child.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.error('[bench] sampling fps…');
  console.log(JSON.stringify(report, null, 2));
  if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
