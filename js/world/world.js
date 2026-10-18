// world/world.js — chunk manager: streaming, generation queue, lighting, block edits.
//
// Generation is time-sliced so the frame loop never stalls: each frame we spend a small
// budget on chunk generation / lighting / decoration / meshing, prioritised by distance
// to the player. Blocks edits mark the affected chunk (plus neighbours when they touch a
// border) dirty so only a few chunks remesh per edit.
import { Chunk, CX, CZ, WORLD_H, SEA_LEVEL, BIOME, BIOME_NAMES } from './chunk.js';
import { WorldGen } from './worldgen.js';
import { lightChunk } from './lighting.js';
import { ChunkMesher } from './mesher.js';
import { recompute, powerAt, tickRepeaters } from './redstone.js';
import { OPAQUE, SOLID, LIQUID, LIGHT, baseId, idOf, BLOCKS, ItemStack, stackLimit } from '../core/blocks.js';

export const VIEW_DISTANCE_DEFAULT = 8;

export class World {
  constructor(seed = 1337, opts = {}) {
    this.seed = seed;
    /** 'overworld' | 'nether' — the generator and a few rules depend on it. */
    this.dimension = opts.dimension || 'overworld';
    this.gen = opts.gen || new WorldGen(seed);
    this.chunks = new Map();
    this.mesher = new ChunkMesher(this);
    this.viewDistance = opts.viewDistance ?? VIEW_DISTANCE_DEFAULT;
    this.generationBudgetMs = opts.generationBudgetMs ?? 6;
    this.renderDistanceChunks = this.viewDistance;
    this.pendingDecorate = new Set();
    this.remeshQueue = [];
    this.lightQueue = [];
    this.stats = {
      generated: 0, lit: 0, decorated: 0, meshed: 0,
      meshQueue: 0, lastMeshMs: 0, lastGenMs: 0, chunks: 0,
    };
    this.readOnly = false;   // set while the decorator writes across chunk borders
    this.editLog = new Map(); // "x,y,z" -> block id, for save files
    /** Chest contents, keyed by "x,y,z". Plain arrays of ItemStack, saved with the world. */
    this.containers = new Map();
    /** Structure chest positions -> loot theme, filled in by world generation. */
    this.structureChests = new Map();
    /** Lever / button / plate state, keyed "x,y,z". */
    this.rsState = new Map();
    /** Wire strength 0..15, keyed "x,y,z". */
    this.rsPower = new Map();
    /** Positions of placed hoppers, ticked on a slow cadence. */
    this.hopperPositions = new Set();
    /** Positions of placed repeaters, ticked every frame for their delay. */
    this.repeaters = new Set();
    /** (roll) => stack id, installed by the game layer so items resolve correctly. */
    this.lootResolver = null;
    this._key = (cx, cz) => cx * 8192 + cz;
  }

  // ------------------------------------------------------------------ containers
  /**
   * A generic container by position. Chests, hoppers and dispensers all use a plain
   * 27-slot array, so the same UI and the same transfer code serve all of them.
   * `kind` is only used to decide the slot count and whether loot is rolled.
   */
  containerAt(kind, x, y, z, create = true) {
    const key = kind + ':' + x + ',' + y + ',' + z;
    let c = this.containers.get(key);
    if (!c && create) {
      c = new Array(kind === 'chest' ? 27 : 9).fill(null);
      this.containers.set(key, c);
      if (kind === 'chest') this.fillStructureLoot(c, x, y, z);
    }
    return c || null;
  }

  containerKey(x, y, z) { return x + ',' + y + ',' + z; }

