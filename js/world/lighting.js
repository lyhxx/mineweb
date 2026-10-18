// world/lighting.js — sky light + block light flood fill.
//
// Lighting runs for one chunk at a time but reads a 3x3 chunk neighbourhood into a
// small scratch volume, so light crosses chunk borders correctly (cave mouths, torch
// light spilling out of a doorway, skylight falling past an overhang) without any
// deferred passes. The result is stored per chunk as two nibble-free byte arrays.
import { CX, CZ, WORLD_H } from './chunk.js';
import { LIGHT, OPAQUE, baseId } from '../core/blocks.js';

const MAXL = 15;
const EX = 48;                       // 3 x 16
const EVOL = EX * EX * WORLD_H;      // 98 304
const scratchSky = new Uint8Array(EVOL);
const scratchBlk = new Uint8Array(EVOL);
const scratchOpaque = new Uint8Array(EVOL);

// circular BFS queue (module level so lighting allocates nothing per call)
const QCAP = 1 << 18;
const QX = new Int16Array(QCAP), QY = new Int16Array(QCAP), QZ = new Int16Array(QCAP);
let qh = 0, qt = 0;
function qreset() { qh = 0; qt = 0; }
function qpush(x, y, z) {
  const n = (qt + 1) & (QCAP - 1);
  if (n === qh) return;             // queue saturated: drop (extremely unlikely)
  QX[qt] = x; QY[qt] = y; QZ[qt] = z; qt = n;
}

const ei = (x, y, z) => (y * EX + z) * EX + x;

export function lightChunk(chunk, world) {
  const cx0 = chunk.cx, cz0 = chunk.cz;
  // The Nether has no sky: skip the sky flood fill and keep the dim ambient level the
  // generator seeded, so lava and glowstone read as the real light sources.
  const ambientOnly = world.dimension === 'nether';

  scratchSky.fill(0);
  scratchBlk.fill(0);
  scratchOpaque.fill(0);

  // ---- gather the 3x3 neighbourhood
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = world.getChunkRaw(cx0 + dx, cz0 + dz);
      if (!n || !n.generated) continue;
      const bx = (dx + 1) * CX, bz = (dz + 1) * CZ;
      const nb = n.blocks;
      for (let y = 0; y < WORLD_H; y++) {
        const rowBase = y * CZ;
        const dstBase = (y * EX + bz) * EX + bx;
        for (let lz = 0; lz < CZ; lz++) {
          const src = (rowBase + lz) * CX;
          const dst = dstBase + lz * EX;
          for (let lx = 0; lx < CX; lx++) {
            const v = nb[src + lx];
            scratchOpaque[dst + lx] = OPAQUE[baseId(v)];
          }
        }
      }
    }
  }

  // ---- seed sky light: straight down, full strength until the first opaque block
  qreset();
  if (ambientOnly) {
    // uniform dim ambient everywhere, no flood fill
    scratchSky.fill(4);
  } else {
    for (let z = 0; z < EX; z++) {
      for (let x = 0; x < EX; x++) {
        let level = MAXL;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          const i = ei(x, y, z);
          if (scratchOpaque[i]) break;         // everything below is 0 by construction
          scratchSky[i] = level;
          if (level > 1) qpush(x, y, z);
        }
      }
    }
    propagate(scratchSky, scratchOpaque, false);
  }

  // ---- seed block light from emissive blocks then propagate
  qreset();
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = world.getChunkRaw(cx0 + dx, cz0 + dz);
      if (!n || !n.generated) continue;
      const bx = (dx + 1) * CX, bz = (dz + 1) * CZ;
      const nb = n.blocks;
      for (let y = 0; y < WORLD_H; y++) {
        for (let lz = 0; lz < CZ; lz++) {
          for (let lx = 0; lx < CX; lx++) {
            const em = LIGHT[baseId(nb[(y * CZ + lz) * CX + lx])];
            if (em === 0) continue;
            const i = ei(bx + lx, y, bz + lz);
            if (em > scratchBlk[i]) { scratchBlk[i] = em; qpush(bx + lx, y, bz + lz); }
          }
        }
      }
    }
  }
  propagate(scratchBlk, scratchOpaque, false);

  // ---- copy the centre chunk back out
  const sky = chunk.skyLight, blk = chunk.light;
  for (let y = 0; y < WORLD_H; y++) {
    for (let lz = 0; lz < CZ; lz++) {
      const src = (y * EX + (lz + CZ)) * EX + CX;
      const dst = (y * CZ + lz) * CX;
      for (let lx = 0; lx < CX; lx++) {
        sky[dst + lx] = scratchSky[src + lx];
        blk[dst + lx] = scratchBlk[src + lx];
      }
    }
  }

  chunk.lit = true;
  world.markNeighboursDirty(cx0, cz0);
}

