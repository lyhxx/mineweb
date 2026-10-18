// world/redstone.js — the redstone power network.
//
// Scope: a faithful *simple* redstone, not a full Minecraft one. It supports
//
//   sources  : redstone block, redstone torch, lever (toggled), button (timed),
//              pressure plate (occupied), powered blocks
//   wire     : redstone wire, strength 0..15 stored in the chunk's facing byte,
//              decaying by one per block and recomputed by propagation
//   consumers: redstone lamp (lights), piston (pushes a block)
//
// The whole network is recomputed when anything in it changes, which keeps the code
// small and obviously correct. Recompute is BFS over the connected component only, so a
// typical circuit touches a handful of cells.

import { idOf, baseId } from '../core/blocks.js';

/** Six neighbour offsets in facing order (0=+X, 1=-X, 2=+Z, 3=-Z, 4=+Y, 5=-Y). */
export const DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0],
];

/**
 * The neighbours a wire connects to.
 *
 * Only the four horizontal directions are used, because vertical neighbours would let a
 * straight run wire itself through the block below/above it, which creates phantom paths
 * and makes the strength decay twice as fast as it should.
 */
const WIRE_DIRS = DIRS.slice(0, 4);

export const MAX_POWER = 15;

/** Highest wire strength anywhere in the component that contains (x,y,z). */
export function maxPowerAt(world, x, y, z) {
  recompute(world, x, y, z);
  const start = findWire(world, x, y, z);
  if (!start) return 0;
  return world.getPower(start[0], start[1], start[2]);
}

const ID = {};
let ready = false;
export function initRedstone() {
  if (ready) return;
  ID.air = 0;
  ID.wire = idOf('redstone_wire');
  ID.block = idOf('redstone_block');
  ID.ore = idOf('redstone_ore');
  ID.torch = idOf('redstone_torch');
  ID.lever = idOf('lever');
  ID.button = idOf('stone_button');
  ID.plate = idOf('pressure_plate');
  ID.lamp = idOf('redstone_lamp');
  ID.lampLit = idOf('redstone_lamp_lit');
  ID.piston = idOf('piston');
  ID.pistonExt = idOf('piston_extended');
  ID.pistonHead = idOf('piston_head');
  ID.hopper = idOf('hopper');
  ID.dispenser = idOf('dispenser');
  ID.repeater = idOf('repeater');
  ID.tnt = ID.tnt || idOf('tnt');
  ID.chest = idOf('chest');
  ID.tnt = idOf('tnt');
  ready = true;
}

const key = (x, y, z) => x + ',' + y + ',' + z;

/** Is this block a redstone wire? */
export function isWire(id) { initRedstone(); return baseId(id) === ID.wire; }

/** Does this block emit or carry power at all? */
export function isRedstoneComponent(id) {
  initRedstone();
  const b = baseId(id);
  return b === ID.wire || b === ID.block || b === ID.torch || b === ID.lever
    || b === ID.button || b === ID.plate || b === ID.lamp || b === ID.lampLit
    || b === ID.piston || b === ID.pistonExt || b === ID.hopper
    || b === ID.dispenser || b === ID.repeater;
}

/**
 * How much power this block pushes into an adjacent wire, ignoring its own state.
 * A lever/button/plate that is off contributes nothing.
 */
/**
 * How much power this block pushes into the *specific* cell (tx,ty,tz).
 *
 * A lever, button, plate, redstone block or torch radiates in all directions, but a
 * repeater only drives the cell its output faces — otherwise it would feed its own input
 * and latch itself on forever.
 */
function sourcePower(world, x, y, z, id, state, tx, ty, tz) {
  initRedstone();
  const b = baseId(id);
  if (b === ID.block) return MAX_POWER;
  if (b === ID.torch) return MAX_POWER;
  if (b === ID.lever) return state.leverOn ? MAX_POWER : 0;
  if (b === ID.button) return state.buttonUntil > 0 ? MAX_POWER : 0;
  if (b === ID.plate) return state.plateOn ? MAX_POWER : 0;
  if (b === ID.repeater) {
    if (!(state.repOut > 0)) return 0;
    if (tx === undefined) return MAX_POWER;
    const dir = DIRS[world.getFacing(x, y, z) & 3] || DIRS[0];
    return (tx === x + dir[0] && ty === y + dir[1] && tz === z + dir[2]) ? MAX_POWER : 0;
  }
  return 0;
}

/**
 * Recompute the wire strength of the connected component that contains (x,y,z).
 *
 * Wires are treated as a graph: every wire cell is a node, edges join orthogonally
 * adjacent wires (and wires that step up/down one block, like Minecraft's auto-connect).
 * Multi-source BFS from every powered source gives each wire its strength.
 */
export function lastRecomputeSources() { return recompute.lastSources || []; }
/** Debug view: the component nodes and the final powers from the last recompute. */
export function lastRecomputeTrace() {
  return { nodes: recompute.lastNodes || [], final: recompute.lastFinal || [], seeds: recompute.lastSources || [] };
}

