// world/mesher.js — turns a chunk's voxels into GPU-ready vertex arrays.
//
// Per face we emit a quad carrying: position, atlas UV, baked smooth light (average of
// the four surrounding light samples), ambient occlusion and a face-shade term. A face
// is only emitted when the neighbour would not already hide it, which is what keeps a
// densely built world cheap to draw.
import {
  TILE, ATLAS_SLOTS, OPAQUE, LIQUID, RENDER, R, baseId, idOf, BLOCKS,
} from '../core/blocks.js';
import { tileUV } from '../core/atlas.js';
import { CX, CZ, WORLD_H } from './chunk.js';
import { sampleSky, sampleBlockLight, lightCurve } from './lighting.js';

// vertex layout: x,y,z,u,v,light,ao,shade,layer  (9 floats = 36 bytes)
// The block texture is a WebGL2 TEXTURE_2D_ARRAY, so the tile is selected by `layer`
// instead of by packing every tile into one 2D atlas (which cannot be mipmapped).
export const VERT_FLOATS = 9;
export const VERT_BYTES = VERT_FLOATS * 4;

const FACE_SHADE = [0.80, 0.80, 0.68, 0.68, 1.00, 0.52]; // N,S,W,E,Top,Bottom

// Unit-quad corners, CCW seen from outside: triangles (0,1,2) and (0,2,3).
const FACE_VERTS = [
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], // -Z
  [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]], // +Z
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]], // -X
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], // +X
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], // +Y
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], // -Y
];
const FACE_NORMAL = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]];
const FACE_TANGENTS = [
  [[1, 0, 0], [0, 1, 0]],
  [[1, 0, 0], [0, 1, 0]],
  [[0, 0, 1], [0, 1, 0]],
  [[0, 0, 1], [0, 1, 0]],
  [[1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, 1]],
];
// (u axis sign, v axis sign) for each corner. Derived from FACE_VERTS so the AO/light
// samples always line up with the vertices they are applied to; a hand-written mismatch
// shows up as hard dark bands across otherwise flat terrain.
const CORNER_SIGNS = FACE_VERTS.map((verts, face) => {
  const [tu, tv] = FACE_TANGENTS[face];
  return verts.map((v) => {
    const du = v[0] * tu[0] + v[1] * tu[1] + v[2] * tu[2];
    const dv = v[0] * tv[0] + v[1] * tv[1] + v[2] * tv[2];
    return [du === 0 ? -1 : 1, dv === 0 ? -1 : 1];
  });
});
// UV corner table: (u,v) = (0,0) (0,1) (1,1) (1,0) scaled by the tile size.
const UV_U = [0, 0, 1, 1];
const UV_V = [0, 1, 1, 0];
const TRI_ORDER = [0, 1, 2, 0, 2, 3];

const WATER_ID = 9;

// ---- scratch buffers, grown on demand: the mesher allocates nothing in steady state
let cap = 1 << 16;
let posArr = new Float32Array(cap * VERT_FLOATS);
let watArr = new Float32Array(cap * VERT_FLOATS);
let posCount = 0;
let watCount = 0;

function ensure(extraVerts) {
  const need = extraVerts * VERT_FLOATS;
  if (posCount + need <= posArr.length && watCount + need <= watArr.length) return;
  const ncap = Math.max(cap * 2, (posCount + need) * 2, (watCount + need) * 2);
  const np = new Float32Array(ncap), nw = new Float32Array(ncap);
  np.set(posArr.subarray(0, posCount));
  nw.set(watArr.subarray(0, watCount));
  posArr = np; watArr = nw; cap = ncap;
}

// Faces indexed the same way as FACE_VERTS / FACE_NORMAL: 0=-Z 1=+Z 2=-X 3=+X 4=+Y 5=-Y.
// A directional block keeps its front tile in slot 0 and its "other sides" tile in
// slot 1; these helpers move the front tile onto whichever face the block faces.
const FACING_TO_FACE = [3, 2, 1, 0, 4, 5];   // facing dir (+X,-X,+Z,-Z,+Y,-Y) -> face index
const OPPOSITE_FACE = [1, 0, 3, 2, 5, 4];