function propagate(arr, opaque, _unused) {
  while (qh !== qt) {
    const x = QX[qh], y = QY[qh], z = QZ[qh];
    qh = (qh + 1) & (QCAP - 1);
    const level = arr[ei(x, y, z)];
    if (level <= 1) continue;
    const next = level - 1;
    for (let d = 0; d < 6; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      const nz = z + (d === 4 ? 1 : d === 5 ? -1 : 0);
      if (nx < 0 || nx >= EX || nz < 0 || nz >= EX || ny < 0 || ny >= WORLD_H) continue;
      const ni = ei(nx, ny, nz);
      if (opaque[ni]) continue;
      if (arr[ni] >= next) continue;
      arr[ni] = next;
      qpush(nx, ny, nz);
    }
  }
}

// ------------------------------------------------------------------ sampling helpers
/**
 * Combined light curve. Sky light is dimmed by the day cycle, block light is not.
 * Mirrors Minecraft's stepped falloff, but with a floor high enough that unlit faces
 * stay readable instead of collapsing to black.
 *
 * NOTE: callers must average RAW 0..15 levels first and apply this once. Averaging the
 * curve output instead produces a hard 1.0 -> 0.14 step between two adjacent samples,
 * which shows up as dark checkerboard bands along every block edge.
 */
export const LIGHT_FLOOR = 0.14;
export function lightCurve(sky, block) {
  const s = sky / MAXL, b = block / MAXL;
  const skyPart = s / (4 - 3 * s);
  const blockPart = b / (4 - 3 * b);
  const v = Math.max(skyPart, blockPart);
  return LIGHT_FLOOR + (1 - LIGHT_FLOOR) * v;
}

export function sampleLight(world, wx, wy, wz) {
  return lightCurve(sampleSky(world, wx, wy, wz), sampleBlockLight(world, wx, wy, wz));
}

/** Raw 0..15 sky level at a world position. */
export function sampleSky(world, wx, wy, wz) {
  return skyLevel(world, wx, wy, wz);
}

/** Raw 0..15 block-light level at a world position. */
export function sampleBlockLight(world, wx, wy, wz) {
  return blockLevel(world, wx, wy, wz);
}

/** Raw 0..15 sky level at a world position. */
export function skyLevel(world, wx, wy, wz) {
  if (wy >= WORLD_H) return MAXL;
  if (wy < 0) return 0;
  const cx = wx >> 4, cz = wz >> 4;
  const chunk = world.getChunkRaw(cx, cz);
  if (!chunk || !chunk.lit) return MAXL;
  return chunk.skyLight[(wy * CZ + (wz - cz * CZ)) * CX + (wx - cx * CX)];
}

/** Raw 0..15 block-light level at a world position. */
export function blockLevel(world, wx, wy, wz) {
  if (wy < 0 || wy >= WORLD_H) return 0;
  const cx = wx >> 4, cz = wz >> 4;
  const chunk = world.getChunkRaw(cx, cz);
  if (!chunk || !chunk.lit) return 0;
  return chunk.light[(wy * CZ + (wz - cz * CZ)) * CX + (wx - cx * CX)];
}