  /**
   * Move one item stack from `from` to `to`, merging into partial stacks first and then
   * using an empty slot. Returns the number of items actually moved.
   */
  moveStack(from, to, maxCount = Infinity) {
    if (!from || !to) return 0;
    for (let i = 0; i < from.length; i++) {
      const s = from[i];
      if (!s || s.count <= 0) continue;
      const limit = stackLimit(s.id);
      let left = Math.min(s.count, maxCount);
      let moved = 0;
      // 1. top up existing stacks
      for (let j = 0; j < to.length && left > 0; j++) {
        const d = to[j];
        if (!d || d.id !== s.id || d.count >= limit) continue;
        const take = Math.min(limit - d.count, left);
        d.count += take; left -= take; moved += take;
      }
      // 2. then an empty slot
      if (left > 0) {
        const empty = to.indexOf(null);
        if (empty >= 0) {
          to[empty] = new ItemStack(s.id, left, s.durability ?? null, s.ench ? { ...s.ench } : null);
          moved += left; left = 0;
        }
      }
      if (moved > 0) {
        s.count -= moved;
        if (s.count <= 0) from[i] = null;
        return moved;
      }
    }
    return 0;
  }

  /**
   * Hoppers: pull one item from the container above, push one item into whatever the
   * spout faces. A hopper that is powered by redstone freezes, exactly like Minecraft.
   * Runs on a 0.4s cadence so a big farm cannot tank the frame rate.
   */
  tickHoppers(dt, chunks) {
    this.hopperAccum = (this.hopperAccum || 0) + dt;
    if (this.hopperAccum < 0.4) return;
    this.hopperAccum = 0;
    if (!this.hopperPositions) return;
    for (const key of this.hopperPositions) {
      const [x, y, z] = key.split(',').map(Number);
      const id = baseId(this.getBlockRaw(x, y, z));
      if (id !== idOf('hopper')) { this.hopperPositions.delete(key); continue; }
      // a powered hopper does nothing. This has to ask the redstone network rather than
      // the wire map, because a redstone block beside the hopper emits without any wire.
      if (powerAt(this, x, y, z) > 0) continue;
      const self = this.containerAt('hopper', x, y, z, true);
      // 1. push into the facing direction
      const facing = this.getFacing(x, y, z) & 7;
      const dir = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]][facing] || [0, -1, 0];
      const tx = x + dir[0], ty = y + dir[1], tz = z + dir[2];
      const target = this.containerUnder(tx, ty, tz);
      if (target) {
        const moved = this.moveStack(self, target, 1);
        if (moved > 0) { this.markDirty(x >> 4, z >> 4); continue; }
      }
      // 2. otherwise pull one item from the container above
      const above = this.containerUnder(x, y + 1, z);
      if (above) {
        const moved = this.moveStack(above, self, 1);
        if (moved > 0) {
          this.markDirty(x >> 4, z >> 4);
          this.markDirty((x >> 4), (z >> 4));
        }
      }
    }
    void chunks;
  }

  /** The container a position holds, if the block there is a container. */
  containerUnder(x, y, z) {
    const id = baseId(this.getBlockRaw(x, y, z));
    if (id === idOf('chest')) return this.containerAt('chest', x, y, z, true);
    if (id === idOf('hopper')) return this.containerAt('hopper', x, y, z, true);
    if (id === idOf('dispenser')) return this.containerAt('dispenser', x, y, z, true);
    return null;
  }

  /** Register a hopper so the transfer tick knows about it. */
  addHopper(x, y, z) {
    if (!this.hopperPositions) this.hopperPositions = new Set();
    this.hopperPositions.add(x + ',' + y + ',' + z);
  }

  /** Scan loaded chunks for hoppers, so hoppers in a loaded save resume working. */
  rescanHoppers() {
    this.hopperPositions = this.hopperPositions || new Set();
    for (const c of this.chunks.values()) {
      if (!c.generated) continue;
      for (let y = 0; y < WORLD_H; y++) {
        for (let lz = 0; lz < CZ; lz++) {
          for (let lx = 0; lx < CX; lx++) {
            if (baseId(c.blocks[(y * CZ + lz) * CX + lx]) === idOf('hopper')) {
              this.hopperPositions.add((c.cx * CX + lx) + ',' + y + ',' + (c.cz * CZ + lz));
            }
          }
        }
      }
    }
    return this.hopperPositions.size;
  }

  // ------------------------------------------------------------------ redstone
  /** Per-position state for levers, buttons and pressure plates, keyed "x,y,z". */
  redstoneState(x, y, z) {
    const k = x + ',' + y + ',' + z;
    let s = this.rsState.get(k);
    if (!s) { s = { leverOn: false, buttonUntil: 0, plateOn: false }; this.rsState.set(k, s); }
    return s;
  }

  /**
   * Redstone wire strength (0..15). It gets its own map rather than riding in the chunk's
   * facing byte, which is only 3 bits wide and would silently truncate anything above 7.
   */
  getPower(x, y, z) { return this.rsPower.get(x + ',' + y + ',' + z) || 0; }

  setPower(x, y, z, level) {
    const k = x + ',' + y + ',' + z;
    const v = Math.max(0, Math.min(15, level | 0));
    if (v === 0) this.rsPower.delete(k); else this.rsPower.set(k, v);
  }

  /** Toggle a lever and recompute the circuit it belongs to. */
  toggleLever(x, y, z) {
    const s = this.redstoneState(x, y, z);
    s.leverOn = !s.leverOn;
    this.recomputeRedstone(x, y, z);
    return s.leverOn;
  }

  /** Press a button: powered for `seconds`, then it pops back out. */
  pressButton(x, y, z, seconds = 1.2) {
    const s = this.redstoneState(x, y, z);
    s.buttonUntil = seconds;
    this.recomputeRedstone(x, y, z);
  }

  setPlate(x, y, z, on) {
    const s = this.redstoneState(x, y, z);
    if (s.plateOn === on) return;
    s.plateOn = on;
    this.recomputeRedstone(x, y, z);
  }

  recomputeRedstone(x, y, z) { recompute(this, x, y, z); }

  /** Advance repeater delays; called every frame. */
  tickRepeaters(dt) { tickRepeaters(this, dt); }

  /** Tick button timers and pressure plates near the entities that can trigger them. */
  tickRedstone(dt, players) {
    for (const [k, s] of this.rsState) {
      if (s.buttonUntil > 0) {
        s.buttonUntil -= dt;
        if (s.buttonUntil <= 0) {
          s.buttonUntil = 0;
          const [x, y, z] = k.split(',').map(Number);
          if (baseId(this.getBlockRaw(x, y, z)) === idOf('stone_button')) this.recomputeRedstone(x, y, z);
        }
      }
    }
    this.plateTimer = (this.plateTimer || 0) + dt;
    if (this.plateTimer < 0.15) return;
    this.plateTimer = 0;
    // any entity standing on a plate powers it
    for (const p of players) {
      const px = Math.floor(p.x), py = Math.floor(p.y - 0.1), pz = Math.floor(p.z);
      const id = baseId(this.getBlockRaw(px, py, pz));
      if (id !== idOf('pressure_plate')) continue;
      this.setPlate(px, py, pz, true);
      this.plateRelease = this.plateRelease || new Map();
      this.plateRelease.set(px + ',' + py + ',' + pz, 0.4);
    }
    if (this.plateRelease) {
      for (const [k, left] of this.plateRelease) {
        const remain = left - 0.15;
        if (remain <= 0) {
          const [x, y, z] = k.split(',').map(Number);
          this.setPlate(x, y, z, false);
          this.plateRelease.delete(k);
        } else {
          this.plateRelease.set(k, remain);
        }
      }
    }
  }

  /**
   * The 27-slot storage of the chest at this position, created on first use.
   * Structure chests are seeded with their loot table's roll on first open — the roll is
   * a pure function of the position and the world seed, so it never changes between runs.
   * A player-placed chest simply starts empty.
   */
  chestAt(x, y, z, create = true) { return this.containerAt('chest', x, y, z, create); }

  fillStructureLoot(slots, x, y, z) {
    const theme = this.structureChests ? this.structureChests.get(this.containerKey(x, y, z)) : null;
    if (!theme || !this.lootResolver) return;
    const gen = this.gen;
    const rng = gen.lootRng(x, y, z, theme);
    const rolls = gen.lootFor(x, y, z, rng, theme);
    // spread the stacks over the chest instead of stacking them in slot order
    const free = [];
    for (let i = 0; i < slots.length; i++) free.push(i);
    for (const roll of rolls) {
      if (!free.length) break;
      const pick = (rng() * free.length) | 0;
      const slot = free.splice(pick, 1)[0];
      const id = this.lootResolver(roll);
      if (!id) continue;
      slots[slot] = new ItemStack(id, roll.count, null);
    }
  }

  serializeContainers() {
    const out = {};
    for (const [key, slots] of this.containers) {
      const packed = slots.map((s) => (s ? [s.id, s.count, s.durability ?? null] : null));
      if (packed.some(Boolean)) out[key] = packed;
    }
    return out;
  }

  loadContainers(data) {
    this.containers.clear();
    if (!data) return;
    for (const key of Object.keys(data)) {
      const packed = data[key];
      this.containers.set(key, packed.map((s) => (s ? new ItemStack(s[0], s[1], s[2] ?? null) : null)));
    }
  }

  /** Apply a saved edit log (from localStorage) and remesh what changed. */
  loadEdits(edits) {
    this.editLog = new Map();
    const dirty = new Set();
    for (const key of Object.keys(edits || {})) {
      const [x, y, z] = key.split(',').map(Number);
      const id = edits[key] | 0;
      this.setBlockAt(x, y, z, id, true);
      this.editLog.set(key, id);
      dirty.add((x >> 4) + ',' + (z >> 4));
    }
    for (const k of dirty) {
      const [cx, cz] = k.split(',').map(Number);
      this.relight(cx, cz);
      this.markDirty(cx, cz);
    }
  }

  /** Force a light recompute for one chunk (helper for the loading screen). */
  remeshLight(chunk) {
    lightChunk(chunk, this);
  }

  // ------------------------------------------------------------------ chunk access
  getChunkRaw(cx, cz) {
    return this.chunks.get(this._key(cx, cz));
  }

  /** Fetch a chunk, generating terrain data if it does not exist yet. */
  ensureChunk(cx, cz) {
    const key = this._key(cx, cz);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(cx, cz);
      this.chunks.set(key, c);
      this.gen.generateChunk(c);
      this.stats.generated++;
      this.pendingDecorate.add(c);
      this.markDirty(cx, cz);
    }
    return c;
  }

  getBlockRaw(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return wy < 0 ? 1 : 0;
    const cx = wx >> 4, cz = wz >> 4;
    const c = this.chunks.get(this._key(cx, cz));
    if (!c) return 0;
    return c.blocks[(wy * CZ + (wz - (cz << 4))) * CX + (wx - (cx << 4))];
  }

  getBlock(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return wy < 0 ? 1 : 0;
    return this.getBlockRaw(wx | 0, wy | 0, wz | 0);
  }

  isSolidAt(wx, wy, wz) {
    if (wy < 0) return true;
    if (wy >= WORLD_H) return false;
    return SOLID[baseId(this.getBlockRaw(wx, wy, wz))] === 1;
  }

  isLiquidAt(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return false;
    return LIQUID[baseId(this.getBlockRaw(wx, wy, wz))] === 1;
  }

  biomeAt(wx, wz) {
    const c = this.chunks.get(this._key(wx >> 4, wz >> 4));
    if (!c) {
      if (typeof this.gen.biomeAt === 'function') return this.gen.biomeAt(wx, wz, this.gen.heightAt(wx, wz));
      return 1;
    }
    return c.biome[(wz & 15) * CX + (wx & 15)];
  }

  biomeNameAt(wx, wz) {
    if (this.dimension === 'nether') return '下界';
    return BIOME_NAMES[this.biomeAt(wx, wz)] || '未知';
  }

  // ------------------------------------------------------------------ edits
  /**
   * Write a block. `internal` is used by world generation and skips neighbour relight.
   * Returns true when the write landed inside a loaded chunk.
   */
  setBlockAt(wx, wy, wz, id, internal = false) {
    if (wy < 0 || wy >= WORLD_H) return false;
    const cx = wx >> 4, cz = wz >> 4;
    const c = this.chunks.get(this._key(cx, cz));
    if (!c) return false;
    const lx = wx - (cx << 4), lz = wz - (cz << 4);
    const prev = c.blocks[(wy * CZ + lz) * CX + lx];
    if (prev === id) return true;
    c.set(lx, wy, lz, id);
    if (id === 0) c.setFacing(lx, wy, lz, 0);
    const lx0 = lx, lz0 = lz;
    this.markDirty(cx, cz);
    // a border edit changes what the neighbour must draw, and light can now leak across
    if (lx0 === 0) this.markDirty(cx - 1, cz);
    if (lx0 === CX - 1) this.markDirty(cx + 1, cz);
    if (lz0 === 0) this.markDirty(cx, cz - 1);
    if (lz0 === CZ - 1) this.markDirty(cx, cz + 1);
    if (lx0 === 0 && lz0 === 0) this.markDirty(cx - 1, cz - 1);
    if (lx0 === CX - 1 && lz0 === 0) this.markDirty(cx + 1, cz - 1);
    if (lx0 === 0 && lz0 === CZ - 1) this.markDirty(cx - 1, cz + 1);
    if (lx0 === CX - 1 && lz0 === CZ - 1) this.markDirty(cx + 1, cz + 1);

    if (!internal) {
      // keep the hopper tick list in sync as blocks are placed and broken
      const nowId = baseId(id);
      if (nowId === idOf('hopper')) this.addHopper(wx, wy, wz);
      else if (prev && baseId(prev) === idOf('hopper')) this.hopperPositions.delete(wx + ',' + wy + ',' + wz);
      if (nowId === idOf('repeater')) this.repeaters.add(wx + ',' + wy + ',' + wz);
      else if (prev && baseId(prev) === idOf('repeater')) this.repeaters.delete(wx + ',' + wy + ',' + wz);
      const wasOpaque = OPAQUE[baseId(prev)], nowOpaque = OPAQUE[baseId(id)];
      const wasEmissive = LIGHT[baseId(prev)] > 0, nowEmissive = LIGHT[baseId(id)] > 0;
      if (wasOpaque !== nowOpaque || wasEmissive || nowEmissive) {
        this.relight(cx, cz);
        this.relight(cx - 1, cz); this.relight(cx + 1, cz);
        this.relight(cx, cz - 1); this.relight(cx, cz + 1);
      }
    }
    return true;
  }

  relight(cx, cz) {
    const c = this.chunks.get(this._key(cx, cz));
    if (!c || !c.generated) return;
    c.lit = false;
    this.lightQueueAdd(c);
  }

  markDirty(cx, cz) {
    const c = this.chunks.get(this._key(cx, cz));
    if (c) c.dirty = true;
  }

  markNeighboursDirty(cx, cz) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        this.markDirty(cx + dx, cz + dz);
      }
    }
  }

  /** Orientation of a facing block at a world position (0 when not loaded). */
  getFacing(wx, wy, wz) {
    if (wy < 0 || wy >= WORLD_H) return 0;
    const c = this.chunks.get(this._key(wx >> 4, wz >> 4));
    if (!c) return 0;
    return c.getFacing(wx - ((wx >> 4) << 4), wy, wz - ((wz >> 4) << 4));
  }

  /** Rotate a facing block in place; only the affected chunk needs a remesh. */
  setFacing(wx, wy, wz, dir) {
    if (wy < 0 || wy >= WORLD_H) return false;
    const cx = wx >> 4, cz = wz >> 4;
    const c = this.chunks.get(this._key(cx, cz));
    if (!c) return false;
    c.setFacing(wx - (cx << 4), wy, wz - (cz << 4), dir);
    return true;
  }

  // ------------------------------------------------------------------ streaming
  /**
   * Called once per frame. Generates, decorates, lights and meshes chunks around the
   * player within a time budget, nearest first.
   */
  update(px, pz, budgetMs = this.generationBudgetMs) {
    const t0 = performance.now();
    const pcx = Math.floor(px) >> 4, pcz = Math.floor(pz) >> 4;
    const R = this.viewDistance;
    const t1 = performance.now();
    this.stats.lastGenMs = 0;

    // ---- 1. make sure terrain exists in the view ring (nearest first)
    for (let ring = 0; ring <= R && performance.now() - t0 < budgetMs; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const cx = pcx + dx, cz = pcz + dz;
          if (!this.chunks.has(this._key(cx, cz))) {
            this.ensureChunk(cx, cz);
            if (performance.now() - t0 >= budgetMs) break;
          }
        }
      }
    }
    this.stats.lastGenMs = performance.now() - t1;

    // ---- 2. decorate (needs the 3x3 neighbourhood), nearest first
    if (this.pendingDecorate.size) {
      const list = [...this.pendingDecorate];
      list.sort((a, b) => {
        const da = Math.hypot(a.cx - pcx, a.cz - pcz), db = Math.hypot(b.cx - pcx, b.cz - pcz);
        return da - db;
      });
      let done = 0;
      for (const c of list) {
        if (performance.now() - t0 > budgetMs * 1.15) break;
        if (this.gen.decorateChunk(c, this)) {
          this.pendingDecorate.delete(c);
          this.stats.decorated++;
          done++;
        }
        if (done > 12) break;
      }
    }

    // ---- 3. lighting (the Nether ships pre-lit; only block light is recomputed there)
    // The whole update() shares one deadline (t0): letting each stage carry its own
    // generous multiplier meant a single frame could spend 20ms here and drop the 1% low
    // under 60fps.
    for (let i = this.lightQueue.length - 1; i >= 0 && performance.now() - t0 < budgetMs * 1.35; i--) {
      const c = this.lightQueue[i];
      if (!this.chunks.has(this._key(c.cx, c.cz))) { this.lightQueue.splice(i, 1); continue; }
      if (this.dimension === 'nether') c.skyLight.fill(4);
      lightChunk(c, this);
      this.lightQueue.splice(i, 1);
      this.stats.lit++;
    }

    // ---- 4. mesh dirty chunks, nearest first
    const dirty = [];
    for (const c of this.chunks.values()) {
      if (c.dirty && c.generated && c.lit && c.decorated) {
        const d = Math.hypot(c.cx - pcx, c.cz - pcz);
        if (d <= R + 2) dirty.push([d, c]);
      }
    }
    dirty.sort((a, b) => a[0] - b[0]);
    this.stats.meshQueue = dirty.length;
    let meshed = 0;
    // meshing is the most expensive stage, so give it a small own budget AND respect the
    // overall deadline — one chunk always gets done so progress can never stall
    const meshBudget = Math.max(1.5, budgetMs * 0.7);
    const meshStart = performance.now();
    const hardDeadline = t0 + budgetMs * 1.35;
    for (const [, c] of dirty) {
      if (meshed > 0 && (performance.now() - meshStart > meshBudget || performance.now() > hardDeadline)) break;
      this.remeshNow(c);
      meshed++;
    }
    this.stats.meshed += meshed;
    this.stats.chunks = this.chunks.size;
    return performance.now() - t0;
  }

  lightQueueAdd(c) {
    if (c.lit && !c.dirty) return;
    if (!this.lightQueue.includes(c)) this.lightQueue.push(c);
  }

  /** Build the initial light for every chunk currently loaded, then mesh everything. */
  primeLighting() {
    for (const c of this.chunks.values()) {
      if (c.generated && !c.lit) lightChunk(c, this);
    }
  }

  /** Unload chunks outside the view ring, freeing their GPU buffers. */
  unloadFar(px, pz, onUnload) {
    const pcx = Math.floor(px) >> 4, pcz = Math.floor(pz) >> 4;
    const limit = this.viewDistance + 4;
    const doomed = [];
    for (const c of this.chunks.values()) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > limit) doomed.push(c);
    }
    for (const c of doomed) {
      this.chunks.delete(this._key(c.cx, c.cz));
      this.pendingDecorate.delete(c);
      if (this.lightQueue) {
        const i = this.lightQueue.indexOf(c);
        if (i >= 0) this.lightQueue.splice(i, 1);
      }
      if (onUnload) onUnload(c);
    }
    return doomed.length;
  }

  remeshNow(chunk) {
    const result = this.mesher.mesh(chunk);
    chunk.mesh = result;
    chunk.dirty = false;
    chunk.meshVersion++;
    this.stats.lastMeshMs = this.mesher.stats.ms;
    return result;
  }

  /** Ray-voxel walk (Amanatides & Woo) returning the first hit block. */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 6, wantLiquid = false) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);
    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? (x + 1 - ox) : (ox - x)) * tDeltaX);
    let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? (y + 1 - oy) : (oy - y)) * tDeltaY);
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? (z + 1 - oz) : (oz - z)) * tDeltaZ);
    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    for (let i = 0; i < 512; i++) {
      const id = baseId(this.getBlockRaw(x, y, z));
      if (id !== 0 && (wantLiquid || !LIQUID[id])) {
        return { x, y, z, id, nx, ny, nz, dist: t, block: BLOCKS[id], facing: this.getFacing(x, y, z) };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist || y < 0 || y >= WORLD_H) return null;
    }
    return null;
  }

  /** Pre-generate a square of chunks (used behind the loading screen). */
  pregenerate(px, pz, radius, onProgress) {
    const pcx = Math.floor(px) >> 4, pcz = Math.floor(pz) >> 4;
    const coords = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) coords.push([pcx + dx, pcz + dz]);
    }
    coords.sort((a, b) => (Math.hypot(a[0] - pcx, a[1] - pcz) - Math.hypot(b[0] - pcx, b[1] - pcz)));
    let i = 0;
    for (const [cx, cz] of coords) {
      this.ensureChunk(cx, cz);
      i++;
      if (onProgress && i % 16 === 0) onProgress(i / coords.length);
    }
    // decorate + light + mesh in dependency order
    for (const c of this.chunks.values()) this.gen.decorateChunk(c, this);
    for (const c of this.chunks.values()) { this.gen.decorateChunk(c, this); }
    for (const c of this.chunks.values()) if (!c.lit) lightChunk(c, this);
    for (const c of this.chunks.values()) if (!c.lit) lightChunk(c, this);
    for (const c of this.chunks.values()) this.remeshNow(c);
    if (onProgress) onProgress(1);
  }

  estimateMemoryMB() {
    let bytes = 0;
    for (const c of this.chunks.values()) {
      bytes += c.estimateBytes();
      if (c.mesh) {
        if (c.mesh.opaque) bytes += c.mesh.opaque.data.byteLength;
        if (c.mesh.water) bytes += c.mesh.water.data.byteLength;
      }
    }
    return bytes / (1024 * 1024);
  }

  /** Highest safe standing position at a column (for teleporting / falling checks). */
  findSurfaceY(wx, wz) {
    for (let y = WORLD_H - 1; y > 0; y--) {
      if (SOLID[baseId(this.getBlockRaw(wx, y, wz))]) return y + 1;
    }
    if (typeof this.gen.heightAt === 'function') return this.gen.heightAt(wx, wz) + 1;
    if (typeof this.gen.floorAt === 'function') return this.gen.floorAt(wx, wz) + 1;
    return 64;
  }

  // ------------------------------------------------------------------ random ticks
  /**
   * A light version of Minecraft's random block ticks: a few random cells per nearby
   * chunk are visited a few times a second, which is what makes crops grow and falling
   * blocks settle without simulating anything else.
   */
  randomTick(dt, playerX, playerZ, onBlockTick) {
    this.tickAccum = (this.tickAccum || 0) + dt;
    if (this.tickAccum < 0.25) return;
    this.tickAccum = 0;
    const pcx = Math.floor(playerX) >> 4, pcz = Math.floor(playerZ) >> 4;
    for (const chunk of this.chunks.values()) {
      if (Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz)) > this.viewDistance) continue;
      for (let i = 0; i < 4; i++) {
        const lx = (Math.random() * CX) | 0;
        const lz = (Math.random() * CZ) | 0;
        const top = chunk.heightMap[lz * CX + lx];
        if (top === 0) continue;
        const y = (Math.random() * (top + 1)) | 0;
        const id = baseId(chunk.blocks[(y * CZ + lz) * CX + lx]);
        if (id === 0) continue;
        onBlockTick(chunk.cx * CX + lx, y, chunk.cz * CZ + lz, id);
      }
    }
  }
}
