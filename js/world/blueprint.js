// world/blueprint.js
//
// Blueprints are the interchange format behind /save, /paste and the (optional) AI
// building adapter. They are deliberately plain JSON so an external tool or a language
// model can emit one directly.
//
//   {
//     "name": "hut",
//     "size": [7, 4, 7],                 // x, y, z
//     "palette": { ".": "air", "P": "planks", "C": "cobblestone" },
//     "layers": [                        // layers[y][z][x] -> palette char
//       [ "CCCCCCC", "C.....C", ... ],   // y = 0 (bottom)
//       ...
//     ]
//   }
//
// Layers are listed bottom-up and rows inside a layer run along +Z, characters along +X.
// That matches how a person reads a floor plan, and it keeps the JSON small enough to
// paste into a chat message.

import { BLOCKS } from '../core/blocks.js';

/** block key -> id, without pulling in the game layer (inventory.js owns resolveAny). */
function idForKey(key) {
  for (let i = 1; i < BLOCKS.length; i++) if (BLOCKS[i] && BLOCKS[i].key === key) return i;
  return 0;
}

const AIR_CHAR = '.';

/** Build a blueprint from a region of the world. */
export function captureRegion(world, x0, y0, z0, sx, sy, sz, name = 'region') {
  const palette = { [AIR_CHAR]: 'air' };
  const chars = new Map();
  const nextChar = () => {
    const alphabet = '#PCSWDGLEOIMTBNRAVKUFHJKQXYZ0123456789';
    for (const ch of alphabet) if (!palette[ch]) return ch;
    throw new Error('palette overflow');
  };

  const layers = [];
  for (let y = 0; y < sy; y++) {
    const rows = [];
    for (let z = 0; z < sz; z++) {
      let row = '';
      for (let x = 0; x < sx; x++) {
        const id = world.getBlockRaw(x0 + x, y0 + y, z0 + z);
        if (!id || !BLOCKS[id]) { row += AIR_CHAR; continue; }
        const key = BLOCKS[id].key;
        if (!chars.has(key)) {
          const ch = nextChar();
          chars.set(key, ch);
          palette[ch] = key;
        }
        row += chars.get(key);
      }
      rows.push(row);
    }
    layers.push(rows);
  }
  return { name, size: [sx, sy, sz], palette, layers };
}

/**
 * Write a blueprint into the world with its minimum corner at (ox, oy, oz).
 * Returns the number of blocks that actually changed.
 *
 * The whole paste is one edit so it lands in the save file and can be undone in a single
 * step; unknown palette entries are skipped rather than aborting the build.
 */
export function pasteBlueprint(world, bp, ox, oy, oz) {
  if (!bp || !Array.isArray(bp.layers) || !bp.palette) return 0;
  const ids = new Map();
  for (const [ch, key] of Object.entries(bp.palette)) {
    ids.set(ch, key === 'air' ? 0 : idForKey(key));
  }
  let changed = 0;
  for (let y = 0; y < bp.layers.length; y++) {
    const rows = bp.layers[y] || [];
    for (let z = 0; z < rows.length; z++) {
      const row = rows[z] || '';
      for (let x = 0; x < row.length; x++) {
        const id = ids.get(row[x]);
        if (id === undefined) continue;
        const wx = ox + x, wy = oy + y, wz = oz + z;
        if (world.getBlockRaw(wx, wy, wz) === id) continue;
        world.setBlockAt(wx, wy, wz, id);
        changed++;
      }
    }
  }
  return changed;
}

/** A small starter hut, so /paste works out of the box and doubles as a test fixture. */
export const BUILTIN_BLUEPRINTS = {
  hut: {
    name: 'hut',
    size: [5, 4, 5],
    palette: { '.': 'air', P: 'planks', C: 'cobblestone', G: 'glass', T: 'torch' },
    layers: [
      // floor
      ['CCCCC', 'CCCCC', 'CCCCC', 'CCCCC', 'CCCCC'],
      // walls with a doorway on the +Z side
      ['PPPPP', 'P...P', 'P...P', 'P...P', 'PP.PP'],
      ['PGGPP', 'G...P', 'G...P', 'G...P', 'PP.PP'],
      // roof
      ['PPPPP', 'PPPPP', 'PPPPP', 'PPPPP', 'PPPPP'],
    ],
  },
};