export class ChunkMesher {
  constructor(world) {
    this.world = world;
    this.stats = { quads: 0, ms: 0 };
    this._get = (x, y, z) => world.getBlockRaw(x, y, z);
  }

  /** Mesh one chunk. Returns {opaque, water, quads} where each mesh is {data, verts}. */
  mesh(chunk) {
    const t0 = performance.now();
    posCount = 0; watCount = 0;
    const world = this.world;
    const get = this._get;
    const ox = chunk.cx * CX, oz = chunk.cz * CZ;
    const blocks = chunk.blocks;

    for (let y = 0; y < WORLD_H; y++) {
      for (let lz = 0; lz < CZ; lz++) {
        for (let lx = 0; lx < CX; lx++) {
          const v = blocks[(y * CZ + lz) * CX + lx];
          if (v === 0) continue;
          const id = baseId(v);
          if (!BLOCKS[id]) continue;
          const kind = RENDER[id];
          const wx = ox + lx, wy = y, wz = oz + lz;
          // geometry is emitted in CHUNK-LOCAL space; the shader adds uOrigin
          const lwx = wx - ox, lwz = wz - oz;
          if (kind === R.PLANT) { emitPlant(world, get, wx, wy, wz, lwx, lwz, id); continue; }
          if (kind === R.CROP) { emitCrop(world, get, wx, wy, wz, lwx, lwz, id, chunk.facing[(y * CZ + lz) * CX + lx]); continue; }
          if (kind === R.PORTAL) { emitPortal(lwx, wy, lwz, id, chunk.facing[(y * CZ + lz) * CX + lx]); continue; }
          if (kind === R.FLAT) { emitFlat(world, get, wx, wy, wz, lwx, lwz, id, world.getPower(wx, wy, wz), chunk); continue; }
          if (kind === R.TORCH) { emitTorch(lwx, wy, lwz); continue; }
          if (kind === R.BED) { emitBed(lwx, wy, lwz, id, chunk.facing[(y * CZ + lz) * CX + lx]); continue; }
          emitCube(this, get, wx, wy, wz, lwx, lwz, id, kind === R.WATER, chunk.facing[(y * CZ + lz) * CX + lx]);
        }
      }
    }

    this.stats.ms = performance.now() - t0;
    this.stats.quads = (posCount + watCount) / (VERT_FLOATS * 4);
    return {
      opaque: posCount ? { data: posArr.slice(0, posCount), verts: posCount / VERT_FLOATS } : null,
      water: watCount ? { data: watArr.slice(0, watCount), verts: watCount / VERT_FLOATS } : null,
      quads: this.stats.quads,
    };
  }
}

function faceVisible(get, id, nx, ny, nz) {
  const nid = baseId(get(nx, ny, nz));
  if (nid === 0) return true;
  if (OPAQUE[nid]) return false;
  if (nid === id) return false;
  if (LIQUID[nid] && LIQUID[id]) return false;
  return true;
}

