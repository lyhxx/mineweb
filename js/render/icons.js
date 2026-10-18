// render/icons.js — draws isometric block icons for the hotbar / inventory into an
// offscreen canvas, then caches them as data URLs. No external image assets.
import { BLOCKS, TILE, ATLAS_SLOTS, RENDER, R } from '../core/blocks.js';
import { ATLAS_COLS, ATLAS_W, generateAtlasPixels, TILE_PX } from '../core/atlas.js';
import { ITEMS } from '../core/items.js';

let atlasCanvas = null;
let atlasCtx = null;
const iconCache = new Map();

function ensureAtlasCanvas() {
  if (atlasCanvas) return;
  const pixels = generateAtlasPixels();
  atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = ATLAS_W;
  atlasCanvas.height = ATLAS_W;
  atlasCtx = atlasCanvas.getContext('2d');
  const img = atlasCtx.createImageData(ATLAS_W, ATLAS_W);
  img.data.set(pixels);
  atlasCtx.putImageData(img, 0, 0);
}

export function atlasCanvasForTests() { ensureAtlasCanvas(); return atlasCanvas; }

/** Tile source rectangle inside the packed icon atlas. */
function tileRect(tileIndex) {
  const tx = tileIndex % ATLAS_COLS, ty = (tileIndex / ATLAS_COLS) | 0;
  return [tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX];
}

/**
 * Draw an isometric block icon: top diamond + two shaded side faces.
 * size is the full icon width in device pixels.
 */
function drawIsoBlock(ctx, id, size) {
  const s = size / 2;                  // half width
  const th = s * 0.5;                  // top face height
  const bh = s * 0.72;                 // side face height
  const uvTop = tileRect(TILE[id * ATLAS_SLOTS + 4]);
  const uvLeft = tileRect(TILE[id * ATLAS_SLOTS + 2]);
  const uvRight = tileRect(TILE[id * ATLAS_SLOTS + 3]);

  // ---- top face (diamond), drawn as a transformed square
  ctx.save();
  ctx.translate(size / 2, th);
  ctx.transform(1, 0.5, -1, 0.5, 0, 0);
  ctx.globalAlpha = 1;
  ctx.drawImage(atlasCanvas, uvTop[0], uvTop[1], TILE_PX, TILE_PX, 0, 0, s, s);
  ctx.restore();
  // brighten the top face slightly
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.restore();

  // ---- left face
  ctx.save();
  ctx.translate(size / 2 - s, th);
  ctx.transform(1, 0.5, 0, 1, 0, 0);
  ctx.globalAlpha = 0.82;
  ctx.drawImage(atlasCanvas, uvLeft[0], uvLeft[1], TILE_PX, TILE_PX, 0, 0, s, bh);
  ctx.restore();

  // ---- right face
  ctx.save();
  ctx.translate(size / 2, th + s * 0.5);
  ctx.transform(1, -0.5, 0, 1, 0, 0);
  ctx.globalAlpha = 0.66;
  ctx.drawImage(atlasCanvas, uvRight[0], uvRight[1], TILE_PX, TILE_PX, 0, 0, s, bh);
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Return a data URL for the given block id (cached). */
export function blockIcon(id, size = 48) {
  if (!id || !BLOCKS[id]) return null;
  const key = id + ':' + size;
  if (iconCache.has(key)) return iconCache.get(key);
  ensureAtlasCanvas();
  const render = RENDER[id];
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (render === R.PLANT || render === R.TORCH) {
    // flat sprite for plants and torches
    const rect = tileRect(TILE[id * ATLAS_SLOTS]);
    const scale = Math.min(size / TILE_PX, size / TILE_PX);
    ctx.drawImage(atlasCanvas, rect[0], rect[1], TILE_PX, TILE_PX, 0, 0, 16 * scale, 16 * scale);
  } else {
    drawIsoBlock(ctx, id, size);
  }
  const url = c.toDataURL();
  iconCache.set(key, url);
  return url;
}

/** Cache-busting-free sprite sheet of every block, used by the creative palette. */
export function allBlockIcons(size = 48) {
  const out = {};
  for (let id = 1; id < BLOCKS.length; id++) {
    if (!BLOCKS[id]) continue;
    out[id] = blockIcon(id, size);
  }
  return out;
}

// ------------------------------------------------------------------ item icons
// Items have no atlas tile, so their icons are drawn from the shape family + colours
// declared in core/items.js. Same cache namespace as blocks (item ids are negative, so
// they can never collide with a block id).
function rgb(c) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}
function shadeCss(c, f) {
  return rgb([Math.min(1, c[0] * f), Math.min(1, c[1] * f), Math.min(1, c[2] * f)]);
}