export function recompute(world, x, y, z) {
  initRedstone();
  // find a wire to start from; if the change itself was a wire, start there
  const start = findWire(world, x, y, z);
  if (!start) { evaluateConsumers(world, x, y, z); return; }

  // 1. collect the component with a BFS over wire cells
  const seen = new Set();
  const nodes = [];
  const queue = [start];
  seen.add(key(start[0], start[1], start[2]));
  while (queue.length) {
    const [cx, cy, cz] = queue.shift();
    nodes.push([cx, cy, cz]);
    // horizontal neighbours, plus a one-block step up/down in the same direction so
    // staircase wiring connects (never a pure vertical hop)
    for (const [dx, dz] of WIRE_DIRS.map((d) => [d[0], d[2]])) {
      for (const dy2 of [0, 1, -1]) {
        const nx = cx + dx, ny = cy + dy2, nz = cz + dz;
        const nid = world.getBlockRaw(nx, ny, nz);
        if (!isWire(nid)) continue;
        const k = key(nx, ny, nz);
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push([nx, ny, nz]);
      }
    }
  }

  // 2. seed the BFS from every source that touches the component
  const power = new Map();
  const bfs = [];
  const debugSources = [];
  for (const [cx, cy, cz] of nodes) {
    let best = 0;
    // a wire can be fed by an adjacent source block
    for (const [dx, dy, dz] of DIRS) {
      const nid = world.getBlockRaw(cx + dx, cy + dy, cz + dz);
      if (!isRedstoneComponent(nid) || isWire(nid)) continue;
      const p = sourcePower(world, cx + dx, cy + dy, cz + dz, nid, world.redstoneState(cx + dx, cy + dy, cz + dz), cx, cy, cz);
      if (p > best) best = p;
    }
    if (best > 0) {
      power.set(key(cx, cy, cz), best);
      bfs.push([cx, cy, cz]);
      if (debugSources.length < 6) debugSources.push({ at: [cx, cy, cz], best });
    }
  }
  recompute.lastSources = debugSources;
  recompute.lastSeed = [...power.entries()].slice(0, 4);
  recompute.lastNodes = nodes.length;
  // 3. decay outward one per step
  while (bfs.length) {
    const [cx, cy, cz] = bfs.shift();
    const p = power.get(key(cx, cy, cz));
    if (p <= 1) continue;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, 1, -1]) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (!seen.has(key(nx, ny, nz))) continue;
        const cur = power.get(key(nx, ny, nz)) || 0;
        if (cur < p - 1) {
          power.set(key(nx, ny, nz), p - 1);
          bfs.push([nx, ny, nz]);
        }
      }
    }
  }

  // 4. write the strengths back and update the consumers around the component
  recompute.lastNodes = nodes.map((n) => key(n[0], n[1], n[2]));
  recompute.lastFinal = nodes.map(([cx, cy, cz]) => [key(cx, cy, cz), power.get(key(cx, cy, cz)) || 0]);
  for (const [cx, cy, cz] of nodes) {
    const want = power.get(key(cx, cy, cz)) || 0;
    if (world.getPower(cx, cy, cz) !== want) {
      world.setPower(cx, cy, cz, want);
      world.markDirty(cx >> 4, cz >> 4);
    }
    evaluateConsumers(world, cx, cy, cz);
  }
}

/** Nearest wire at or next to a position (the change may have been a source beside it). */
function findWire(world, x, y, z) {
  initRedstone();
  if (isWire(world.getBlockRaw(x, y, z))) return [x, y, z];
  for (const [dx, dy, dz] of DIRS) {
    if (isWire(world.getBlockRaw(x + dx, y + dy, z + dz))) return [x + dx, y + dy, z + dz];
  }
  return null;
}

/** Power arriving at a cell from any adjacent wire or source. */
export function powerAt(world, x, y, z) {
  initRedstone();
  let best = 0;
  for (const [dx, dy, dz] of DIRS) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    const id = world.getBlockRaw(nx, ny, nz);
    if (!id) continue;
    if (isWire(id)) {
      const s = world.getPower(nx, ny, nz);
      if (s > best) best = s;
    } else if (isRedstoneComponent(id)) {
      const p = sourcePower(world, nx, ny, nz, id, world.redstoneState(nx, ny, nz), x, y, z);
      if (p > best) best = p;
    }
  }
  // a source can also power the cell it sits in
  const here = world.getBlockRaw(x, y, z);
  if (isRedstoneComponent(here) && !isWire(here)) {
    const p = sourcePower(world, x, y, z, here, world.redstoneState(x, y, z), x, y, z);
    if (p > best) best = p;
  }
  return best;
}