function emitCube(mesher, get, wx, wy, wz, lwx, lwz, id, isWater, facing) {
  const world = mesher.world;
  const def = BLOCKS[id];
  const dir = def && def.directional ? (facing || 0) : 0;
  for (let face = 0; face < 6; face++) {
    const n = FACE_NORMAL[face];
    const nx = wx + n[0], ny = wy + n[1], nz = wz + n[2];
    if (!faceVisible(get, id, nx, ny, nz)) continue;

    const layer = tileForFace(id, face, dir);
    const [u0, v0, du, dv] = tileUV(layer);
    const shade = FACE_SHADE[face];
    const isTop = face === 4;
    const yLift = (isWater && isTop) ? -0.12 : 0;

    ensure(6);
    const arr = isWater ? watArr : posArr;
    let count = isWater ? watCount : posCount;

    const [tu, tv] = FACE_TANGENTS[face];
    const signs = CORNER_SIGNS[face];
    const verts = FACE_VERTS[face];
    const q = [null, null, null, null];

    for (let c = 0; c < 4; c++) {
      const su = signs[c][0], sv = signs[c][1];
      const s1o = isOpaqueAt(get, nx + tu[0] * su, ny + tu[1] * su, nz + tu[2] * su);
      const s2o = isOpaqueAt(get, nx + tv[0] * sv, ny + tv[1] * sv, nz + tv[2] * sv);
      const s3o = isOpaqueAt(get, nx + tu[0] * su + tv[0] * sv, ny + tu[1] * su + tv[1] * sv, nz + tu[2] * su + tv[2] * sv);
      const ao = (s1o && s2o) ? 0 : 3 - (s1o + s2o + s3o);
      const aoF = 0.50 + 0.50 * (ao / 3);

      // Smooth lighting: average the RAW 0..15 levels of the four samples around this
      // corner, then apply the falloff curve once. Averaging the curve output instead
      // puts a hard step between adjacent corners and paints dark bands along block
      // edges (very visible on flat ground from above).
      let skySum = sampleSky(world, nx, ny, nz), blkSum = sampleBlockLight(world, nx, ny, nz), ln = 1;
      if (!s1o) { skySum += sampleSky(world, nx + tu[0] * su, ny + tu[1] * su, nz + tu[2] * su); blkSum += sampleBlockLight(world, nx + tu[0] * su, ny + tu[1] * su, nz + tu[2] * su); ln++; }
      if (!s2o) { skySum += sampleSky(world, nx + tv[0] * sv, ny + tv[1] * sv, nz + tv[2] * sv); blkSum += sampleBlockLight(world, nx + tv[0] * sv, ny + tv[1] * sv, nz + tv[2] * sv); ln++; }
      if (!s3o) {
        const dx3 = nx + tu[0] * su + tv[0] * sv, dy3 = ny + tu[1] * su + tv[1] * sv, dz3 = nz + tu[2] * su + tv[2] * sv;
        skySum += sampleSky(world, dx3, dy3, dz3); blkSum += sampleBlockLight(world, dx3, dy3, dz3); ln++;
      }
      const light = lightCurve(skySum / ln, blkSum / ln);

      const vp = verts[c];
      q[c] = [
        lwx + vp[0],
        wy + vp[1] + (vp[1] === 1 ? yLift : 0),
        lwz + vp[2],
        u0 + UV_U[c] * du,
        v0 + UV_V[c] * dv,
        light, aoF, shade, layer,
      ];
    }

    for (let k = 0; k < 6; k++) {
      const vtx = q[TRI_ORDER[k]];
      arr[count++] = vtx[0]; arr[count++] = vtx[1]; arr[count++] = vtx[2];
      arr[count++] = vtx[3]; arr[count++] = vtx[4];
      arr[count++] = vtx[5]; arr[count++] = vtx[6]; arr[count++] = vtx[7];
      arr[count++] = vtx[8];
    }
    if (isWater) watCount = count; else posCount = count;
  }
}

function isOpaqueAt(get, x, y, z) {
  return OPAQUE[baseId(get(x, y, z))];
}

/**
 * Atlas layer for one face of a block.
 * Non-directional blocks map face -> tile directly. Directional blocks (furnace, chest,
 * pumpkin, anvil) keep their front art in slot 0 and the generic side in slot 1, so the
 * front is moved onto the stored facing and the old front face becomes a plain side.
 */
export function tileForFace(id, face, dir) {
  const def = BLOCKS[id];
  const base = id * ATLAS_SLOTS;
  if (!def || !def.directional || face > 3) return TILE[base + face];
  const frontFace = FACING_TO_FACE[dir & 7];
  if (frontFace > 3) return TILE[base + face];         // facing up/down: keep the sides
  const oldFront = OPPOSITE_FACE[0];                   // slot 0 authored as the -Z face
  if (face === frontFace) return TILE[base + 0];       // front art here
  if (face === oldFront && frontFace !== oldFront) return TILE[base + 1];
  return TILE[base + face];
}