/** Draw a 16x16 pixel-art item into a `size` box using nearest-neighbour blocks. */
function drawItemIcon(ctx, it, size) {
  const s = size / 16;
  const C = it.color;
  const C2 = it.color2 || [0.45, 0.32, 0.16];
  const dark = shadeCss(C, 0.6);
  const light = shadeCss(C, 1.25);
  const put = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x * s, y * s, w * s, h * s); };
  switch (it.icon) {
    case 'stick':
      put(5, 3, 2, 10, rgb(C));
      put(4, 5, 1, 8, shadeCss(C, 0.75));
      put(7, 4, 1, 9, light);
      break;
    case 'ingot':
      put(4, 6, 8, 5, rgb(C));
      put(4, 6, 8, 1, light);
      put(4, 10, 8, 1, dark);
      put(3, 7, 1, 3, dark);
      put(12, 7, 1, 3, dark);
      break;
    case 'gem':
      put(6, 3, 4, 2, light);
      put(5, 5, 6, 3, rgb(C));
      put(6, 8, 4, 3, rgb(C));
      put(7, 11, 2, 1, dark);
      put(5, 5, 1, 3, dark);
      put(10, 5, 1, 3, light);
      break;
    case 'lump':
      put(5, 5, 6, 6, rgb(C));
      put(6, 4, 4, 1, light);
      put(4, 6, 1, 4, dark);
      put(11, 6, 1, 4, dark);
      put(5, 11, 6, 1, dark);
      break;
    case 'apple':
      put(4, 5, 8, 8, rgb(C));
      put(5, 4, 6, 1, light);
      put(4, 12, 8, 1, dark);
      put(7, 2, 1, 3, rgb(C2));
      put(8, 3, 3, 2, rgb(C2));
      put(6, 6, 2, 2, light);
      break;
    case 'bread':
      put(3, 5, 10, 7, rgb(C));
      put(4, 4, 8, 1, light);
      put(3, 11, 10, 1, dark);
      put(5, 6, 1, 1, light); put(8, 7, 1, 1, light); put(10, 6, 1, 1, light);
      break;
    case 'meat':
      put(4, 5, 8, 7, rgb(C));
      put(5, 4, 6, 1, light);
      put(6, 7, 4, 3, light);
      put(4, 11, 8, 1, dark);
      put(3, 6, 1, 4, dark);
      break;
    case 'pickaxe':
      put(3, 3, 10, 2, rgb(C));
      put(2, 4, 2, 2, rgb(C));
      put(12, 4, 2, 2, rgb(C));
      put(3, 3, 10, 1, light);
      put(7, 5, 2, 2, rgb(C2));
      put(6, 7, 2, 2, rgb(C2));
      put(5, 9, 2, 2, rgb(C2));
      put(4, 11, 2, 2, rgb(C2));
      break;
    case 'axe':
      put(6, 2, 5, 6, rgb(C));
      put(6, 2, 5, 1, light);
      put(11, 3, 1, 4, dark);
      put(5, 4, 1, 3, dark);
      put(7, 8, 2, 2, rgb(C2));
      put(6, 10, 2, 2, rgb(C2));
      put(5, 12, 2, 2, rgb(C2));
      break;
    case 'shovel':
      put(5, 2, 6, 5, rgb(C));
      put(5, 2, 6, 1, light);
      put(5, 6, 6, 1, dark);
      put(7, 7, 2, 2, rgb(C2));
      put(6, 9, 2, 2, rgb(C2));
      put(5, 11, 2, 2, rgb(C2));
      break;
    case 'sword':
      put(7, 2, 2, 9, rgb(C));
      put(6, 3, 1, 8, dark);
      put(9, 2, 1, 8, light);
      put(5, 10, 6, 2, rgb(C2));
      put(6, 12, 4, 1, shadeCss(C2, 0.7));
      put(7, 1, 2, 1, light);
      break;
    case 'hoe':
      put(4, 3, 8, 2, rgb(C));
      put(4, 3, 8, 1, light);
      put(4, 5, 2, 2, rgb(C));
      put(7, 5, 2, 2, rgb(C2));
      put(6, 7, 2, 2, rgb(C2));
      put(5, 9, 2, 2, rgb(C2));
      put(4, 11, 2, 2, rgb(C2));
      break;
    case 'arrow':
      // shaft with a flint head and feather fletching
      put(7, 4, 2, 9, rgb(C));
      put(7, 3, 2, 2, rgb(C2));
      put(6, 2, 4, 2, rgb(C2));
      put(6, 12, 1, 2, rgb([0.92, 0.92, 0.92]));
      put(9, 12, 1, 2, rgb([0.92, 0.92, 0.92]));
      put(7, 1, 2, 1, rgb(C2));
      break;
    case 'bow':
      // curved limbs with a string down the left
      put(9, 2, 2, 2, rgb(C));
      put(10, 4, 2, 2, rgb(C));
      put(11, 6, 2, 4, rgb(C));
      put(10, 10, 2, 2, rgb(C));
      put(9, 12, 2, 2, rgb(C));
      put(8, 3, 1, 10, rgb(C2));
      put(9, 2, 1, 1, rgb(C2));
      put(9, 13, 1, 1, rgb(C2));
      break;
    case 'helmet':
      put(4, 4, 8, 5, rgb(C));
      put(4, 9, 2, 3, rgb(C));
      put(10, 9, 2, 3, rgb(C));
      put(4, 4, 8, 1, light);
      put(6, 6, 4, 3, dark);          // visor
      break;
    case 'chestplate':
      put(4, 4, 8, 8, rgb(C));
      put(2, 5, 2, 5, rgb(C));        // arms
      put(12, 5, 2, 5, rgb(C));
      put(4, 4, 8, 1, light);
      put(7, 5, 2, 6, dark);
      break;
    case 'leggings':
      put(4, 3, 8, 5, rgb(C));
      put(4, 8, 3, 6, rgb(C));
      put(9, 8, 3, 6, rgb(C));
      put(4, 3, 8, 1, light);
      put(7, 3, 2, 5, dark);
      break;
    case 'boots':
      put(3, 8, 4, 5, rgb(C));
      put(9, 8, 4, 5, rgb(C));
      put(3, 12, 5, 2, dark);
      put(9, 12, 5, 2, dark);
      put(3, 8, 4, 1, light);
      put(9, 8, 4, 1, light);
      break;
    case 'string':
      put(5, 3, 6, 2, rgb(C));
      put(4, 5, 2, 6, rgb(C));
      put(10, 5, 2, 6, rgb(C));
      put(5, 11, 6, 2, rgb(C));
      put(6, 6, 1, 4, shadeCss(C, 0.75));
      put(9, 6, 1, 4, light);
      break;
    case 'seeds':
      // a few scattered green grains
      put(5, 6, 2, 2, rgb(C));
      put(8, 5, 2, 2, shadeCss(C, 1.2));
      put(6, 9, 2, 2, shadeCss(C, 0.85));
      put(9, 8, 2, 2, rgb(C));
      put(4, 10, 2, 2, shadeCss(C, 0.7));
      put(10, 11, 2, 2, shadeCss(C, 0.8));
      break;
    case 'paper':
      put(3, 4, 10, 9, rgb(C));
      put(3, 4, 10, 1, shadeCss(C, 1.06));
      put(3, 12, 10, 1, shadeCss(C, 0.82));
      put(5, 6, 6, 1, shadeCss(C, 0.7));
      put(5, 8, 6, 1, shadeCss(C, 0.7));
      put(5, 10, 4, 1, shadeCss(C, 0.7));
      break;
    case 'book':
      put(3, 3, 10, 10, rgb(C));
      put(3, 3, 2, 10, shadeCss(C, 0.7));
      put(5, 4, 7, 8, rgb(C2));
      put(5, 4, 7, 1, shadeCss(C2, 0.9));
      put(7, 4, 1, 8, shadeCss(C, 0.85));
      break;
    case 'bottle':
      // an empty glass bottle: outline with a highlight
      put(6, 1, 4, 2, rgb(C));
      put(7, 3, 2, 3, rgb(C));
      put(5, 6, 6, 8, rgb(C));
      put(5, 6, 6, 1, shadeCss(C, 1.15));
      put(5, 13, 6, 1, shadeCss(C, 0.75));
      put(6, 7, 1, 6, shadeCss(C, 1.2));
      put(9, 8, 1, 4, shadeCss(C, 0.8));
      break;
    case 'bottle_filled':
      put(6, 1, 4, 2, shadeCss(C, 0.7));
      put(7, 3, 2, 3, shadeCss(C, 0.7));
      put(5, 6, 6, 8, rgb(C));
      put(5, 6, 6, 1, shadeCss(C, 1.3));
      put(5, 13, 6, 1, shadeCss(C, 0.7));
      put(6, 7, 1, 5, shadeCss(C, 1.35));
      put(11, 1, 2, 2, shadeCss(C, 0.85));
      break;
    case 'wart':
      put(5, 4, 6, 8, rgb(C));
      put(6, 3, 4, 1, shadeCss(C, 1.2));
      put(4, 6, 1, 4, shadeCss(C, 0.8));
      put(11, 6, 1, 4, shadeCss(C, 0.8));
      put(6, 6, 2, 2, shadeCss(C, 1.3));
      put(8, 9, 2, 2, shadeCss(C, 1.15));
      break;
    case 'powder':
      for (let i = 0; i < 8; i++) {
        const x = 3 + ((i * 3) % 10), y = 4 + ((i * 5) % 9);
        put(x, y, 2, 2, i % 2 ? rgb(C) : shadeCss(C, 1.2));
      }
      put(5, 11, 3, 2, shadeCss(C, 0.85));
      put(9, 6, 2, 2, shadeCss(C, 0.9));
      break;
    case 'tear':
      put(7, 2, 2, 2, rgb(C));
      put(6, 4, 4, 4, rgb(C));
      put(5, 8, 6, 3, rgb(C));
      put(6, 11, 4, 2, shadeCss(C, 0.85));
      put(7, 4, 1, 6, shadeCss(C, 1.25));
      break;
    case 'melon':
      put(2, 3, 12, 10, rgb(C));
      put(2, 3, 12, 1, shadeCss(C, 1.2));
      put(2, 12, 12, 1, shadeCss(C, 0.78));
      put(7, 4, 1, 8, shadeCss(C, 0.85));
      put(4, 6, 1, 4, shadeCss(C, 1.1));
      put(11, 7, 1, 4, shadeCss(C, 0.9));
      if (C2) { put(8, 5, 3, 3, rgb(C2)); put(5, 9, 2, 2, rgb(C2)); }
      break;
    case 'carrot':
      put(6, 3, 4, 2, rgb(C));
      put(6, 5, 4, 8, rgb(C));
      put(7, 5, 1, 7, shadeCss(C, 1.25));
      put(6, 12, 4, 1, shadeCss(C, 0.75));
      if (C2) { put(4, 1, 3, 3, rgb(C2)); put(9, 1, 3, 2, rgb(C2)); }
      break;
    case 'fish':
      put(2, 5, 10, 6, rgb(C));
      put(2, 5, 10, 1, shadeCss(C, 1.2));
      put(2, 10, 10, 1, shadeCss(C, 0.8));
      put(11, 4, 3, 3, shadeCss(C, 0.85));   // tail
      put(11, 9, 3, 3, shadeCss(C, 0.85));
      put(4, 6, 2, 2, rgb([0.15, 0.12, 0.10]));  // eye
      break;
    case 'eye':
      put(3, 4, 10, 8, rgb(C));
      put(3, 4, 10, 1, shadeCss(C, 1.2));
      put(3, 11, 10, 1, shadeCss(C, 0.78));
      put(6, 6, 4, 4, rgb([0.92, 0.90, 0.85]));
      put(7, 7, 2, 2, rgb([0.12, 0.10, 0.14]));
      break;
    case 'nugget':
      put(6, 7, 4, 3, rgb(C));
      put(6, 7, 4, 1, shadeCss(C, 1.25));
      put(6, 9, 4, 1, shadeCss(C, 0.75));
      put(5, 8, 1, 1, shadeCss(C, 0.85));
      put(10, 8, 1, 1, shadeCss(C, 0.85));
      break;
    case 'hopper':
      put(2, 3, 12, 5, rgb(C));
      put(2, 3, 12, 1, shadeCss(C, 1.25));
      put(5, 8, 6, 3, rgb(C));
      put(6, 11, 4, 3, shadeCss(C, 0.8));
      put(3, 4, 10, 3, shadeCss(C, 0.6));
      break;
    case 'repeater':
      put(2, 5, 12, 6, rgb(C));
      put(2, 5, 12, 1, shadeCss(C, 1.2));
      put(2, 10, 12, 1, shadeCss(C, 0.75));
      put(3, 7, 10, 2, rgb(C2));
      put(3, 2, 2, 3, rgb(C2));
      put(11, 2, 2, 3, rgb(C2));
      put(3, 1, 2, 1, shadeCss(C2, 1.3));
      put(11, 1, 2, 1, shadeCss(C2, 1.3));
      break;
    case 'piston':
      put(2, 3, 12, 10, rgb(C));
      put(2, 3, 12, 1, shadeCss(C, 1.2));
      put(2, 12, 12, 1, shadeCss(C, 0.76));
      put(4, 5, 8, 6, rgb(C2));
      put(4, 5, 8, 1, shadeCss(C2, 1.15));
      put(6, 0, 4, 3, shadeCss(C, 1.35));   // the arm
      break;
    case 'rod':
      put(7, 2, 2, 12, rgb(C));
      put(7, 2, 1, 12, shadeCss(C, 1.25));
      put(9, 3, 1, 10, shadeCss(C, 0.75));
      put(6, 4, 1, 2, shadeCss(C, 1.1));
      put(6, 9, 1, 2, shadeCss(C, 1.1));
      break;
    case 'flint_steel':
      // a steel striker with a flint edge
      put(3, 8, 9, 4, rgb(C));
      put(3, 8, 9, 1, shadeCss(C, 1.2));
      put(3, 11, 9, 1, shadeCss(C, 0.7));
      put(10, 4, 3, 5, rgb(C2));
      put(10, 4, 3, 1, shadeCss(C2, 1.3));
      put(4, 3, 6, 2, shadeCss(C2, 0.9));
      break;
    case 'wheat':
      // a bundle of golden stalks
      for (const x of [4, 7, 10]) {
        put(x, 3, 2, 10, rgb(C));
        put(x, 3, 1, 10, shadeCss(C, 1.2));
        put(x + 2, 5, 1, 2, shadeCss(C, 0.7));
        put(x + 2, 8, 1, 2, shadeCss(C, 0.7));
        put(x + 2, 11, 1, 2, shadeCss(C, 0.7));
      }
      put(3, 12, 10, 2, shadeCss(C, 0.6));
      break;
    default:
      put(5, 5, 6, 6, rgb(C));
      put(4, 7, 1, 2, dark);
      put(11, 7, 1, 2, dark);
  }
}

/** Icon for any stack id: positive ids render as blocks, negative ids as items. */
export function stackIcon(id, size = 48) {
  if (!id) return null;
  if (id > 0) return blockIcon(id, size);
  const it = ITEMS[-id];
  if (!it) return null;
  const key = 'item:' + id + ':' + size;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawItemIcon(ctx, it, size);
  const url = c.toDataURL();
  iconCache.set(key, url);
  return url;
}
