// tools/probe-shot.mjs — run one probe file in Chrome and, if it returns {url}, save the
// data URL as a PNG so the rendered frame can be inspected directly.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const PROBE = process.argv[3];
const OUT = process.argv[4] || 'shots/probe.png';
const PORT = 9800 + Math.floor(Math.random() * 150);
const PROFILE = path.join(os.tmpdir(), 'mineweb-pshot-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((c) => c && fs.existsSync(c));

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
    return { value: r.result?.result?.value };
  };
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(2000);
  await evaluate('window.__MINEWEB__.startNewGame("probe-shot")');
  for (let i = 0; i < 120; i++) {
    const r = await evaluate('!!(window.__MINEWEB__.running && window.__MINEWEB__.player)');
    if (r.value) break;
    await sleep(300);
  }
  await sleep(1000);
  await evaluate(`(() => { const g = window.__MINEWEB__; g.settings.vsync = false; g.dpr = 1; g.resize(); return true; })()`);
  const res = await evaluate(fs.readFileSync(PROBE, 'utf8'));
  if (res.value?.url) {
    const b64 = res.value.url.split(',')[1];
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log(JSON.stringify({ saved: OUT, err: res.value.err }));
  } else {
    console.log(JSON.stringify(res, null, 2));
  }
  await send('Browser.close');
} finally {
  try { ws?.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