// ------------------------------------------------------------------ special shapes
function emitPlant(world, get, wx, wy, wz, lwx, lwz, id) {
  const layer = TILE[id * ATLAS_SLOTS];
  const [u0, v0, du, dv] = tileUV(layer);
  const light = Math.max(0.45, lightCurve(sampleSky(world, wx, wy + 1, wz), sampleBlockLight(world, wx, wy + 1, wz)));
  ensure(12);
  const arr = posArr;
  const w = 0.42, h = 1.0;
  const cx = lwx + 0.5, cz = lwz + 0.5;
  const planes = [
    [[cx - w, wy, cz - w], [cx - w, wy + h, cz - w], [cx + w, wy + h, cz + w], [cx + w, wy, cz + w]],
    [[cx - w, wy, cz + w], [cx - w, wy + h, cz + w], [cx + w, wy + h, cz - w], [cx + w, wy, cz - w]],
  ];
  const uv = [[u0, v0 + dv], [u0, v0], [u0 + du, v0], [u0 + du, v0 + dv]];
  for (const plane of planes) {
    for (let k = 0; k < 6; k++) {
      const qi = TRI_ORDER[k];
      const p = plane[qi], uvc = uv[qi];
      arr[posCount++] = p[0]; arr[posCount++] = p[1]; arr[posCount++] = p[2];
      arr[posCount++] = uvc[0]; arr[posCount++] = uvc[1];
      arr[posCount++] = light; arr[posCount++] = 1.0; arr[posCount++] = 1.0;
      arr[posCount++] = layer;
    }
  }
}

/**
 * Crossed planes whose texture depends on the growth stage. The stage is 0..3 and lives
 * in the chunk's facing byte (crops reuse that byte since they never face anywhere).
 */
function emitCrop(world, get, wx, wy, wz, lwx, lwz, id, stage) {
  const s = Math.max(0, Math.min(3, stage | 0));
  const layer = TILE[id * ATLAS_SLOTS + s];
  const [u0, v0, du, dv] = tileUV(layer);
  const light = Math.max(0.45, lightCurve(sampleSky(world, wx, wy + 1, wz), sampleBlockLight(world, wx, wy + 1, wz)));
  ensure(12);
  const arr = posArr;
  // young crops are shorter than ripe ones
  const h = 0.35 + s * 0.22;
  const w = 0.42;
  const cx = lwx + 0.5, cz = lwz + 0.5;
  const planes = [
    [[cx - w, wy, cz - w], [cx - w, wy + h, cz - w], [cx + w, wy + h, cz + w], [cx + w, wy, cz + w]],
    [[cx - w, wy, cz + w], [cx - w, wy + h, cz + w], [cx + w, wy + h, cz - w], [cx + w, wy, cz - w]],
  ];
  // sample only the lower part of the tile so the plant grows up out of the ground
  const uv = [
    [u0, v0 + dv], [u0, v0 + dv * (1 - h) - dv * 0.05],
    [u0 + du, v0 + dv * (1 - h) - dv * 0.05], [u0 + du, v0 + dv],
  ];
  for (const plane of planes) {
    for (let k = 0; k < 6; k++) {
      const qi = TRI_ORDER[k];
      const p = plane[qi], uvc = uv[qi];
      arr[posCount++] = p[0]; arr[posCount++] = p[1]; arr[posCount++] = p[2];
      arr[posCount++] = uvc[0]; arr[posCount++] = uvc[1];
      arr[posCount++] = light; arr[posCount++] = 1.0; arr[posCount++] = 1.0;
      arr[posCount++] = layer;
    }
  }
}

