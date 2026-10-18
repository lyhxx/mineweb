// render/itemmesh.js — builds a small standalone mesh for a single block, used for the
// held item, dropped items and the inventory preview. Vertex layout matches the chunk
// mesher (VERT_FLOATS, including the texture-array layer) so the same program draws it.
import { TILE, ATLAS_SLOTS, RENDER, R, BLOCKS, baseId } from '../core/blocks.js';
import { tileUV } from '../core/atlas.js';

const FACE_VERTS = [
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
];
const FACE_SHADE = [0.80, 0.80, 0.68, 0.68, 1.00, 0.52];
const UV_U = [0, 0, 1, 1];
const UV_V = [0, 1, 1, 0];
const TRI = [0, 1, 2, 0, 2, 3];

/**
 * Build a centred cube mesh for a block id.
 * Returns { data: Float32Array, quads: number, layer info embedded per vertex }.
 */
export function buildBlockMesh(id, opts = {}) {
  const def = BLOCKS[id];
  if (!def) return null;
  const kind = RENDER[id];
  const out = [];

  if (kind === R.PLANT) {
    // crossed planes, same as in the world
    const layer = TILE[id * ATLAS_SLOTS];
    const [u0, v0, du, dv] = tileUV(layer);
    const uv = [[u0, v0 + dv], [u0, v0], [u0 + du, v0], [u0 + du, v0 + dv]];
    const w = 0.5;
    const planes = [
      [[-w, 0, -w], [-w, 1, -w], [w, 1, w], [w, 0, w]],
      [[-w, 0, w], [-w, 1, w], [w, 1, -w], [w, 0, -w]],
    ];
    for (const plane of planes) {
      for (const k of TRI) {
        const p = plane[k], t = uv[k];
        out.push(p[0] + 0.5, p[1], p[2] + 0.5, t[0], t[1], 1.0, 1.0, 1.0, layer);
      }
    }
    return { data: new Float32Array(out), quads: 4 };
  }

  for (let face = 0; face < 6; face++) {
    const layer = TILE[id * ATLAS_SLOTS + face];
    const [u0, v0, du, dv] = tileUV(layer);
    const shade = FACE_SHADE[face];
    const faceVerts = FACE_VERTS[face];
    const q = [];
    for (let c = 0; c < 4; c++) {
      const vp = faceVerts[c];
      q.push([
        vp[0], vp[1], vp[2],
        u0 + UV_U[c] * du, v0 + UV_V[c] * dv,
        1.0, 1.0, shade, layer,
      ]);
    }
    for (const k of TRI) {
      const v = q[k];
      out.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
    }
  }
  return { data: new Float32Array(out), quads: 6 };
}
