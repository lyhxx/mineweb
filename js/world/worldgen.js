// world/worldgen.js — terrain, caves, ores, biomes and vegetation.
// Everything is a pure function of (chunkX, chunkZ, seed) so chunks can be generated
// independently, in any order — which is what makes streaming possible.
import { Noise } from '../core/noise.js';
import { makeRng, clamp, hash2i, hash3i } from '../core/math.js';
import { idOf } from '../core/blocks.js';
import { Chunk, CX, CZ, WORLD_H, SEA_LEVEL, BIOME } from './chunk.js';

const ID = {
  air: 0, stone: 0, dirt: 0, grass: 0, cobble: 0, planks: 0, log: 0, leaves: 0, sand: 0,
  water: 0, lava: 0, bedrock: 0, gravel: 0, sandstone: 0, coal: 0, iron: 0, gold: 0,
  diamond: 0, glass: 0, brick: 0, bookshelf: 0, craft: 0, furnace: 0, tnt: 0, pumpkin: 0,
  snow: 0, ice: 0, clay: 0, glowstone: 0, chest: 0, torch: 0, flower: 0,
};
export function initGenIds() {
  ID.stone = idOf('stone'); ID.dirt = idOf('dirt'); ID.grass = idOf('grass');
  ID.cobble = idOf('cobblestone'); ID.planks = idOf('planks'); ID.log = idOf('log');
  ID.leaves = idOf('leaves'); ID.sand = idOf('sand'); ID.water = idOf('water');
  ID.lava = idOf('lava'); ID.bedrock = idOf('bedrock'); ID.gravel = idOf('gravel');
  ID.sandstone = idOf('sandstone'); ID.coal = idOf('coal_ore'); ID.iron = idOf('iron_ore');
  ID.gold = idOf('gold_ore'); ID.diamond = idOf('diamond_ore'); ID.glass = idOf('glass');
  ID.brick = idOf('brick'); ID.bookshelf = idOf('bookshelf'); ID.craft = idOf('crafting_table');
  ID.furnace = idOf('furnace'); ID.tnt = idOf('tnt'); ID.pumpkin = idOf('pumpkin');
  ID.snow = idOf('snow'); ID.ice = idOf('ice'); ID.clay = idOf('clay');
  ID.glowstone = idOf('glowstone'); ID.chest = idOf('chest'); ID.torch = idOf('torch');
  ID.flower = idOf('flower');
}

export class WorldGen {
  constructor(seed = 1337) {
    this.seed = seed | 0;
    const s = this.seed;
    this.continent = new Noise(s + 1);
    this.hills = new Noise(s + 2);
    this.mountain = new Noise(s + 3);
    this.ridge = new Noise(s + 4);
    this.temp = new Noise(s + 5);
    this.humid = new Noise(s + 6);
    this.cave1 = new Noise(s + 7);
    this.cave2 = new Noise(s + 8);
    this.cheese = new Noise(s + 9);
    this.detail = new Noise(s + 10);
    this.soil = new Noise(s + 11);
    initGenIds();
  }

  // --------------------------------------------------------------- climate + biome
  climate(wx, wz) {
    const t = this.temp.fbm2(wx * 0.0018, wz * 0.0018, 3) * 0.5 + 0.5;
    const h = this.humid.fbm2(wx * 0.0021 + 91.7, wz * 0.0021 - 33.1, 3) * 0.5 + 0.5;
    return [t, h];
  }