/**
 * A thin plate lying on the floor: redstone wire, levers, buttons and pressure plates.
 * `state` is the chunk's facing byte, which wire uses for its 0..15 strength (brighter
 * dust when powered) and the piston uses for its direction.
 */
function emitFlat(world, get, wx, wy, wz, lwx, lwz, id, state, chunk) {
  const base = id * ATLAS_SLOTS;
  const layer = TILE[base];
  const [u0, v0, du, dv] = tileUV(layer);
  const light = Math.max(0.45, lightCurve(sampleSky(world, wx, wy, wz), sampleBlockLight(world, wx, wy, wz)));
  ensure(6);
  const arr = posArr;
  const h = 0.0625;                       // 1/16 of a block thick
  const top = wy + h;
  const v = [
    [lwx, top, lwz + 1], [lwx + 1, top, lwz + 1], [lwx + 1, top, lwz], [lwx, top, lwz],
  ];
  const uv = [[u0, v0 + dv], [u0 + du, v0 + dv], [u0 + du, v0], [u0, v0]];
  // powered wire glows brighter
  const glow = (id === idOf('redstone_wire') && state > 0)
    ? 1 + Math.min(0.9, state / 15)
    : 1;
  for (let k = 0; k < 6; k++) {
    const qi = TRI_ORDER[k];
    const p = v[qi], uvc = uv[qi];
    arr[posCount++] = p[0]; arr[posCount++] = p[1]; arr[posCount++] = p[2];
    arr[posCount++] = uvc[0]; arr[posCount++] = uvc[1];
    arr[posCount++] = light * glow; arr[posCount++] = 1.0; arr[posCount++] = 1.0;
    arr[posCount++] = layer;
  }
  void chunk;
}

/**
 * Nether portal: a single flat plane filling the block. `facing` picks the axis
 * (0/1 = the plane spans Z, i.e. the portal faces along X; 2/3 the other way).
 */
function emitPortal(lx, ly, lz, id, facing) {
  const layer = TILE[id * ATLAS_SLOTS];
  const [u0, v0, du, dv] = tileUV(layer);
  const alongX = (facing & 1) === 0;
  ensure(12);
  const arr = posArr;
  const y0 = ly + 0.02, y1 = ly + 0.98;
  const q = alongX
    ? [[lx + 0.5, y0, lz], [lx + 0.5, y1, lz], [lx + 0.5, y1, lz + 1], [lx + 0.5, y0, lz + 1]]
    : [[lx, y0, lz + 0.5], [lx, y1, lz + 0.5], [lx + 1, y1, lz + 0.5], [lx + 1, y0, lz + 0.5]];
  const uv = [[u0, v0 + dv], [u0, v0], [u0 + du, v0], [u0 + du, v0 + dv]];
  // emit both windings so the plane is visible from either side
  for (const order of [TRI_ORDER, [0, 2, 1, 0, 3, 2]]) {
    for (let k = 0; k < 6; k++) {
      const qi = order[k];
      const p = q[qi], uvc = uv[qi];
      arr[posCount++] = p[0]; arr[posCount++] = p[1]; arr[posCount++] = p[2];
      arr[posCount++] = uvc[0]; arr[posCount++] = uvc[1];
      arr[posCount++] = 1.0; arr[posCount++] = 1.0; arr[posCount++] = 1.0;
      arr[posCount++] = layer;
    }
  }
}

/**
 * Bed: a low box (1 x 9/16 x 1) whose texture picks the head or foot end from `facing`.
 * facing 0/1 = the long axis runs along X, 2/3 = along Z.
 */
