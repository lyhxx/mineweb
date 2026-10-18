// world/chunk.js — voxel storage for one 16 x WORLD_H x 16 column.
import { OPAQUE, SOLID, LIQUID, baseId } from '../core/blocks.js';

export const CX = 16;
export const CZ = 16;
export const WORLD_H = 128;
export const VOLUME = CX * CZ * WORLD_H;
export const SEA_LEVEL = 62;

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4,
  SAVANNA: 5, MOUNTAINS: 6, SNOWY: 7, TAIGA: 8, JUNGLE: 9, SWAMP: 10,
};

export const BIOME_NAMES = ['海洋', '沙滩', '平原', '森林', '沙漠', '热带草原', '山地', '雪原', '针叶林', '丛林', '沼泽'];
export const BIOME_COLORS = [
  [0.20, 0.35, 0.70], [0.86, 0.83, 0.60], [0.45, 0.72, 0.32], [0.28, 0.60, 0.26],
  [0.80, 0.78, 0.45], [0.66, 0.74, 0.34], [0.55, 0.60, 0.58], [0.86, 0.92, 0.95],
  [0.32, 0.56, 0.40], [0.20, 0.62, 0.22], [0.36, 0.52, 0.32],
];

export class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = cx * 8192 + cz;
    this.blocks = new Uint8Array(VOLUME);
    // Orientation for facing blocks (furnace / chest / pumpkin / anvil).
    // 0 = +X, 1 = -X, 2 = +Z, 3 = -Z, 4 = +Y, 5 = -Y — the face the front looks toward.
    // Kept in a parallel array so the block byte stays a plain id.
    this.facing = new Uint8Array(VOLUME);
    this.biome = new Uint8Array(CX * CZ);
    this.heightMap = new Uint8Array(CX * CZ);   // highest non-air block + 1
    this.light = new Uint8Array(VOLUME);        // block light 0..15 (skylight separate)
    this.skyLight = new Uint8Array(VOLUME);     // skylight 0..15
    this.generated = false;
    this.decorated = false;
    this.lit = false;
    this.dirty = true;                          // needs remesh
    this.mesh = null;                           // {opaque: MeshData, water: MeshData}
    this.meshVersion = -1;
    this.lastUse = 0;
  }

  static index(x, y, z) { return (y * CZ + z) * CX + x; }

  get(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 0;
    return this.blocks[(y * CZ + z) * CX + x];
  }

  set(x, y, z, v) {
    if (y < 0 || y >= WORLD_H) return;
    const i = (y * CZ + z) * CX + x;
    this.blocks[i] = v;
    const h = y + 1;
    const hi = z * CX + x;
    if (v !== 0) {
      if (h > this.heightMap[hi]) this.heightMap[hi] = h;
    } else if (this.heightMap[hi] === h) {
      let ny = y;
      while (ny > 0 && this.blocks[((ny - 1) * CZ + z) * CX + x] === 0) ny--;
      this.heightMap[hi] = ny;
    }
    this.dirty = true;
  }

  /** Orientation of a facing block (see the `facing` array comment). */
  getFacing(x, y, z) {
    if (y < 0 || y >= WORLD_H) return 0;
    return this.facing[(y * CZ + z) * CX + x];
  }

  setFacing(x, y, z, dir) {
    if (y < 0 || y >= WORLD_H) return;
    this.facing[(y * CZ + z) * CX + x] = dir & 7;
    this.dirty = true;
  }

  /** Highest solid (collidable) block height + 1 in a column, scanning down. */
  topSolid(x, z) {
    for (let y = WORLD_H - 1; y >= 0; y--) {
      if (SOLID[baseId(this.blocks[(y * CZ + z) * CX + x])]) return y + 1;
    }
    return 0;
  }

  isOpaqueAt(x, y, z) {
    if (y < 0) return true;
    if (y >= WORLD_H) return false;
    return OPAQUE[baseId(this.blocks[(y * CZ + z) * CX + x])] === 1;
  }

  isSolidAt(x, y, z) {
    if (y < 0) return true;
    if (y >= WORLD_H) return false;
    return SOLID[baseId(this.blocks[(y * CZ + z) * CX + x])] === 1;
  }

  isLiquidAt(x, y, z) {
    if (y < 0 || y >= WORLD_H) return false;
    return LIQUID[baseId(this.blocks[(y * CZ + z) * CX + x])] === 1;
  }

  /** Average surface height, used for spawn placement and mob spawning. */
  surfaceHeight(x, z) { return this.heightMap[z * CX + x]; }

  estimateBytes() {
    return this.blocks.length + this.biome.length + this.heightMap.length + this.light.length + this.skyLight.length;
  }
}
