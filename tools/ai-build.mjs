#!/usr/bin/env node
// tools/ai-build.mjs — turn a natural-language request into a MineWeb blueprint.
//
// The game itself never talks to a network service: /paste accepts a blueprint URL, and
// this script is the optional bridge that produces one. That keeps the repo free of keys
// and keeps the game playable offline.
//
// Usage:
//   MINEBUILD_ENDPOINT=https://... MINEBUILD_KEY=... \
//   node tools/ai-build.mjs "a 7x7 stone watchtower with a ladder" out.json
//
// Without an endpoint it prints the prompt it would send and a hand-written example
// blueprint, which is enough to test /paste end to end.
//
// The endpoint is expected to speak the OpenAI-compatible chat-completions shape and to
// return the blueprint JSON as the message content. Any provider that does can be used.

import fs from 'node:fs';

const BLUEPRINT_SPEC = `You output ONLY JSON, no prose, matching this schema exactly:
{
  "name": string,
  "size": [x, y, z],
  "palette": { "<single char>": "<block key>", ".": "air" },
  "layers": [ [ "<row of x chars>", ... z rows ... ], ... y layers ... ]
}
Rules:
- layers are listed bottom-up; rows inside a layer run along +Z; characters along +X
- every row must be exactly size[0] characters and every layer exactly size[2] rows
- block keys are MineWeb keys such as: stone, cobblestone, planks, log, glass, torch,
  sand, dirt, grass, brick, leaves, water, lava, obsidian, iron_block, gold_block,
  wool_white, wool_red, ladder, cobblestone_wall
- keep it under 24x24x24 so it can be pasted in one command`;

/** A tiny hand-authored blueprint so the script is useful without any endpoint. */
const EXAMPLE = {
  name: 'watchtower',
  size: [3, 6, 3],
  palette: { '.': 'air', S: 'cobblestone', P: 'planks', T: 'torch' },
  layers: [
    ['SSS', 'SSS', 'SSS'],
    ['S.S', 'S.S', 'S.S'],
    ['S.S', 'S.S', 'S.S'],
    ['S.S', 'S.S', 'S.S'],
    ['PPP', 'P.P', 'PPP'],
    ['T.T', '.T.', 'T.T'],
  ],
};

function validate(bp) {
  const problems = [];
  if (!bp || typeof bp !== 'object') return ['not an object'];
  if (!Array.isArray(bp.size) || bp.size.length !== 3) problems.push('size must be [x,y,z]');
  if (!bp.palette || typeof bp.palette !== 'object') problems.push('missing palette');
  if (!Array.isArray(bp.layers)) problems.push('missing layers');
  if (problems.length) return problems;
  const [sx, sy, sz] = bp.size;
  if (bp.layers.length !== sy) problems.push(`expected ${sy} layers, got ${bp.layers.length}`);
  for (let y = 0; y < bp.layers.length; y++) {
    const rows = bp.layers[y];
    if (rows.length !== sz) problems.push(`layer ${y}: expected ${sz} rows, got ${rows.length}`);
    for (let z = 0; z < rows.length; z++) {
      if (typeof rows[z] !== 'string') { problems.push(`layer ${y} row ${z} is not a string`); continue; }
      if (rows[z].length !== sx) problems.push(`layer ${y} row ${z}: expected ${sx} chars, got ${rows[z].length}`);
    }
  }
  return problems;
}

const request = process.argv[2];
const outPath = process.argv[3];
if (!request) {
  console.error('usage: node tools/ai-build.mjs "<description>" [out.json]');
  process.exit(1);
}

const endpoint = process.env.MINEBUILD_ENDPOINT;
const key = process.env.MINEBUILD_KEY;
const model = process.env.MINEBUILD_MODEL || 'gpt-4o-mini';

let blueprint = null;
if (endpoint) {
  const body = {
    model,
    messages: [
      { role: 'system', content: BLUEPRINT_SPEC },
      { role: 'user', content: request },
    ],
    temperature: 0.4,
  };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  // tolerate markdown fences around the JSON
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error('the model did not return JSON');
    process.exit(1);
  }
  blueprint = JSON.parse(match[0]);
  const problems = validate(blueprint);
  if (problems.length) {
    console.error('blueprint failed validation:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
} else {
  // No endpoint configured: emit the example so /paste can still be exercised.
  blueprint = EXAMPLE;
  const problems = validate(blueprint);
  if (problems.length) {
    console.error('built-in example is invalid: ' + problems.join('; '));
    process.exit(1);
  }
  console.error('MINEBUILD_ENDPOINT is not set — writing the built-in example.');
  console.error('Prompt that would be sent:\n' + BLUEPRINT_SPEC + '\n\nUser: ' + request + '\n');
}

const json = JSON.stringify(blueprint, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, json);
  console.error(`wrote ${outPath} (${blueprint.name}, ${blueprint.size.join('x')})`);
} else {
  process.stdout.write(json + '\n');
}