function emitBed(lx, ly, lz, id, facing) {
  const alongX = (facing & 1) === 0;
  const base = id * ATLAS_SLOTS;
  ensure(6 * 6);
  const arr = posArr;
  const h = 0.5625;
  const top = TILE[base + 4];
  const side = TILE[base + 2];
  const headTile = TILE[base + 1];
  const footTile = TILE[base + 0];
  // per-face tile override: the two ends show the head/foot artwork
  const faces = [
    // -Z
    { v: [[lx, ly, lz], [lx, ly + h, lz], [lx + 1, ly + h, lz], [lx + 1, ly, lz]], shade: 0.8, tile: alongX ? footTile : side },
    // +Z
    { v: [[lx + 1, ly, lz + 1], [lx + 1, ly + h, lz + 1], [lx, ly + h, lz + 1], [lx, ly, lz + 1]], shade: 0.8, tile: alongX ? headTile : side },
    // -X
    { v: [[lx, ly, lz + 1], [lx, ly + h, lz + 1], [lx, ly + h, lz], [lx, ly, lz]], shade: 0.68, tile: alongX ? side : footTile },
    // +X
    { v: [[lx + 1, ly, lz], [lx + 1, ly + h, lz], [lx + 1, ly + h, lz + 1], [lx + 1, ly, lz + 1]], shade: 0.68, tile: alongX ? side : headTile },
    // +Y (the blanket top)
    { v: [[lx, ly + h, lz + 1], [lx + 1, ly + h, lz + 1], [lx + 1, ly + h, lz], [lx, ly + h, lz]], shade: 1.0, tile: top },
  ];
  for (const face of faces) {
    const [u0, v0, du, dv] = tileUV(face.tile);
    const uv = [[u0, v0 + dv], [u0, v0], [u0 + du, v0], [u0 + du, v0 + dv]];
    for (let k = 0; k < 6; k++) {
      const qi = TRI_ORDER[k];
      const p = face.v[qi], uvc = uv[qi];
      arr[posCount++] = p[0]; arr[posCount++] = p[1]; arr[posCount++] = p[2];
      arr[posCount++] = uvc[0]; arr[posCount++] = uvc[1];
      arr[posCount++] = 1.0; arr[posCount++] = 1.0; arr[posCount++] = face.shade;
      arr[posCount++] = face.tile;
    }
  }
}

function emitTorch(lx, ly, lz) {
  ensure(TORCH_VERTS);
  const arr = posArr;
  const g = _torchGeo || (_torchGeo = buildTorchQuads());
  for (let i = 0; i < g.length; i += VERT_FLOATS) {
    arr[posCount++] = g[i] + lx;
    arr[posCount++] = g[i + 1] + ly;
    arr[posCount++] = g[i + 2] + lz;
    arr[posCount++] = g[i + 3];
    arr[posCount++] = g[i + 4];
    arr[posCount++] = g[i + 5];
    arr[posCount++] = g[i + 6];
    arr[posCount++] = g[i + 7];
    arr[posCount++] = g[i + 8];
  }
}

const TORCH_VERTS = 30;   // 5 quads x 6 vertices

/** Build the torch's own geometry once (units relative to the block origin). */
function buildTorchQuads() {
  const id = 30;                                    // torch block id
  const layer = TILE[id * ATLAS_SLOTS];
  const [u0, v0, du, dv] = tileUV(layer);
  const out = [];
  const r = 0.0625, h = 0.625;
  const x0 = 0.5 - r, x1 = 0.5 + r;
  const z0 = 0.5 - r, z1 = 0.5 + r;
  const y0 = 0, y1 = h;
  const box = [
    [[[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], 0.62],
    [[[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], 0.62],
    [[[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], 0.52],
    [[[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], 0.52],
    [[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], 1.0],
  ];
  const uv = [[u0, v0 + dv], [u0, v0], [u0 + du, v0], [u0 + du, v0 + dv]];
  for (const [plane, shade] of box) {
    for (let k = 0; k < 6; k++) {
      const qi = TRI_ORDER[k];
      const p = plane[qi], uvc = uv[qi];
      out.push(p[0], p[1], p[2], uvc[0], uvc[1], 1.0, 1.0, shade, layer);
    }
  }
  return out;
}
let _torchGeo = null;

let _world = null;
export function setMesherWorld(world) { _world = world; }
