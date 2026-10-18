// world/nether.js — the Nether dimension.
//
// Generation is deliberately different from the overworld: instead of a heightmap there
// is a solid netherrack volume with large caverns carved out of it by 3D noise, a lava
// sea near the bottom, a bedrock roof, and ore-like quartz / glowstone / soul sand.
// Like the overworld generator it is a pure function of (chunkX, chunkZ, seed).
import { Noise } from '../core/noise.js';
import { makeRng, clamp, hash3i, hash2i } from '../core/math.js';
import { idOf } from '../core/blocks.js';
import { Chunk, CX, CZ, WORLD_H } from './chunk.js';

export const LAVA_LEVEL = 31;
export const NETHER_ROOF = 118;
export const NETHER_FLOOR = 4;

const ID = {};

export class NetherGen {
  constructor(seed = 1337) {
    this.seed = (seed ^ 0x5f1e77) | 0;
    const s = this.seed;
    this.cave = new Noise(s + 11);
    this.cave2 = new Noise(s + 23);
    this.detail = new Noise(s + 37);
    this.biome = new Noise(s + 53);
    ID.netherrack = idOf('netherrack');
    ID.soul_sand = idOf('soul_sand');
    ID.quartz = idOf('quartz_block');
    ID.glowstone = idOf('glowstone');
    ID.lava = idOf('lava');
    ID.bedrock = idOf('bedrock');
    ID.air = 0;
  }

  /** Height of the solid netherrack floor at a column (top of the solid mass). */
  floorAt(wx, wz) {
    const n = this.detail.fbm2(wx * 0.018, wz * 0.018, 3);
    return Math.round(LAVA_LEVEL + 4 + n * 7);
  }

  generateChunk(chunk) {
    const ox = chunk.cx * CX, oz = chunk.cz * CZ;
    const c = chunk;
    const NR = ID.netherrack, SS = ID.soul_sand, QZ = ID.quartz, GL = ID.glowstone;
    const LAVA = ID.lava, BED = ID.bedrock;

    for (let lz = 0; lz < CZ; lz++) {
      for (let lx = 0; lx < CX; lx++) {
        const wx = ox + lx, wz = oz + lz;
        const floor = this.floorAt(wx, wz);
        const biomeN = this.biome.n2(wx * 0.006, wz * 0.006);
        const soulPatch = biomeN > 0.35;
        const colIdx = lz * CX + lx;
        c.biome[colIdx] = 1;                     // the Nether reports one biome

        for (let y = 0; y < WORLD_H; y++) {
          let block;
          if (y <= NETHER_FLOOR || y >= NETHER_ROOF) {
            block = BED;
          } else if (y <= LAVA_LEVEL) {
            block = LAVA;                              // the lava sea
          } else {
            // Solid netherrack everywhere, carved by two crossing worm noises plus a
            // rare wide chamber. This is what gives the Nether its tunnel-network feel
            // instead of a surface heightmap.
            const n1 = this.cave.n3(wx * 0.030, y * 0.055, wz * 0.030);
            const n2 = this.cave2.n3(wx * 0.028 + 100, y * 0.048, wz * 0.028 - 100);
            const worm = Math.abs(n1) < 0.13 && Math.abs(n2) < 0.13;
            const chamber = y > LAVA_LEVEL + 4 && this.cave.n3(wx * 0.012 + 40, y * 0.020, wz * 0.012 - 40) > 0.42;
            block = (worm || chamber) ? 0 : NR;

            // soul sand gathers on the floor of the lower caverns
            if (block === NR && soulPatch && y <= LAVA_LEVEL + 4) block = SS;
          }

          // glowstone clusters clinging to the ceiling region
          if (block === NR && y > NETHER_ROOF - 16) {
            const g = this.cave2.n3(wx * 0.085, y * 0.085 + 50, wz * 0.085);
            if (g > 0.40) block = GL;
          }
          // quartz seams and glowstone pockets inside the rock
          if (block === NR) {
            const r = hash3i(wx, y, wz, this.seed + 707);
            if (r < 0.006) block = QZ;
            else if (r > 0.9978) block = GL;
          }
          if (block !== 0) c.blocks[(y * CZ + lz) * CX + lx] = block;
        }

        let hi = WORLD_H;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          if (c.blocks[(y * CZ + lz) * CX + lx] !== 0) { hi = y + 1; break; }
        }
        c.heightMap[colIdx] = hi > WORLD_H ? 0 : hi;
      }
    }
    // The Nether has no sky. Lighting would otherwise be pitch black once the chunks are
    // lit, so seed a dim uniform ambient level; lava and glowstone still stand out.
    c.skyLight.fill(4);
    c.light.fill(0);
    c.generated = true;
    c.lit = true;
    c.dirty = true;
  }

  isCave(wx, y, wz) {
    const caveA = this.cave.n3(wx * 0.028, y * 0.042, wz * 0.028);
    const caveB = this.cave2.n3(wx * 0.033 + 100, y * 0.05, wz * 0.033 - 100);
    return Math.abs(caveA) < 0.10 && Math.abs(caveB) < 0.10;
  }

  /** Find a safe arrival point: solid ground with two blocks of air above. */
  findSpawn(world) {
    for (let r = 0; r < 60; r++) {
      for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        const wx = dx, wz = dz;
        const floor = this.floorAt(wx, wz);
        const x = wx, z = wz;
        const y = clamp(floor + 1, LAVA_LEVEL + 4, NETHER_ROOF - 6);
        if (!this.isCave(x, y - 1, z) && !this.isCave(x, y, z) && !this.isCave(x, y + 1, z)) {
          return { x: x + 0.5, y, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: LAVA_LEVEL + 14, z: 0.5 };
  }

  /** The Nether has no vegetation pass, but it does need its chests registered. */
  decorateChunk(chunk, world) {
    if (!chunk.generated || chunk.decorated) return !!chunk.decorated;
    const rng = makeRng((this.seed ^ (chunk.cx * 73856093) ^ (chunk.cz * 19349663)) | 0);
    // a rare ruined chest in a cavern, using the dungeon loot table
    if (rng() < 0.06) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const lx = (rng() * CX) | 0, lz = (rng() * CZ) | 0;
        const wx = chunk.cx * CX + lx, wz = chunk.cz * CZ + lz;
        const y = LAVA_LEVEL + 6 + ((rng() * 40) | 0);
        // needs a solid floor and open space above
        if (world.getBlockRaw(wx, y, wz) !== 0) continue;
        if (world.getBlockRaw(wx, y + 1, wz) !== 0) continue;
        if (world.getBlockRaw(wx, y - 1, wz) !== ID.netherrack) continue;
        world.setBlockAt(wx, y, wz, idOf('chest'), true);
        const gen = world.gen;
        if (gen && gen.markChest) gen.markChest(world, wx, y, wz, 'dungeon');
        break;
      }
    }
    chunk.decorated = true;
    return true;
  }
}
