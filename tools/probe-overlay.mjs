// tool: run a probe that opens a DOM overlay, then take a full-page screenshot so the
// overlay is composited into the image (readPixels only shows the WebGL canvas).
import fs from 'node:fs';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const PROBE = process.argv[3];
const OUT = process.argv[4] || 'shots/overlay.png';
const CHROME = 'C:\\Users\\11952\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333 + (process.pid % 200);

const { spawn } = await import('node:child_process');
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless=new', '--use-angle=d3d11', '--enable-gpu',
  '--window-size=1280,720', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + path.join(process.env.TEMP || '.', 'dsh-chrome-' + PORT),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params };
    pending.set(msg.id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('chrome devtools never came up');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(2500);

  // start a world: the title screen needs a click, and world creation is async
  const start = await send('Runtime.evaluate', {
    expression: `(() => {
      const w = window.__MINEWEB__;
      if (w && w.running) return 'already-running';
      const el = document.getElementById('title');
      const visible = el && !el.classList.contains('hidden');
      const btn = document.getElementById('btn-play') || document.querySelector('#title button');
      if (visible && btn) { btn.click(); return 'clicked'; }
      return visible ? 'title-visible-no-button' : 'no-title';
    })()`,
    returnByValue: true,
  });
  process.stderr.write('start: ' + JSON.stringify(start.result && start.result.value) + '\n');
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const st = await send('Runtime.evaluate', {
      expression: '(() => { const g = window.__MINEWEB__; return !!(g && g.running); })()',
      returnByValue: true,
    });
    if (st.result && st.result.value) break;
  }
  await sleep(1500);

  const src = fs.readFileSync(PROBE, 'utf8');
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${src} })()`,
    awaitPromise: true, returnByValue: true,
  });
  const value = r.result && r.result.value;
  await sleep(900);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  const info = value ? JSON.stringify(value).slice(0, 300) : 'no value';
  console.log(JSON.stringify({ saved: OUT, probe: info }));
} finally {
  try { if (ws) ws.close(); } catch { /* ignore */ }
  chrome.kill();
}
