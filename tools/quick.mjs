// tools/quick.mjs — small focused CDP probe used while iterating: loads the page,
// starts a world, then evaluates the JS file given as argv[3] inside the page.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const SCRIPT_FILE = process.argv[3];
const SCRIPT = SCRIPT_FILE ? fs.readFileSync(SCRIPT_FILE, 'utf8') : 'null';
const PORT = 9700 + Math.floor(Math.random() * 200);
const PROFILE = path.join(os.tmpdir(), 'mineweb-quick-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const chrome = CANDIDATES.find((c) => c && fs.existsSync(c));
if (!chrome) throw new Error('chrome not found');

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
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
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
      const desc = d?.exception?.description || d?.text || 'exception';
      const where = d?.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : '';
      logs.push((desc.split('\n').slice(0, 3).join(' | ')) + (where ? ' @ ' + where : ''));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
    if (r.error) return { error: r.error.message };
    return { value: r.result?.result?.value };
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(2000);
  await evaluate('window.__MINEWEB__.startNewGame("quick-probe")');
  for (let i = 0; i < 120; i++) {
    const r = await evaluate('!!(window.__MINEWEB__.running && window.__MINEWEB__.player)');
    if (r.value) break;
    await sleep(300);
  }
  await sleep(1200);
  const out = await evaluate(SCRIPT);
  console.log(JSON.stringify({ result: out, logs: logs.slice(0, 10) }, null, 2));
  await send('Browser.close');
} finally {
  try { ws?.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
