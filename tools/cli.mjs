#!/usr/bin/env node
// tools/cli.mjs — one entry point for the project's tooling.
//
//   node tools/cli.mjs serve   [port]        static server for playing locally
//   node tools/cli.mjs bench   [port] [secs] real-browser frame-time measurement
//   node tools/cli.mjs verify  [port]        end-to-end checks in a real browser
//   node tools/cli.mjs shots   [port] [dir]  the standard screenshot set
//   node tools/cli.mjs net     [port]        multiplayer protocol self-test
//   node tools/cli.mjs info                  what is in this checkout
//
// Everything is zero-dependency and runs on plain Node.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const [cmd, ...rest] = process.argv.slice(2);

const run = (script, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
    stdio: 'inherit', cwd: ROOT,
  });
  child.on('exit', (code) => resolve(code ?? 0));
});

function countLines(rel) {
  try {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    return buf.toString('utf8').split('\n').length;
  } catch (e) { return 0; }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const USAGE = `MineWeb tools

  serve   [port]           start the local server (default 8137)
  bench   [port] [secs]    measure real frame times in Chrome
  verify  [port]           run the end-to-end checks
  shots   [port] [dir]     capture the standard screenshots
  net     [port]           multiplayer protocol self-test
  info                     summarise the checkout
`;

switch (cmd) {
  case 'serve': {
    process.exitCode = await run('serve.mjs', [rest[0] || '8137']);
    break;
  }
  case 'bench': {
    const port = rest[0] || '8137';
    process.exitCode = await run('bench.mjs', [`http://127.0.0.1:${port}/`, 'shots', rest[1] || '10']);
    break;
  }
  case 'verify': {
    process.exitCode = await run('verify.mjs', [`http://127.0.0.1:${rest[0] || '8137'}/`]);
    break;
  }
  case 'shots': {
    process.exitCode = await run('shot.mjs', [`http://127.0.0.1:${rest[0] || '8137'}/`, rest[1] || 'shots']);
    break;
  }
  case 'net': {
    process.exitCode = await run('net-test.mjs', [rest[0] || '8137']);
    break;
  }
  case 'info': {
    const js = walk('js');
    const total = js.reduce((n, f) => n + countLines(f), 0);
    const tools = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs'));
    console.log(`MineWeb checkout: ${ROOT}`);
    console.log(`  modules : ${js.length} files, ${total} lines under js/`);
    console.log(`  tools   : ${tools.length} scripts in tools/`);
    console.log(`  shots   : ${(fs.existsSync(path.join(ROOT, 'shots')) ? fs.readdirSync(path.join(ROOT, 'shots')).length : 0)} files`);
    console.log(`  reports : ${(fs.existsSync(path.join(ROOT, 'reports')) ? fs.readdirSync(path.join(ROOT, 'reports')).join(', ') : 'none')}`);
    break;
  }
  default:
    process.stdout.write(USAGE);
    process.exitCode = cmd ? 1 : 0;
}