  biomeAt(wx, wz, height) {
    const [t, h] = this.climate(wx, wz);
    if (height < SEA_LEVEL - 1) return BIOME.OCEAN;
    if (height <= SEA_LEVEL + 1) return BIOME.BEACH;
    if (height > 92) return t < 0.45 ? BIOME.SNOWY : BIOME.MOUNTAINS;
    if (t < 0.30) return h > 0.55 ? BIOME.TAIGA : BIOME.SNOWY;
    if (t > 0.72) {
      if (h < 0.34) return BIOME.DESERT;
      if (h < 0.60) return BIOME.SAVANNA;
      return BIOME.JUNGLE;
    }
    if (h > 0.70) return BIOME.SWAMP;
    if (h > 0.45) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  // --------------------------------------------------------------- height field
  /** Continuous base surface elevation (top solid block Y) at world x,z. */
  heightAt(wx, wz) {
    const cont = this.continent.fbm2(wx * 0.00085, wz * 0.00085, 4);
    const base = SEA_LEVEL + cont * 16;
    const mRaw = this.mountain.fbm2(wx * 0.0013 + 17.3, wz * 0.0013 - 45.9, 3) * 0.5 + 0.5;
    let m = clamp((mRaw - 0.52) / 0.30, 0, 1);
    m = m * m * (3 - 2 * m);
    const ridged = this.ridge.ridged2(wx * 0.0042, wz * 0.0042, 4);
    const hills = this.hills.fbm2(wx * 0.012, wz * 0.012, 4) * 3.0;
    const detail = this.detail.fbm2(wx * 0.06, wz * 0.06, 2) * 0.6;
    const mountainH = 78 + ridged * 34;
    const h = base * (1 - m) + mountainH * m + hills + detail;
    return clamp(Math.floor(h), 3, WORLD_H - 12);
  }

  /** Fill one chunk with terrain (no vegetation). */
  generateChunk(chunk) {
    const ox = chunk.cx * CX, oz = chunk.cz * CZ;
    const c = chunk;
    for (let lz = 0; lz < CZ; lz++) {
      for (let lx = 0; lx < CX; lx++) {
        const wx = ox + lx, wz = oz + lz;
        const H = this.heightAt(wx, wz);
        const biome = this.biomeAt(wx, wz, H);
        const colIdx = lz * CX + lx;
        c.biome[colIdx] = biome;
        const [temp, humid] = this.climate(wx, wz);

        // Surface material per biome
        let topBlock = ID.grass, subBlock = ID.dirt, depth = 3;
        switch (biome) {
          case BIOME.OCEAN:
            topBlock = ID.gravel; subBlock = ID.gravel; depth = 1;
            if (H < SEA_LEVEL - 5 && hash2i(wx, wz, this.seed) < 0.4) topBlock = ID.sand, subBlock = ID.sand;
            break;
          case BIOME.BEACH: topBlock = ID.sand; subBlock = ID.sand; depth = 4; break;
          case BIOME.DESERT: topBlock = ID.sand; subBlock = ID.sandstone; depth = 5; break;
          case BIOME.SNOWY: topBlock = ID.snow; subBlock = ID.dirt; depth = 2; break;
          case BIOME.MOUNTAINS:
            if (H > 96) { topBlock = ID.snow; subBlock = ID.stone; depth = 1; }
            else if (H > 84) { topBlock = ID.stone; subBlock = ID.stone; depth = 1; }
            else { topBlock = ID.grass; subBlock = ID.dirt; depth = 2; }
            break;
          case BIOME.JUNGLE: topBlock = ID.grass; subBlock = ID.dirt; depth = 3; break;
          case BIOME.SWAMP: topBlock = ID.grass; subBlock = ID.dirt; depth = 2; break;
          default: topBlock = ID.grass; subBlock = ID.dirt; depth = 3; break;
        }
        // Clay/gravel patches in shallow water, like river beds
        if (H < SEA_LEVEL && H > SEA_LEVEL - 6 && this.soil.n2(wx * 0.05, wz * 0.05) > 0.45) {
          topBlock = ID.clay; subBlock = ID.clay; depth = 2;
        }

        const caveTop = H - 1;
        // Caves must stop below the soil layer. If a tunnel reaches the surface it
        // punches a one-block hole that floods the ground with unlit cave geometry,
        // which reads as black speckles all over the terrain.
        const caveCeiling = Math.min(caveTop, H - Math.max(4, depth + 2));
        for (let y = 0; y <= H; y++) {
          let block;
          if (y === 0) block = ID.bedrock;
          else if (y < 3 && hash3i(wx, y, wz, this.seed) < 1 - y * 0.34) block = ID.bedrock;
          else if (y >= H - depth + 1) {
            block = (y === H) ? topBlock : subBlock;
            if (block === ID.snow && y > H) block = ID.snow;
          } else {
            block = ID.stone;
          }

          // ---- caves: two intersecting worm noises + occasional cheese caverns.
          // Thresholds are kept tight: wide caves triple the triangle count and the
          // surface player never sees them.
          if (block === ID.stone || ((block === ID.dirt || block === ID.grass) && y < H - 1)) {
            if (y > 5 && y < caveCeiling) {
              const n1 = this.cave1.n3(wx * 0.055, y * 0.09, wz * 0.055);
              const n2 = this.cave2.n3(wx * 0.061 + 40, y * 0.10, wz * 0.061 - 40);
              const worm = Math.abs(n1) < 0.058 && Math.abs(n2) < 0.058;
              const cheese = y < 40 && this.cheese.n3(wx * 0.034, y * 0.06, wz * 0.034) > 0.70;
              if (worm || cheese) {
                block = 0;
                if (y < 10 && hash3i(wx, y, wz, this.seed + 77) < 0.5) block = ID.lava;
              }
            }
          }

          // ---- ores
          if (block === ID.stone) {
            const r = hash3i(wx, y, wz, this.seed + 999);
            if (y < 15 && r < 0.0016) block = ID.diamond;
            else if (y < 32 && r < 0.0042) block = ID.gold;
            else if (y < 64 && r < 0.011) block = ID.iron;
            else if (r < 0.020) block = ID.coal;
            else if (r > 0.9955 && y < 70) block = ID.gravel;
          }

          if (block !== 0) c.blocks[(y * CZ + lz) * CX + lx] = block;
        }

        // ---- water / ice fill
        if (H < SEA_LEVEL) {
          for (let y = H + 1; y <= SEA_LEVEL; y++) {
            const idx = (y * CZ + lz) * CX + lx;
            if (c.blocks[idx] !== 0) continue;
            const surface = y === SEA_LEVEL;
            const snowy = (biome === BIOME.SNOWY || temp < 0.28);
            c.blocks[idx] = surface && snowy ? ID.ice : ID.water;
          }
        }

        // ---- height map
        let hi = WORLD_H;
        for (let y = WORLD_H - 1; y >= 0; y--) {
          if (c.blocks[(y * CZ + lz) * CX + lx] !== 0) { hi = y + 1; break; }
        }
        c.heightMap[colIdx] = hi > WORLD_H ? 0 : hi;
      }
    }
    c.generated = true;
    c.dirty = true;
  }

  // --------------------------------------------------------------- decoration
  /**
   * Vegetation pass. Deterministic per chunk; needs up to a 3x3 neighbourhood of
   * generated chunks so trees can cross borders. Returns true when fully applied.
   */
  decorateChunk(chunk, world) {
    // must be idempotent: the caller retries until every neighbour exists, and re-running
    // the vegetation pass would plant a second forest on top of the first
    if (!chunk.generated || chunk.decorated) return !!chunk.decorated;
    const n = world.getChunkRaw(chunk.cx - 1, chunk.cz - 1) && world.getChunkRaw(chunk.cx, chunk.cz - 1) &&
      world.getChunkRaw(chunk.cx + 1, chunk.cz - 1) && world.getChunkRaw(chunk.cx - 1, chunk.cz) &&
      world.getChunkRaw(chunk.cx + 1, chunk.cz) && world.getChunkRaw(chunk.cx - 1, chunk.cz + 1) &&
      world.getChunkRaw(chunk.cx, chunk.cz + 1) && world.getChunkRaw(chunk.cx + 1, chunk.cz + 1);
    if (!n) return false;

    const rng = makeRng((this.seed ^ (chunk.cx * 73856093) ^ (chunk.cz * 19349663)) | 0);
    const c = chunk;
    const setWorld = (wx, wy, wz, v) => world.setBlockAt(wx, wy, wz, v, true);
    const getWorld = (wx, wy, wz) => world.getBlockRaw(wx, wy, wz);

    // pick a dominant biome by sampling the chunk centre
    const midBiome = c.biome[(CZ >> 1) * CX + (CX >> 1)];

    const treeChance = {
      [BIOME.FOREST]: 0.42, [BIOME.PLAINS]: 0.035, [BIOME.TAIGA]: 0.34, [BIOME.SNOWY]: 0.10,
      [BIOME.JUNGLE]: 0.72, [BIOME.SWAMP]: 0.12, [BIOME.SAVANNA]: 0.05,
      [BIOME.MOUNTAINS]: 0.03, [BIOME.DESERT]: 0, [BIOME.OCEAN]: 0, [BIOME.BEACH]: 0,
    }[midBiome] ?? 0.05;

    const treeCount = Math.round(treeChance * 40);
    for (let i = 0; i < treeCount; i++) {
      const lx = (rng() * CX) | 0, lz = (rng() * CZ) | 0;
      const wx = c.cx * CX + lx, wz = c.cz * CZ + lz;
      const surface = this.surfaceStandable(c, lx, lz);
      if (surface < 0) continue;
      const biome = this.biomeAt(wx, wz, surface);
      const y = surface + 1;
      const ground = getWorld(wx, surface, wz);
      if (ground !== ID.grass && ground !== ID.snow && ground !== ID.sand) continue;
      if (biome === BIOME.DESERT) {
        if (rng() < 0.5) this.placeCactus(setWorld, getWorld, wx, y, wz, rng);
        continue;
      }
      const kind = biome === BIOME.TAIGA || biome === BIOME.SNOWY ? 'spruce'
        : biome === BIOME.JUNGLE ? 'jungle'
          : (rng() < 0.12 ? 'birch' : 'oak');
      this.placeTree(setWorld, getWorld, wx, y, wz, kind, rng);
    }

    // ground cover: flowers, pumpkins
    for (let i = 0; i < 26; i++) {
      const lx = (rng() * CX) | 0, lz = (rng() * CZ) | 0;
      const surface = this.surfaceStandable(c, lx, lz);
      if (surface < 0) continue;
      const wx = c.cx * CX + lx, wz = c.cz * CZ + lz;
      if (getWorld(wx, surface, wz) !== ID.grass) continue;
      if (getWorld(wx, surface + 1, wz) !== 0) continue;
      const r = rng();
      if (r < 0.55) setWorld(wx, surface + 1, wz, ID.flower);
      else if (r < 0.60 && midBiome === BIOME.PLAINS) setWorld(wx, surface + 1, wz, ID.pumpkin);
    }

    // buildings and dungeons go in last so they overwrite vegetation cleanly
    this.placeStructures(c, world, setWorld, getWorld);
    if (this.lootDrops && this.lootDrops.length) {
      world.structureLoot = world.structureLoot || [];
      world.structureLoot.push(...this.lootDrops);
      this.lootDrops = [];
    }

    c.decorated = true;
    return true;
  }

  // ------------------------------------------------------------------ structures
  /**
   * Candidate structures for one chunk.
   *
   * Structures are a pure function of the chunk coordinate, so a big structure (a house
   * straddling four chunks) is discovered by every chunk inside its footprint and each
   * one writes the part that lands in it. No global list and no load-order dependency.
   */
  structureCandidates(cx, cz) {
    const rng = makeRng((this.seed ^ (cx * 0x9e3779b1) ^ (cz * 0x85ebca6b)) | 0);
    const list = [];
    const roll = rng();
    if (roll < 0.10) list.push({ type: 'ruin_house', cx, cz, rng: makeRng((this.seed + cx * 31 + cz * 17) | 0) });
    else if (roll < 0.20) list.push({ type: 'village_house', cx, cz, rng: makeRng((this.seed + cx * 71 + cz * 53) | 0) });
    else if (roll < 0.30) list.push({ type: 'well', cx, cz, rng: makeRng((this.seed + cx * 13 + cz * 29) | 0) });
    else if (roll < 0.38) list.push({ type: 'dungeon', cx, cz, rng: makeRng((this.seed + cx * 97 + cz * 11) | 0) });
    else if (roll < 0.44) list.push({ type: 'mineshaft', cx, cz, rng: makeRng((this.seed + cx * 41 + cz * 89) | 0) });
    return list;
  }

  /** Build every candidate structure that overlaps this chunk. */
  placeStructures(chunk, world, setWorld, getWorld) {
    for (const cand of this.structureCandidates(chunk.cx, chunk.cz)) {
      if (!this.structureFits(cand, world)) continue;
      this.buildStructure(cand, world, setWorld, getWorld);
    }
  }

  /** How many chunks around the anchor a structure needs loaded before it can be placed. */
  structureMargin(type) {
    switch (type) {
      case 'dungeon': return 1;
      case 'well': return 1;
      case 'mineshaft': return 1;
      case 'ruin_house': return 1;
      case 'village_house': return 1;
      default: return 1;
    }
  }

  /** All chunks within the margin of the anchor must exist, or the build waits. */
  structureFits(cand, world) {
    const m = this.structureMargin(cand.type);
    for (let dz = -m; dz <= m; dz++) {
      for (let dx = -m; dx <= m; dx++) {
        if (!world.getChunkRaw(cand.cx + dx, cand.cz + dz)) return false;
      }
    }
    return true;
  }

  /** Surface height of the anchor column, or -1 when the site is unsuitable. */
  siteGround(cand, world) {
    const wx = cand.cx * CX + 8, wz = cand.cz * CZ + 8;
    let h = -1;
    for (let y = WORLD_H - 1; y > 1; y--) {
      if (world.getBlockRaw(wx, y, wz) !== 0) { h = y; break; }
    }
    if (h < 0) return -1;
    const ground = world.getBlockRaw(wx, h, wz);
    const biome = world.biomeAt(wx, wz);
    return { x: wx, y: h, z: wz, ground, biome, height: h };
  }

  buildStructure(cand, world, setWorld, getWorld) {
    const site = this.siteGround(cand, world);
    if (!site || site.height <= SEA_LEVEL) return;         // never build underwater
    const r = cand.rng;
    switch (cand.type) {
      case 'ruin_house': this.buildRuinHouse(site, world, setWorld, getWorld, r, cand); break;
      case 'village_house': this.buildVillageHouse(site, world, setWorld, getWorld, r, cand); break;
      case 'well': this.buildWell(site, setWorld, getWorld, r); break;
      case 'dungeon': this.buildDungeon(site, world, setWorld, getWorld, r, cand); break;
      case 'mineshaft': this.buildMineshaft(site, world, setWorld, getWorld, r, cand); break;
      default: break;
    }
  }

  /** Small cobble/plank hut with a gap in the roof and a loot chest. */
  buildRuinHouse(site, world, setWorld, getWorld, rng, cand) {
    const w = 7, d = 7, h = 4;
    const ox = site.x - 3, oz = site.z - 3;
    const baseY = site.y;
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const wx = ox + x, wz = oz + z;
        // flatten the floor
        setWorld(wx, baseY, wz, ID.cobble);
        for (let y = 1; y <= h; y++) setWorld(wx, baseY + y, wz, 0);
        const edge = x === 0 || z === 0 || x === w - 1 || z === d - 1;
        if (!edge) continue;
        // walls, with random gaps so it reads as a ruin
        for (let y = 1; y <= 3; y++) {
          if (rng() < 0.22) continue;
          const block = rng() < 0.7 ? ID.cobble : ID.planks;
          setWorld(wx, baseY + y, wz, block);
        }
      }
    }
    // partial roof
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        if (rng() < 0.35) continue;
        setWorld(ox + x, baseY + h, oz + z, ID.planks);
      }
    }
    // loot chest in a corner
    const chestX = ox + 1 + ((rng() * (w - 2)) | 0);
    const chestZ = oz + 1 + ((rng() * (d - 2)) | 0);
    setWorld(chestX, baseY + 1, chestZ, ID.chest);
    this.markChest(world, chestX, baseY + 1, chestZ, 'ruin');
  }

  /** Intact-ish village house: plank walls, glass windows, stone floor, chest. */
  buildVillageHouse(site, world, setWorld, getWorld, rng, cand) {
    const w = 9, d = 7, h = 4;
    const ox = site.x - 4, oz = site.z - 3;
    const baseY = site.y;
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const wx = ox + x, wz = oz + z;
        setWorld(wx, baseY, wz, ID.cobble);
        for (let y = 1; y <= h + 2; y++) setWorld(wx, baseY + y, wz, 0);
        const edge = x === 0 || z === 0 || x === w - 1 || z === d - 1;
        if (!edge) continue;
        for (let y = 1; y <= 3; y++) {
          // window band, plus a doorway
          const isWindow = y === 2 && (x % 4 === 2 || z % 4 === 2);
          const isDoor = y <= 2 && z === d - 1 && x === (w >> 1);
          if (isDoor) { setWorld(wx, baseY + y, wz, 0); continue; }
          setWorld(wx, baseY + y, wz, isWindow ? ID.glass : ID.planks);
        }
      }
    }
    // roof
    for (let x = -1; x <= w; x++) {
      for (let z = -1; z <= d; z++) setWorld(ox + x, baseY + h, oz + z, ID.cobble);
    }
    // a chest and a crafting table inside
    const inX = ox + 2, inZ = oz + 2;
    setWorld(inX, baseY + 1, inZ, ID.chest);
    this.markChest(world, inX, baseY + 1, inZ, 'house');
    setWorld(ox + w - 3, baseY + 1, oz + 2, ID.craft);
    setWorld(ox + w - 3, baseY + 2, oz + 2, ID.torch);
  }

  /** Desert / plains well: a cobble ring around a water column. */
  buildWell(site, setWorld, getWorld, rng) {
    const baseY = site.y;
    const ox = site.x, oz = site.z;
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        const edge = Math.abs(x) === 2 || Math.abs(z) === 2;
        for (let y = 0; y <= 3; y++) setWorld(ox + x, baseY + y, oz + z, 0);
        setWorld(ox + x, baseY, oz + z, ID.cobble);
        if (edge) setWorld(ox + x, baseY + 1, oz + z, ID.cobble);
        else setWorld(ox + x, baseY - 1, oz + z, ID.water);
      }
    }
    // two corner posts with torches
    for (const [dx, dz] of [[-2, -2], [2, 2]]) {
      for (let y = 1; y <= 4; y++) setWorld(ox + dx, baseY + y, oz + dz, ID.cobble);
      setWorld(ox + dx, baseY + 5, oz + dz, ID.torch);
    }
  }

  /** Cobblestone room buried under the surface, with a spawner-ish glowstone and loot. */
  buildDungeon(site, world, setWorld, getWorld, rng, cand) {
    const y = Math.max(12, site.y - 12 - ((rng() * 10) | 0));
    const w = 7, d = 7, h = 4;
    const ox = site.x - 3, oz = site.z - 3;
    // carve the room
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        for (let yy = 0; yy < h; yy++) setWorld(ox + x, y + yy, oz + z, 0);
      }
    }
    // shell of cobblestone
    for (let x = -1; x <= w; x++) {
      for (let z = -1; z <= d; z++) {
        for (let yy = -1; yy <= h; yy++) {
          const shell = x === -1 || z === -1 || x === w || z === d || yy === -1 || yy === h;
          if (!shell) continue;
          setWorld(ox + x, y + yy, oz + z, ID.cobble);
        }
      }
    }
    // mossy patches + lighting
    for (let i = 0; i < 22; i++) {
      const x = ox + ((rng() * w) | 0), z = oz + ((rng() * d) | 0);
      if (rng() < 0.4) setWorld(x, y + h - 1, z, 0);
      if (rng() < 0.5) setWorld(x, y, z, ID.cobble);
    }
    setWorld(ox + 3, y + h - 1, oz + 3, ID.glowstone);
    // two loot chests on opposite sides
    const spots = [[ox + 1, oz + 1], [ox + w - 2, oz + d - 2]];
    for (const [cx2, cz2] of spots) {
      setWorld(cx2, y, cz2, ID.chest);
      this.markChest(world, cx2, y, cz2, 'dungeon');
    }
    // a short corridor out so it can be found from a cave
    const dir = (rng() * 4) | 0;
    const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    for (let i = 1; i <= 6; i++) {
      const px = dir === 0 ? ox + w + i : dir === 1 ? ox - i : ox + 3;
      const pz = dir === 2 ? oz + d + i : dir === 3 ? oz - i : oz + 3;
      for (let yy = -1; yy <= 2; yy++) setWorld(px, y + yy, pz, 0);
    }
  }

  /** Wooden support frame over a shaft, with a ladder down into the dark. */
  buildMineshaft(site, world, setWorld, getWorld, rng, cand) {
    const baseY = site.y;
    const x = site.x, z = site.z;
    const depth = Math.min(14, 8 + ((rng() * 8) | 0));
    // clear the shaft and line it
    for (let y = baseY; y > baseY - depth; y--) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const edge = Math.abs(dx) === 1 && Math.abs(dz) === 1;
          if (edge) { setWorld(x + dx, y, z + dz, ID.cobble); continue; }
          setWorld(x + dx, y, z + dz, 0);
        }
      }
      if (y % 5 === 0) {
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
          setWorld(x + dx, y, z + dz, ID.planks);
        }
      }
      setWorld(x, y, z + 1, ID.log);           // support post
    }
    // ladder down one side
    for (let y = baseY - 1; y > baseY - depth; y--) setWorld(x, y, z, 0);
    // head frame above ground
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      for (let y = baseY + 1; y <= baseY + 3; y++) setWorld(x + dx, y, z + dz, ID.log);
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) setWorld(x + dx, baseY + 4, z + dz, ID.planks);
    // a chest of supplies at the bottom
    setWorld(x + 1, baseY - depth + 1, z + 1, ID.chest);
    this.markChest(world, x + 1, baseY - depth + 1, z + 1, 'mineshaft');
  }

  /**
   * The loot that belongs in a structure chest, as a pure function of its position.
   * The game layer calls this the first time a chest is opened, so no global structure
   * list is needed and the result is identical on every run and every reload.
   */
  lootFor(x, y, z, rng, theme) {
    const rolls = [];
    const table = this.lootTable(theme);
    const count = table.min + ((rng() * (table.max - table.min + 1)) | 0);
    for (let i = 0; i < count; i++) {
      const entry = table.entries[(rng() * table.entries.length) | 0];
      const n = entry.min + ((rng() * (entry.max - entry.min + 1)) | 0);
      rolls.push(entry.block !== undefined ? { id: entry.block, count: n } : { itemKey: entry.item, count: n });
    }
    return rolls;
  }

  /** Stable RNG for a chest position (so the same chest always holds the same loot). */
  lootRng(x, y, z, theme) {
    let h = this.seed | 0;
    h = Math.imul(h ^ x, 0x9e3779b1);
    h = Math.imul(h ^ y, 0x85ebca6b);
    h = Math.imul(h ^ z, 0xc2b2ae35);
    for (let i = 0; i < theme.length; i++) h = Math.imul(h ^ theme.charCodeAt(i), 16777619);
    return makeRng(h | 0);
  }

  /** Record that a structure chest exists here and which loot table it draws from. */
  markChest(world, x, y, z, theme) {
    if (!world.structureChests) world.structureChests = new Map();
    world.structureChests.set(x + ',' + y + ',' + z, theme);
  }

  /** Loot tables: `block` entries are numeric ids, `item` entries are item keys. */
  lootTable(theme) {
    const B = (key) => ID[key] || 0;
    const T = {
      ruin: { min: 2, max: 4, entries: [
        { block: B('planks'), min: 4, max: 12 }, { block: B('cobble'), min: 4, max: 16 },
        { item: 'bread', min: 1, max: 3 }, { item: 'stick', min: 2, max: 6 },
      ] },
      house: { min: 3, max: 5, entries: [
        { block: B('planks'), min: 8, max: 24 }, { item: 'bread', min: 1, max: 5 },
        { block: B('torch'), min: 2, max: 8 }, { block: B('glass'), min: 2, max: 6 },
        { item: 'wood_pickaxe', min: 1, max: 1 },
      ] },
      dungeon: { min: 3, max: 6, entries: [
        { item: 'iron_ingot', min: 1, max: 4 }, { item: 'gold_ingot', min: 1, max: 3 },
        { item: 'diamond', min: 1, max: 2 }, { item: 'bread', min: 2, max: 5 },
        { item: 'arrow', min: 4, max: 12 }, { item: 'iron_chestplate', min: 1, max: 1 },
      ] },
      mineshaft: { min: 3, max: 5, entries: [
        { item: 'iron_ingot', min: 1, max: 3 }, { item: 'coal', min: 4, max: 12 },
        { block: B('torch'), min: 4, max: 12 }, { item: 'arrow', min: 2, max: 8 },
      ] },
    };
    return T[theme] || T.ruin;
  }

  /** Surface Y of the top solid block, or -1 if the column is underwater/unsuitable. */
  surfaceStandable(chunk, lx, lz) {
    let y = WORLD_H - 1;
    while (y > 0 && chunk.blocks[(y * CZ + lz) * CX + lx] === 0) y--;
    if (y <= SEA_LEVEL) return -1;                     // underwater: no land vegetation
    return y;
  }

  placeTree(setWorld, getWorld, wx, y, wz, kind, rng) {
    const logId = ID.log;
    if (kind === 'spruce') {
      const h = 6 + ((rng() * 5) | 0);
      for (let i = 0; i < h; i++) setWorld(wx, y + i, wz, logId);
      let radius = 1;
      for (let level = h - 1; level >= 2; level--) {
        const fromTop = h - 1 - level;
        radius = fromTop % 2 === 0 ? 2 : 1;
        if (fromTop < 1) radius = 1;
        for (let dx = -radius; dx <= radius; dx++) {
          for (let dz = -radius; dz <= radius; dz++) {
            if (Math.abs(dx) === radius && Math.abs(dz) === radius && radius > 1) continue;
            if (dx === 0 && dz === 0 && level < h - 1) continue;
            if (getWorld(wx + dx, y + level, wz + dz) === 0) setWorld(wx + dx, y + level, wz + dz, ID.leaves);
          }
        }
      }
      setWorld(wx, y + h, wz, ID.leaves);
      setWorld(wx, y + h + 1, wz, ID.leaves);
      return;
    }
    const h = kind === 'jungle' ? 10 + ((rng() * 8) | 0) : kind === 'birch' ? 6 + ((rng() * 3) | 0) : 4 + ((rng() * 3) | 0);
    for (let i = 0; i < h; i++) setWorld(wx, y + i, wz, logId);
    const top = y + h - 1;
    if (kind === 'jungle') {
      for (let level = 0; level < 3; level++) {
        const r = 3 - level;
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            if (dx * dx + dz * dz > r * r + 1) continue;
            const yy = top + level;
            if (getWorld(wx + dx, yy, wz + dz) === 0) setWorld(wx + dx, yy, wz + dz, ID.leaves);
          }
        }
      }
      // (jungle trunks rising through the canopy feel right without vines)
      return;
    }
    // oak / birch: canopy blob
    for (let dy = -2; dy <= 1; dy++) {
      const r = dy >= 1 ? 1 : (dy === -2 ? 2 : 2);
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (Math.abs(dx) === r && Math.abs(dz) === r && (r > 1 && dy === -2)) continue;
          const yy = top + dy;
          if (getWorld(wx + dx, yy, wz + dz) === 0) setWorld(wx + dx, yy, wz + dz, ID.leaves);
        }
      }
    }
    setWorld(wx, top + 2, wz, ID.leaves);
  }

  /** Straight desert column. */
  placeCactus(setWorld, getWorld, wx, y, wz, rng) {
    const h = 2 + ((rng() * 3) | 0);
    for (let i = 0; i < h; i++) setWorld(wx, y + i, wz, ID.log);
  }

  /** Rough spawn height search: first land column near origin. */
  findSpawn(world) {
    const rng = makeRng(this.seed + 4242);
    for (let r = 0; r < 400; r++) {
      const a = rng() * Math.PI * 2;
      const d = 8 + r * 0.6;
      const wx = Math.round(Math.cos(a) * d), wz = Math.round(Math.sin(a) * d);
      const h = this.heightAt(wx, wz);
      if (h > SEA_LEVEL + 1 && h < 92) return { x: wx + 0.5, y: h + 3, z: wz + 0.5 };
    }
    return { x: 0.5, y: SEA_LEVEL + 8, z: 0.5 };
  }
}