/**
 * Advance repeaters. A repeater reads its input, waits `delay` seconds (2..8 ticks, set
 * by its facing byte), and then drives its output. That delay is what makes pulse
 * lengthening, clocks and latches possible.
 */
export function tickRepeaters(world, dt) {
  initRedstone();
  if (!world.repeaters) return;
  for (const k of world.repeaters) {
    const [x, y, z] = k.split(',').map(Number);
    if (baseId(world.getBlockRaw(x, y, z)) !== ID.repeater) { world.repeaters.delete(k); continue; }
    const st = world.redstoneState(x, y, z);
    const facing = world.getFacing(x, y, z) & 3;
    const delay = (facing + 1) * 0.1;              // 0.1s .. 0.4s
    // `facing` is the direction the output drives; the input is read from behind
    const dir = DIRS[facing] || DIRS[0];
    const inX = x - dir[0], inY = y - dir[1], inZ = z - dir[2];
    const inputOn = powerAt(world, inX, inY, inZ) > 0;
    const wantOut = inputOn ? 1 : 0;
    if (st.repPending === undefined) { st.repPending = null; st.repTimer = 0; }
    // schedule a change only when the target differs from both the current output and
    // whatever is already pending — otherwise the timer would be reset every tick and
    // the repeater would never actually fire
    if (wantOut !== st.repOut && wantOut !== st.repPending) {
      st.repPending = wantOut;
      st.repTimer = delay;
    }
    if (st.repPending !== null && st.repTimer > 0) {
      st.repTimer -= dt;
      if (st.repTimer <= 0) {
        st.repOut = st.repPending;
        st.repPending = null;
        st.repTimer = 0;
        // tell the circuit in front of us to recompute
        recompute(world, x + dir[0], y + dir[1], z + dir[2]);
      }
    }
  }
}

/**
 * Flip a lamp between its lit and unlit ids, and extend or retract a piston.
 * Called for every cell the component touched.
 */
export function evaluateConsumers(world, x, y, z) {
  initRedstone();
  for (const [dx, dy, dz] of DIRS) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    const id = baseId(world.getBlockRaw(nx, ny, nz));
    if (id === ID.repeater) {
      const st = world.redstoneState(nx, ny, nz);
      if (st.repOut === undefined) { st.repOut = 0; st.repPending = null; st.repTimer = 0; }
    }
    if (id === ID.lamp || id === ID.lampLit) {
      const on = powerAt(world, nx, ny, nz) > 0;
      const want = on ? ID.lampLit : ID.lamp;
      if (baseId(world.getBlockRaw(nx, ny, nz)) !== want) {
        world.setBlockAt(nx, ny, nz, want);
      }
    } else if (id === ID.piston || id === ID.pistonExt) {
      setPiston(world, nx, ny, nz, powerAt(world, nx, ny, nz) > 0);
    }
  }
}

/** Which cell a piston of this facing pushes into. */
export function pistonFront(facing) {
  return DIRS[facing & 7] || DIRS[0];
}

/**
 * Extend or retract a piston. Extending moves the block in front (or drops it if it
 * cannot move), retracting pulls the head back and leaves the pushed block where it is.
 */
export function setPiston(world, x, y, z, extend) {
  initRedstone();
  const id = baseId(world.getBlockRaw(x, y, z));
  const facing = world.getFacing(x, y, z);
  const [fx, fy, fz] = pistonFront(facing);
  const headX = x + fx, headY = y + fy, headZ = z + fz;
  if (extend && id === ID.piston) {
    const frontId = baseId(world.getBlockRaw(headX, headY, headZ));
    // only push air or a movable block one cell further
    if (frontId !== 0) {
      const bx = headX + fx, by = headY + fy, bz = headZ + fz;
      const beyond = baseId(world.getBlockRaw(bx, by, bz));
      if (beyond !== 0 && beyond !== ID.wire) return;      // blocked: do not extend
      world.setBlockAt(bx, by, bz, frontId);
      world.setFacing(bx, by, bz, world.getFacing(headX, headY, headZ));
    }
    world.setBlockAt(x, y, z, ID.pistonExt);
    world.setFacing(x, y, z, facing);
    world.setBlockAt(headX, headY, headZ, ID.pistonHead);
    world.setFacing(headX, headY, headZ, facing);
    return true;
  }
  if (!extend && id === ID.pistonExt) {
    if (baseId(world.getBlockRaw(headX, headY, headZ)) === ID.pistonHead) {
      world.setBlockAt(headX, headY, headZ, 0);
    }
    world.setBlockAt(x, y, z, ID.piston);
    world.setFacing(x, y, z, facing);
    return true;
  }
  return false;
}

/** Cheap "does this circuit have any source at all" test, used by the audit. */
export function hasSource(world, x, y, z) {
  initRedstone();
  const id = baseId(world.getBlockRaw(x, y, z));
  return id === ID.block || id === ID.torch || id === ID.lever
    || id === ID.button || id === ID.plate;
}
