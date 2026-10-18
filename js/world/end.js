// world/end.js — the End dimension.
//
// The End is a single floating island of end stone around the origin, with a ring of
// obsidian pillars carrying healing crystals, and a scattered field of small islands
// further out. There is no day cycle and no sky: the skybox is the starfield.
import { Noise } from '../core/noise.js';
import { makeRng, hash3i, clamp } from '../core/math.js';
import { idOf } from '../core/blocks.js';
import { CX, CZ, WORLD_H } from './chunk.js';

export const END_ISLAND_RADIUS = 62;
export const END_GROUND_Y = 64;
export const PILLAR_COUNT = 10;
export const PILLAR_RING = 42;
export const PILLAR_HEIGHT = 28;

const ID = {};

export class EndGen {
  constructor(seed = 1337) {
    this.seed = (seed ^ 0x0e4d) | 0;
    this.detail = new Noise(this.seed + 31);
    this.islands = new Noise(this.seed + 61);
    ID.end_stone = idOf('end_stone');
    ID.obsidian = idOf('obsidian');
    ID.purpur = idOf('purpur');
    ID.bedrock = idOf('bedrock');
    ID.air = 0;
  }

  /** Height of the main island's surface at a column, or -1 outside the island. */
  islandHeight(wx, wz) {
    const r = Math.hypot(wx, wz);
    if (r > END_ISLAND_RADIUS + 10) return -1;
    // radial falloff plus noise, so the edge is ragged rather than a perfect circle
    const edge = clamp(1 - (r - (END_ISLAND_RADIUS - 16)) / 20, 0, 1);
    const n = this.detail.fbm2(wx * 0.045, wz * 0.045, 3);
    const thickness = (10 + n * 7) * edge;
    if (thickness <= 0.5) return -1;
    return Math.round(END_GROUND_Y - thickness);
  }

  generateChunk(chunk) {
    const ox = chunk.cx * CX, oz = chunk.cz * CZ;
    const c = chunk;
    const ES = ID.end_stone;
    for (let lz = 0; lz < CZ; lz++) {
      for (let lx = 0; lx < CX; lx++) {
        const wx = ox + lx, wz = oz + lz;
        const top = this.islandHeight(wx, wz);
        // far from the centre there are small floating islands instead
        const far = Math.hypot(wx, wz) > END_ISLAND_RADIUS + 12;
        let smallTop = -1, smallBottom = -1;
        if (far) {
          const n = this.islands.n2(wx * 0.02, wz * 0.02);
          if (n > 0.45) {
            smallTop = Math.round(56 + n * 26);
            smallBottom = smallTop - Math.round(4 + n * 8);
          }
        }
        const colIdx = lz * CX + lx;
        c.biome[colIdx] = 2;
        for (let y = 0; y < WORLD_H; y++) {
          let block = 0;
          if (top >= 0) {
            if (y <= END_GROUND_Y && y > top) block = ES;
            else if (y === top) block = ES;
          } else if (smallTop >= 0 && y <= smallTop && y >= smallBottom) {
            block = ES;
          }
          // a bedrock plug under the very centre so the island never breaks through
          if (Math.hypot(wx, wz) < 2 && y <= END_GROUND_Y - 14) block = ID.bedrock;
          if (block) c.blocks[(y * CZ + lz) * CX + lx] = block;
        }
        let hi = WORLD_H;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          if (c.blocks[(y * CZ + lz) * CX + lx] !== 0) { hi = y + 1; break; }
        }
        c.heightMap[colIdx] = hi > WORLD_H ? 0 : hi;
      }
    }
    c.skyLight.fill(15);
    c.light.fill(0);
    c.generated = true;
    c.lit = true;
    c.dirty = true;
  }

  /**
   * The obsidian pillars with their healing crystals, plus the exit portal on the centre
   * island. These are placed once, in the chunk that owns the origin.
   */
  decorateChunk(chunk, world) {
    if (!chunk.generated || chunk.decorated) return !!chunk.decorated;
    if (chunk.cx === 0 && chunk.cz === 0) {
      this.buildPillars(world);
      this.buildExitPortal(world);
      this.buildObsidianPlatform(world);
    }
    chunk.decorated = true;
    return true;
  }

  buildPillars(world) {
    const rng = makeRng(this.seed + 707);
    this.crystals = [];
    for (let i = 0; i < PILLAR_COUNT; i++) {
      const a = (i / PILLAR_COUNT) * Math.PI * 2;
      const px = Math.round(Math.cos(a) * PILLAR_RING);
      const pz = Math.round(Math.sin(a) * PILLAR_RING);
      const h = PILLAR_HEIGHT + ((rng() * 8) | 0);
      for (let y = END_GROUND_Y; y <= END_GROUND_Y + h; y++) {
        world.setBlockAt(px, y, pz, idOf('obsidian'), true);
      }
      // crystal perched on top; a few pillars are caged like MC's
      const cy = END_GROUND_Y + h + 1;
      this.crystals.push({ x: px + 0.5, y: cy, z: pz + 0.5, alive: true });
      world.setBlockAt(px, cy, pz, idOf('purpur'), true);
    }
  }

  /** The 3x3 bedrock pool with the exit portal in the middle. */
  buildExitPortal(world) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        world.setBlockAt(dx, END_GROUND_Y - 1, dz, idOf('bedrock'), true);
      }
    }
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        world.setBlockAt(dx, END_GROUND_Y, dz, idOf('end_portal'), true);
        world.setFacing(dx, END_GROUND_Y, dz, 0);
      }
    }
  }

  /** The obsidian platform the player arrives on, a little way from the centre. */
  buildObsidianPlatform(world) {
    const px = 0, pz = -20;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let y = 0; y < 4; y++) world.setBlockAt(px + dx, END_GROUND_Y + y, pz + dz, 0, true);
      }
    }
    this.arrival = { x: px + 0.5, y: END_GROUND_Y, z: pz + 0.5 };
  }

  /** Where the player should land: the obsidian platform, or the island centre. */
  findSpawn() {
    return this.arrival ? { ...this.arrival } : { x: 0.5, y: END_GROUND_Y, z: -20.5 };
  }

  /** The End has no vegetation pass. */
  heightAt() { return END_GROUND_Y; }
}
