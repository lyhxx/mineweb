// core/atlas.js — generates every block texture procedurally (no image files).
//
// The renderer consumes the tiles as a WebGL2 TEXTURE_2D_ARRAY: one 16x16 tile per layer.
// That is the correct answer to the classic voxel "distant ground turns into black
// stripes" problem — each tile keeps its own mip pyramid, so mipmapping removes the
// aliasing without ever averaging two unrelated tiles together.
// A packed 2D atlas is also produced, but only for the HUD icon renderer.
import { makeRng, clamp } from './math.js';
import { BLOCKS, ATLAS_SLOTS, ATLAS_COLS, ATLAS_ROWS, T } from './blocks.js';

export { ATLAS_COLS, ATLAS_ROWS, ATLAS_SLOTS };
export const TILE_PX = 16;                       // tile resolution = texture array layer size
export const ATLAS_TILE_COUNT = ATLAS_COLS * ATLAS_ROWS;   // layer capacity
export const LAYER_COUNT = ATLAS_TILE_COUNT;
export const ATLAS_W = ATLAS_COLS * TILE_PX;     // 512, icon atlas only
export const ATLAS_H = ATLAS_ROWS * TILE_PX;     // 512

function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function shade(c, f) { return [clamp(c[0] * f, 0, 1), clamp(c[1] * f, 0, 1), clamp(c[2] * f, 0, 1)]; }

/** Paints one authored 16x16 tile into a scratch buffer. */
class TilePainter {
  constructor(buf, tileX, tileY) {
    this.buf = buf;
    this.ox = tileX * TILE_PX;
    this.oy = tileY * TILE_PX;
  }
  px(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
    const i = ((this.oy + y) * TILE_PX + (this.ox + x)) * 4;
    const o = this.buf;
    o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = a;
  }
  get(x, y) {
    const i = ((this.oy + y) * TILE_PX + (this.ox + x)) * 4;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]];
  }
  fill(r, g, b, a = 255) {
    for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) this.px(x, y, r, g, b, a);
  }
  clear() { this.fill(0, 0, 0, 0); }
}

function rgba(c, a = 255) { return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), a]; }

/**
 * Paint one 16x16 tile according to a texture descriptor.
 * Descriptors: { kind, color?, ore?, part?, top?, glow? }
 */
function paintTile(p, d, seed) {
  const rng = makeRng(seed);
  const base = d.color || [0.6, 0.6, 0.6];
  const K = d.kind;

  switch (K) {
    case T.SOLID: {
      const c = rgba(base);
      p.fill(c[0], c[1], c[2]);
      // faint grain so flat colours still read as pixel art
      for (let i = 0; i < 30; i++) {
        const f = 0.94 + rng() * 0.12;
        const c2 = rgba(shade(base, f));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c2[0], c2[1], c2[2]);
      }
      break;
    }
    case T.NOISE:
    case T.GRAVEL:
    case T.CLAY:
    case T.SNOW:
    case T.BEDROCK: {
      const spread = K === T.GRAVEL ? 0.30 : K === T.BEDROCK ? 0.55 : 0.16;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          let f = 1 + (rng() - 0.5) * spread * 2;
          if (K === T.BEDROCK) f = rng() < 0.5 ? 0.35 + rng() * 0.25 : 0.55 + rng() * 0.4;
          const c = rgba(shade(base, f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      if (K === T.GRAVEL) { // pebbles
        for (let i = 0; i < 14; i++) {
          const x = (rng() * 15) | 0, y = (rng() * 15) | 0;
          const f = 0.7 + rng() * 0.6;
          const c = rgba(shade(base, f));
          p.px(x, y, c[0], c[1], c[2]); p.px(x + 1, y, c[0], c[1], c[2]);
          p.px(x, y + 1, c[0], c[1], c[2]);
        }
      }
      if (K === T.SNOW) {
        for (let i = 0; i < 20; i++) {
          const c = rgba([1, 1, 1]);
          p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.GRASS_TOP: {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const f = 0.82 + rng() * 0.36;
          const c = rgba(shade([0.42, 0.70, 0.26], f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < 26; i++) {
        const c = rgba(shade([0.36, 0.62, 0.22], 0.8 + rng() * 0.5));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }
    case T.GRASS_SIDE: {
      const dirt = [0.55, 0.40, 0.28];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(dirt, 0.85 + rng() * 0.3));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const grn = [0.42, 0.70, 0.26];
      for (let x = 0; x < 16; x++) {
        const h = 2 + ((rng() * 3.2) | 0);
        for (let y = 0; y < h; y++) {
          const f = 0.85 + rng() * 0.3;
          // second row gets a dark rim so the edge looks cut, like the real texture
          const col = y === h - 1 ? shade(grn, 0.68) : grn;
          const c = rgba(shade(col, f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.LOG_SIDE: {
      for (let x = 0; x < 16; x++) {
        const strip = 0.82 + rng() * 0.3;
        for (let y = 0; y < 16; y++) {
          const f = strip * (0.92 + rng() * 0.18);
          const c = rgba(shade([0.42, 0.31, 0.19], f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < 10; i++) { // bark knots
        const x = (rng() * 16) | 0, y = (rng() * 16) | 0;
        const c = rgba(shade([0.42, 0.31, 0.19], 0.6));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.LOG_TOP: {
      const cx = 7.5, cy = 7.5;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const r = Math.hypot(x - cx, y - cy);
          let f = 0.9 + rng() * 0.16;
          if (r > 7.2) f *= 0.72;                      // bark border
          const ring = Math.sin(r * 2.2) * 0.5 + 0.5;   // tree rings
          f *= 0.88 + ring * 0.24;
          const c = rgba(shade([0.62, 0.47, 0.29], f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.PLANK: {
      for (let y = 0; y < 16; y++) {
        const row = (y / 4) | 0;
        const rowF = 0.9 + ((row * 37) % 7) * 0.03;
        for (let x = 0; x < 16; x++) {
          let f = rowF * (0.94 + rng() * 0.12);
          if (y % 4 === 3) f *= 0.72;                  // plank seam
          const c = rgba(shade(base, f));
          p.px(x, y, c[0], c[1], c[2]);
        }
        // staggered vertical seams
        const sx = (row % 2 === 0) ? 7 : 11;
        for (let y2 = row * 4; y2 < row * 4 + 3; y2++) {
          const c = rgba(shade(base, 0.66));
          p.px(sx, y2, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.COBBLE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.36, 0.36, 0.36], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const cells = 3;
      const size = 16 / cells;
      for (let cy2 = 0; cy2 < cells; cy2++) {
        for (let cx2 = 0; cx2 < cells; cx2++) {
          if (rng() < 0.12) continue;
          const ox = cx2 * size + 0.7 + rng() * 0.6;
          const oy = cy2 * size + 0.7 + rng() * 0.6;
          const w = size - 1.4 - rng() * 1.2, h = size - 1.4 - rng() * 1.2;
          const grey = 0.45 + rng() * 0.22;
          for (let y = Math.round(oy); y < oy + h; y++) {
            for (let x = Math.round(ox); x < ox + w; x++) {
              if (x < 0 || y < 0 || x > 15 || y > 15) continue;
              const f = grey * (0.9 + rng() * 0.22);
              const c = rgba([f, f, f]);
              p.px(x, y, c[0], c[1], c[2]);
            }
          }
        }
      }
      break;
    }
    case T.BRICK: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.72, 0.68, 0.63], 0.95 + rng() * 0.1)); // mortar
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let row = 0; row < 4; row++) {
        const y0 = row * 4;
        const off = (row % 2) * 4;
        for (let b = -1; b < 3; b++) {
          const x0 = b * 8 + off;
          for (let y = y0; y < y0 + 3; y++) {
            for (let x = x0; x < x0 + 7; x++) {
              if (x < 0 || x > 15) continue;
              const f = 0.85 + rng() * 0.3;
              const c = rgba(shade(base, f));
              p.px(x, y, c[0], c[1], c[2]);
            }
          }
        }
      }
      break;
    }
    case T.ORE: {
      const stone = [0.50, 0.50, 0.50];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(stone, 0.88 + rng() * 0.24));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const blobs = 4 + ((rng() * 4) | 0);
      for (let i = 0; i < blobs; i++) {
        const cx = 2 + ((rng() * 12) | 0), cy = 2 + ((rng() * 12) | 0);
        const r = 1.2 + rng() * 1.4;
        for (let y = cy - 3; y <= cy + 3; y++) {
          for (let x = cx - 3; x <= cx + 3; x++) {
            const dd = Math.hypot(x - cx, y - cy);
            if (dd > r) continue;
            const edge = dd > r - 0.8;
            const f = edge ? 0.72 : 1.0 + (rng() - 0.5) * 0.2;
            const c = rgba(shade(d.ore || [1, 1, 1], f));
            p.px(x, y, c[0], c[1], c[2]);
          }
        }
      }
      break;
    }
    case T.LEAVES: {
      const g = [0.32, 0.62, 0.24];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (rng() < 0.16) { p.px(x, y, 0, 0, 0, 0); continue; }   // holes -> alpha test
          const f = 0.72 + rng() * 0.6;
          const c = rgba(shade(g, f));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      for (let i = 0; i < 24; i++) {
        const c = rgba(shade(g, 0.55 + rng() * 0.3));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }
    case T.WATER: {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const w = Math.sin((x + y * 0.6) * 0.9) * 0.5 + 0.5;
          const f = 0.86 + w * 0.22 + (rng() - 0.5) * 0.08;
          const c = rgba(shade([0.20, 0.42, 0.86], f), 190);
          p.px(x, y, c[0], c[1], c[2], 200);
        }
      }
      break;
    }
    case T.LAVA: {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const n = Math.sin(x * 0.7) * Math.cos(y * 0.6) * 0.5 + 0.5;
          const t = clamp(n + (rng() - 0.5) * 0.4, 0, 1);
          const c = rgba(mix([0.62, 0.12, 0.02], [1.0, 0.65, 0.10], t));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.GLASS: {
      p.clear();
      for (let i = 0; i < 16; i++) {
        const c = rgba([0.86, 0.92, 0.95], 230);
        p.px(i, 0, c[0], c[1], c[2], 235); p.px(i, 15, c[0], c[1], c[2], 235);
        p.px(0, i, c[0], c[1], c[2], 235); p.px(15, i, c[0], c[1], c[2], 235);
      }
      for (let i = 0; i < 12; i++) {
        const c = rgba([1, 1, 1], 150);
        p.px(2 + ((rng() * 11) | 0), 2 + ((rng() * 11) | 0), c[0], c[1], c[2], 150);
      }
      break;
    }
    case T.ICE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.9 + rng() * 0.2;
        const c = rgba(shade([0.62, 0.82, 0.98], f), 210);
        p.px(x, y, c[0], c[1], c[2], 205);
      }
      for (let i = 0; i < 10; i++) {
        const x = (rng() * 13) | 0, y = (rng() * 13) | 0;
        const len = 2 + ((rng() * 4) | 0);
        const c = rgba([0.85, 0.95, 1.0], 240);
        for (let k = 0; k < len; k++) p.px(x + k, y + k, c[0], c[1], c[2], 240);
      }
      break;
    }
    case T.PLANT: {
      p.clear();
      const g = base;
      for (let i = 0; i < 22; i++) {
        const x = 3 + ((rng() * 10) | 0);
        const h = 4 + ((rng() * 10) | 0);
        const f = 0.7 + rng() * 0.6;
        const c = rgba(shade(g, f));
        for (let y = 15; y > 15 - h; y--) p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.FLOWER: {
      p.clear();
      const stem = [0.30, 0.55, 0.20];
      for (let y = 15; y > 6; y--) { const c = rgba(stem); p.px(7, y, c[0], c[1], c[2]); p.px(8, y, c[0], c[1], c[2]); }
      const petal = [0.92, 0.25, 0.22], heart = [0.98, 0.85, 0.25];
      const pts = [[5, 4], [6, 3], [7, 2], [8, 2], [9, 3], [10, 4], [6, 5], [9, 5], [7, 5], [8, 5], [7, 6], [8, 6], [5, 5], [10, 5], [6, 6], [9, 6]];
      for (const [x, y] of pts) { const c = rgba(petal, 255); p.px(x, y, c[0], c[1], c[2]); }
      for (const [x, y] of [[7, 4], [8, 4], [7, 3], [8, 3]]) { const c = rgba(heart); p.px(x, y, c[0], c[1], c[2]); }
      for (const [x, y] of [[4, 7], [11, 7], [4, 8], [11, 8]]) { const c = rgba(stem); p.px(x, y, c[0], c[1], c[2]); }
      break;
    }
    case T.SAPLING: {
      p.clear();
      const stem = [0.42, 0.31, 0.19];
      for (let y = 15; y > 9; y--) { const c = rgba(stem); p.px(7, y, c[0], c[1], c[2]); p.px(8, y, c[0], c[1], c[2]); }
      const leaf = [0.32, 0.62, 0.24];
      for (let i = 0; i < 40; i++) {
        const x = 3 + ((rng() * 10) | 0), y = 2 + ((rng() * 7) | 0);
        if (Math.hypot(x - 7.5, y - 5) > 4.2) continue;
        const c = rgba(shade(leaf, 0.75 + rng() * 0.5));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.TORCH_TEX: {
      p.clear();
      const stick = [0.55, 0.42, 0.24];
      for (let y = 16; y >= 6; y--) for (let x = 6; x <= 9; x++) { const c = rgba(shade(stick, 0.85 + rng() * 0.3)); p.px(x, y, c[0], c[1], c[2]); }
      const hot = [[0.99, 0.85, 0.35], [1.0, 0.72, 0.20], [0.95, 0.95, 0.80]];
      for (let y = 3; y <= 6; y++) {
        for (let x = 5; x <= 10; x++) {
          if (Math.hypot(x - 7.5, y - 5) > 2.7) continue;
          const c = rgba(hot[(rng() * 3) | 0]);
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.CRAFT_TOP: {
      const wood = [0.65, 0.48, 0.26];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(wood, 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const dark = [0.32, 0.22, 0.12];
      for (let i = 0; i < 16; i++) {
        for (const v of [1, 2, 8, 9, 15]) { let c = rgba(dark); p.px(i, v, c[0], c[1], c[2]); c = rgba(dark); p.px(v, i, c[0], c[1], c[2]); }
      }
      break;
    }
    case T.CRAFT_SIDE: {
      const wood = [0.65, 0.48, 0.26];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        let f = 0.92 + rng() * 0.14;
        if (y > 12) f *= 0.8;
        const c = rgba(shade(wood, f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const dark = [0.30, 0.20, 0.11];
      for (let x = 0; x < 16; x++) { const c = rgba(dark); p.px(x, 0, c[0], c[1], c[2]); }
      for (let y = 0; y < 4; y++) { let c = rgba(dark); p.px(3, y, c[0], c[1], c[2]); c = rgba(dark); p.px(12, y, c[0], c[1], c[2]); }
      break;
    }
    case T.FURNACE_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.42, 0.42], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.FURNACE_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.42, 0.42], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const dark = [0.24, 0.24, 0.24];
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) {
        const c = rgba(dark); p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.FURNACE_FRONT: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.42, 0.42], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const dark = [0.16, 0.16, 0.16];
      for (let y = 6; y < 14; y++) for (let x = 3; x < 13; x++) { const c = rgba(dark); p.px(x, y, c[0], c[1], c[2]); }
      for (let y = 11; y < 14; y++) for (let x = 4; x < 12; x++) {
        const t = (y - 11) / 3;
        const c = rgba(mix([0.99, 0.55, 0.10], [0.75, 0.18, 0.02], t * 0.8 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.BOOKSHELF: {
      const wood = [0.65, 0.48, 0.26];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(wood, 0.9 + rng() * 0.15));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const rows = [[1, 6], [9, 14]];
      const books = [[0.62, 0.24, 0.20], [0.24, 0.34, 0.66], [0.30, 0.54, 0.28], [0.72, 0.62, 0.24], [0.48, 0.28, 0.58]];
      for (const [y0, y1] of rows) {
        let x = 1;
        while (x < 15) {
          const w = 1 + ((rng() * 2) | 0);
          const col = books[(rng() * books.length) | 0];
          for (let yy = y0; yy <= y1; yy++) for (let xx = x; xx < Math.min(x + w, 15); xx++) {
            const c = rgba(shade(col, 0.85 + rng() * 0.3));
            p.px(xx, yy, c[0], c[1], c[2]);
          }
          x += w + 1;
        }
      }
      break;
    }
    case T.TNT_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.85, 0.22, 0.18], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const band = [0.95, 0.95, 0.95], ink = [0.12, 0.12, 0.12];
      for (let y = 5; y < 11; y++) for (let x = 0; x < 16; x++) { const c = rgba(band); p.px(x, y, c[0], c[1], c[2]); }
      const glyph = ['0b1111110', '0b1000001', '0b1000001', '0b1000001', '0b1111110'];
      for (let r = 0; r < 5; r++) for (let cc = 0; cc < 7; cc++) {
        if (glyph[r][cc + 2] === '1') { const c = rgba(ink); p.px(cc + 4, r + 5, c[0], c[1], c[2]); }
      }
      break;
    }
    case T.TNT_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.85, 0.22, 0.18], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) { const c = rgba([0.22, 0.22, 0.22]); p.px(x, y, c[0], c[1], c[2]); }
      for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) { const c = rgba([0.35, 0.35, 0.35]); p.px(x, y, c[0], c[1], c[2]); }
      break;
    }
    case T.PUMPKIN_FACE:
    case T.CHEST: {
      const wood = base;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        let f = 0.9 + rng() * 0.16;
        if (K === T.PUMPKIN_FACE && (x % 4 === 0)) f *= 0.78;
        const c = rgba(shade(wood, f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      if (K === T.CHEST) {
        const dark = [0.30, 0.20, 0.11];
        for (let x = 0; x < 16; x++) { const c = rgba(dark); p.px(x, 6, c[0], c[1], c[2]); }
        for (let y = 0; y < 16; y++) { let c = rgba(dark); p.px(0, y, c[0], c[1], c[2]); c = rgba(dark); p.px(15, y, c[0], c[1], c[2]); }
        for (let y = 8; y < 11; y++) for (let x = 6; x < 10; x++) { const c = rgba([0.95, 0.82, 0.30]); p.px(x, y, c[0], c[1], c[2]); }
      } else {
        const dark = [0.35, 0.24, 0.06];
        const face = [
          '................'.split(''),
        ];
        const put = (x, y) => { const c = rgba(dark); p.px(x, y, c[0], c[1], c[2]); };
        // two triangular eyes + jagged grin, like the classic carved pumpkin
        for (const [x, y] of [[3, 4], [4, 3], [4, 4], [4, 5], [11, 4], [12, 3], [12, 4], [12, 5]]) put(x, y);
        for (let x = 3; x <= 12; x++) put(x, 9);
        for (const [x, y] of [[4, 10], [6, 10], [8, 10], [10, 10], [5, 11], [7, 11], [9, 11], [11, 11], [6, 12], [7, 12], [9, 12], [10, 12]]) put(x, y);
      }
      break;
    }
    case T.SANDSTONE: {
      const tone = d.part === 'top' ? 0.90 : 0.84;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.87, 0.81, 0.58], tone * (0.96 + rng() * 0.08)));
        p.px(x, y, c[0], c[1], c[2]);
      }
      if (d.part === 'side') {
        for (let x = 0; x < 16; x++) { const c = rgba(shade([0.78, 0.72, 0.50], 1)); p.px(x, 4, c[0], c[1], c[2]); p.px(x, 11, c[0], c[1], c[2]); }
      }
      break;
    }
    case T.METAL:
    case T.WOOL: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(base, 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.CIRCUIT: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.45, 0.60, 0.35], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ wool colours
    case T.WOOL_WHITE: case T.WOOL_RED: case T.WOOL_BLUE:
    case T.WOOL_GREEN: case T.WOOL_YELLOW: case T.WOOL_BLACK: {
      const wool = {
        [T.WOOL_WHITE]: [0.92, 0.92, 0.92], [T.WOOL_RED]: [0.62, 0.20, 0.18],
        [T.WOOL_BLUE]: [0.20, 0.30, 0.62], [T.WOOL_GREEN]: [0.30, 0.48, 0.20],
        [T.WOOL_YELLOW]: [0.85, 0.75, 0.24], [T.WOOL_BLACK]: [0.14, 0.13, 0.13],
      }[K];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        // woven look: slight per-pixel fibre noise plus a soft grid
        let f = 0.90 + rng() * 0.18;
        if ((x + y) % 4 === 0) f *= 0.95;
        const c = rgba(shade(wool, f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ glass pane
    case T.GLASS_PANE: {
      p.clear();
      for (let i = 0; i < 16; i++) {
        const c = rgba([0.86, 0.92, 0.95], 200);
        p.px(i, 0, c[0], c[1], c[2], 210); p.px(i, 15, c[0], c[1], c[2], 210);
        p.px(0, i, c[0], c[1], c[2], 210); p.px(15, i, c[0], c[1], c[2], 210);
      }
      for (let x = 1; x < 15; x++) {
        const c = rgba([1, 1, 1], 90);
        p.px(x, 7, c[0], c[1], c[2], 90); p.px(x, 8, c[0], c[1], c[2], 90);
      }
      break;
    }

    // ------------------------------------------------------------ deep / nether stone
    case T.OBSIDIAN: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.75 + rng() * 0.5;
        const c = rgba(shade([0.09, 0.06, 0.14], f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 18; i++) {
        const c = rgba([0.35, 0.25, 0.55], 220);
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2], 220);
      }
      break;
    }
    case T.NETHERRACK: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.8 + rng() * 0.45;
        const c = rgba(shade([0.45, 0.16, 0.16], f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 24; i++) {
        const c = rgba(shade([0.30, 0.08, 0.08], 0.8 + rng() * 0.4));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }
    case T.SOUL_SAND: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.85 + rng() * 0.3;
        const c = rgba(shade([0.42, 0.32, 0.22], f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the three mournful "faces" of soul sand
      for (const ox of [3, 7, 11]) {
        for (const [dx, dy] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2], [1, 3]]) {
          const c = rgba([0.20, 0.14, 0.10]);
          p.px(ox + dx - 1, 5 + dy, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.QUARTZ: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.93, 0.92, 0.88], 0.97 + rng() * 0.06));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ anvil
    case T.ANVIL: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.24, 0.24, 0.27], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // horn on one side, waist in the middle
      for (let y = 4; y < 8; y++) for (let x = 0; x < 5; x++) {
        if (x + (7 - y) < 4) { const c = rgba([0.34, 0.34, 0.37]); p.px(x, y, c[0], c[1], c[2]); }
      }
      for (let y = 8; y < 12; y++) for (let x = 5; x < 11; x++) {
        const c = rgba([0.18, 0.18, 0.20]); p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ vegetation
    case T.SAPLING_OAK: {
      p.clear();
      const stem = [0.42, 0.31, 0.19];
      for (let y = 15; y > 10; y--) { const c = rgba(stem); p.px(7, y, c[0], c[1], c[2]); p.px(8, y, c[0], c[1], c[2]); }
      const leaf = [0.30, 0.62, 0.24];
      for (let i = 0; i < 44; i++) {
        const x = 3 + ((rng() * 10) | 0), y = 2 + ((rng() * 7) | 0);
        if (Math.hypot(x - 7.5, y - 4.5) > 4.0) continue;
        const c = rgba(shade(leaf, 0.75 + rng() * 0.5));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.TALL_GRASS: {
      p.clear();
      const g = [0.34, 0.62, 0.24];
      for (let i = 0; i < 26; i++) {
        const x = 2 + ((rng() * 12) | 0);
        const h = 4 + ((rng() * 11) | 0);
        const f = 0.7 + rng() * 0.6;
        const c = rgba(shade(g, f));
        for (let y = 15; y > 15 - h; y--) p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.DEAD_BUSH: {
      p.clear();
      const b = [0.48, 0.36, 0.18];
      for (let i = 0; i < 16; i++) {
        const x = 4 + ((rng() * 8) | 0);
        const h = 3 + ((rng() * 9) | 0);
        const c = rgba(shade(b, 0.7 + rng() * 0.6));
        for (let y = 15; y > 15 - h; y--) p.px(x, y, c[0], c[1], c[2]);
      }
      for (const [x, y] of [[5, 8], [10, 7], [6, 5], [9, 4], [7, 9], [8, 10]]) {
        const c = rgba(shade(b, 0.9));
        p.px(x, y, c[0], c[1], c[2]); p.px(x + 1, y + 1, c[0], c[1], c[2]);
        p.px(x - 1, y + 1, c[0], c[1], c[2]);
      }
      break;
    }
    case T.LADDER: {
      p.clear();
      const wood = [0.60, 0.44, 0.24];
      for (let y = 0; y < 16; y++) {
        let c = rgba(shade(wood, 0.95 + rng() * 0.12));
        p.px(2, y, c[0], c[1], c[2]); p.px(3, y, c[0], c[1], c[2]);
        c = rgba(shade(wood, 0.95 + rng() * 0.12));
        p.px(12, y, c[0], c[1], c[2]); p.px(13, y, c[0], c[1], c[2]);
      }
      for (const y of [2, 5, 8, 11, 14]) {
        for (let x = 2; x <= 13; x++) {
          const c = rgba(shade(wood, 0.85 + rng() * 0.2));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.CACTUS_SIDE:
    case T.PUMPKIN_SIDE:
    case T.PUMPKIN_TOP: {
      const tone = K === T.CACTUS_SIDE ? [0.30, 0.55, 0.26] : [0.85, 0.55, 0.12];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        let f = 0.92 + rng() * 0.14;
        if (K === T.CACTUS_SIDE && (x % 5 === 0)) f *= 0.82;
        if (K === T.PUMPKIN_SIDE && (x % 4 === 0)) f *= 0.78;
        if (K === T.PUMPKIN_TOP && Math.hypot(x - 7.5, y - 7.5) > 6) f *= 0.8;
        const c = rgba(shade(tone, f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.FURNACE_LIT: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.42, 0.42], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 6; y < 14; y++) for (let x = 3; x < 13; x++) {
        const c = rgba([0.16, 0.16, 0.16]); p.px(x, y, c[0], c[1], c[2]);
      }
      // roaring fire, brighter than the cold furnace
      for (let y = 8; y < 14; y++) for (let x = 4; x < 12; x++) {
        const t = (y - 8) / 6;
        const c = rgba(mix([1.0, 0.92, 0.45], [0.95, 0.30, 0.03], t * 0.9 + rng() * 0.1));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ farming
    case T.FARMLAND:
    case T.FARMLAND_TOP: {
      const soil = [0.40, 0.28, 0.18];
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade(soil, 0.85 + rng() * 0.3));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // tilled furrows running along one axis
      for (let x = 0; x < 16; x++) {
        for (const y of [3, 7, 11, 15]) {
          const c = rgba(shade(soil, 0.62));
          p.px(x, y, c[0], c[1], c[2]);
        }
        for (const y of [2, 6, 10, 14]) {
          const c = rgba(shade(soil, 1.25));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      // damp speckles so watered soil reads as darker
      if (K === T.FARMLAND_TOP) {
        for (let i = 0; i < 26; i++) {
          const c = rgba([0.28, 0.40, 0.55], 200);
          p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2], 200);
        }
      }
      break;
    }
    case T.WHEAT_0: case T.WHEAT_1: case T.WHEAT_2: case T.WHEAT_3: {
      p.clear();
      const stage = K - T.WHEAT_0;                 // 0..3
      const stalk = [0.36, 0.55, 0.22];
      const ripe = [0.82, 0.68, 0.24];
      const stalks = 3 + stage;                    // more stalks as it fills in
      for (let i = 0; i < stalks; i++) {
        const x = 3 + Math.floor((i / stalks) * 10);
        const h = 4 + stage * 4;
        const top = 15 - h;
        const col = stage >= 2 ? ripe : stalk;
        for (let y = 15; y > top; y--) {
          const f = 0.85 + rng() * 0.3;
          const c = rgba(shade(col, f));
          p.px(x, y, c[0], c[1], c[2]);
        }
        // grain head once it is nearly ripe
        if (stage >= 2) {
          for (let y = top + 1; y <= top + 2; y++) {
            const c = rgba(shade(ripe, 1.1));
            p.px(x, y, c[0], c[1], c[2]);
            p.px(x + 1, y + 1, c[0], c[1], c[2]);
          }
        }
      }
      break;
    }

    // ------------------------------------------------------------ bed
    case T.BED_TOP: {
      // red blanket with a white pillow band at one end
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.92 + rng() * 0.14;
        const c = rgba(shade([0.72, 0.16, 0.16], f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 1; y < 5; y++) for (let x = 1; x < 15; x++) {
        const c = rgba(shade([0.94, 0.94, 0.92], 0.96 + rng() * 0.08));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.35, 0.08, 0.08]); p.px(x, 0, c[0], c[1], c[2]); }
      break;
    }
    case T.BED_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const f = 0.9 + rng() * 0.16;
        const c = rgba(shade([0.72, 0.16, 0.16], f));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.42, 0.30, 0.18]); p.px(x, 15, c[0], c[1], c[2]); }
      break;
    }
    case T.BED_HEAD:
    case T.BED_FOOT: {
      const pillowed = K === T.BED_HEAD;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const top = pillowed && y < 5;
        const base = top ? [0.94, 0.94, 0.92] : [0.72, 0.16, 0.16];
        const c = rgba(shade(base, 0.92 + rng() * 0.14));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.42, 0.30, 0.18]); p.px(x, 15, c[0], c[1], c[2]); }
      break;
    }

    // ------------------------------------------------------------ nether portal
    case T.PORTAL: {
      // swirling translucent purple; no hard edges so the plane reads as energy
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const w = Math.sin(x * 1.1 + y * 0.6) * 0.5 + Math.cos(y * 0.9 - x * 0.4) * 0.5;
          const t = Math.max(0, Math.min(1, 0.5 + w * 0.35 + (rng() - 0.5) * 0.25));
          const c = rgba(mix([0.36, 0.06, 0.62], [0.85, 0.45, 1.0], t));
          p.px(x, y, c[0], c[1], c[2], Math.round(185 + t * 60));
        }
      }
      break;
    }
    // ------------------------------------------------------------ enchanting table
    case T.ENCHANT_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.20, 0.16, 0.26], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // obsidian rim with a glowing rune pattern inside
      for (let i = 0; i < 16; i++) {
        const edge = rgba([0.10, 0.07, 0.16]); p.px(i, 0, edge[0], edge[1], edge[2]);
        p.px(i, 15, edge[0], edge[1], edge[2]);
        p.px(0, i, edge[0], edge[1], edge[2]);
        p.px(15, i, edge[0], edge[1], edge[2]);
      }
      for (let i = 0; i < 40; i++) {
        const x = 2 + ((rng() * 12) | 0), y = 2 + ((rng() * 12) | 0);
        const c = rgba(mix([0.55, 0.30, 0.95], [0.95, 0.80, 1.0], rng()));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const g = rgba([0.86, 0.70, 1.0]);
      for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) p.px(x, y, g[0], g[1], g[2]);
      break;
    }
    case T.ENCHANT_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.16, 0.11, 0.22], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // a band of glowing glyphs across the middle
      for (let y = 5; y < 11; y++) {
        for (let x = 1; x < 15; x++) {
          if (((x * 7 + y * 3) % 5) !== 0) continue;
          const c = rgba(mix([0.45, 0.22, 0.85], [0.92, 0.78, 1.0], rng()));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.09, 0.06, 0.14]); p.px(x, 0, c[0], c[1], c[2]); p.px(x, 15, c[0], c[1], c[2]); }
      break;
    }
    case T.ENCHANT_BOTTOM: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.09, 0.06, 0.14], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ the End
    case T.END_STONE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.86, 0.86, 0.72], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 26; i++) {
        const c = rgba(shade([0.78, 0.78, 0.62], 0.92 + rng() * 0.12));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }
    case T.END_FRAME_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.40, 0.50, 0.44], 0.92 + rng() * 0.14));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the socket where the eye of ender goes
      for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
        const c = rgba([0.14, 0.20, 0.18]); p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
        const c = rgba(mix([0.30, 0.85, 0.55], [0.85, 1.0, 0.75], rng()));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.END_FRAME_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.34, 0.44, 0.38], 0.92 + rng() * 0.14));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 4; y < 8; y++) for (let x = 2; x < 14; x++) {
        const c = rgba(shade([0.24, 0.32, 0.28], 0.9 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.END_PORTAL: {
      // deep starfield: mostly near-black with a scatter of bright points
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba([0.05, 0.02, 0.10]); p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 30; i++) {
        const x = (rng() * 16) | 0, y = (rng() * 16) | 0;
        const c = rgba(mix([0.70, 0.55, 1.0], [1.0, 0.95, 1.0], rng()));
        p.px(x, y, c[0], c[1], c[2], 235);
      }
      break;
    }
    case T.PURPUR: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.58, 0.36, 0.60], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the speckled purpur pattern
      for (let i = 0; i < 34; i++) {
        const c = rgba(shade([0.74, 0.52, 0.78], 0.95 + rng() * 0.1));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }

    // ------------------------------------------------------------ brewing stand
    case T.BREW_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.45, 0.44, 0.48], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the round top plate with a socket for the ingredient
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) {
        const c = rgba(shade([0.58, 0.56, 0.60], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
        const c = rgba([0.18, 0.20, 0.24]); p.px(x, y, c[0], c[1], c[2]);
      }
      const g = rgba([0.95, 0.80, 0.45]);
      for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) p.px(x, y, g[0], g[1], g[2]);
      break;
    }
    case T.BREW_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.40, 0.39, 0.43], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // a narrow stone base with the glass column above it
      for (let x = 0; x < 16; x++) for (let y = 11; y < 16; y++) {
        const c = rgba(shade([0.52, 0.50, 0.55], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 3; y < 11; y++) {
        for (const x of [6, 7, 8, 9]) {
          const c = rgba([0.30, 0.55, 0.75], 210);
          p.px(x, y, c[0], c[1], c[2], 210);
        }
      }
      break;
    }

    // ------------------------------------------------------------ redstone
    case T.REDSTONE_BLOCK: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.72, 0.10, 0.08], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 30; i++) {
        const c = rgba(shade([0.95, 0.30, 0.20], 0.95 + rng() * 0.1));
        p.px((rng() * 16) | 0, (rng() * 16) | 0, c[0], c[1], c[2]);
      }
      break;
    }
    case T.REDSTONE_ORE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.52, 0.52, 0.54], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 7; i++) {
        const bx = 2 + ((rng() * 12) | 0), by = 2 + ((rng() * 12) | 0);
        for (let k = 0; k < 4; k++) {
          const c = rgba(mix([0.85, 0.12, 0.10], [1.0, 0.45, 0.35], rng()));
          p.px(bx + ((rng() * 3) | 0) - 1, by + ((rng() * 3) | 0) - 1, c[0], c[1], c[2]);
          void k;
        }
      }
      break;
    }
    case T.REDSTONE_WIRE: {
      // a thin cross of dust on a transparent tile; strength tints it below
      p.clear();
      const a = p.a;
      void a;
      for (let i = 2; i < 14; i++) {
        const c = rgba([0.80, 0.10, 0.08]);
        p.px(i, 7, c[0], c[1], c[2]);
        p.px(i, 8, c[0], c[1], c[2]);
        p.px(7, i, c[0], c[1], c[2]);
        p.px(8, i, c[0], c[1], c[2]);
      }
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
        const c = rgba([0.90, 0.18, 0.12]);
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.REDSTONE_TORCH: {
      p.clear();
      for (let y = 6; y < 16; y++) for (let x = 7; x < 9; x++) {
        const c = rgba(shade([0.45, 0.30, 0.18], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 3; y < 7; y++) for (let x = 6; x < 10; x++) {
        const c = rgba(mix([0.95, 0.20, 0.14], [1.0, 0.60, 0.40], rng()));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const g = rgba([1.0, 0.75, 0.55]);
      for (const [x, y] of [[7, 4], [8, 4], [7, 5], [8, 5]]) p.px(x, y, g[0], g[1], g[2]);
      break;
    }
    case T.LEVER: {
      p.clear();
      for (let y = 6; y < 10; y++) for (let x = 3; x < 13; x++) {
        const c = rgba(shade([0.55, 0.52, 0.48], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 2; y < 7; y++) for (let x = 7; x < 9; x++) {
        const c = rgba(shade([0.35, 0.30, 0.26], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      const k = rgba([0.80, 0.25, 0.18]);
      for (let y = 0; y < 3; y++) for (let x = 7; x < 9; x++) p.px(x, y, k[0], k[1], k[2]);
      break;
    }
    case T.BUTTON: {
      p.clear();
      for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
        const c = rgba(shade([0.62, 0.60, 0.58], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
        const c = rgba(shade([0.78, 0.76, 0.74], 0.95 + rng() * 0.1));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.PLATE: {
      p.clear();
      for (let y = 4; y < 12; y++) for (let x = 2; x < 14; x++) {
        const c = rgba(shade([0.60, 0.58, 0.55], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 2; x < 14; x++) {
        const c = rgba([0.70, 0.68, 0.65]); p.px(x, 4, c[0], c[1], c[2]);
        const d = rgba([0.44, 0.42, 0.40]); p.px(x, 11, d[0], d[1], d[2]);
      }
      break;
    }
    case T.LAMP_OFF: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.28, 0.22], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
        const c = rgba(shade([0.55, 0.30, 0.22], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.LAMP_ON: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.55, 0.32, 0.24], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
        const t = 1 - Math.abs(x - 7.5) / 8 - Math.abs(y - 7.5) / 8;
        const c = rgba(mix([0.95, 0.65, 0.35], [1.0, 0.92, 0.70], Math.max(0, t)));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.PISTON_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.68, 0.62, 0.48], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 0; i < 16; i++) {
        const c = rgba([0.52, 0.46, 0.34]);
        p.px(i, 0, c[0], c[1], c[2]); p.px(i, 15, c[0], c[1], c[2]);
        p.px(0, i, c[0], c[1], c[2]); p.px(15, i, c[0], c[1], c[2]);
      }
      break;
    }
    case T.PISTON_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.62, 0.56, 0.42], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.74, 0.68, 0.52]); p.px(x, 2, c[0], c[1], c[2]); }
      for (let x = 0; x < 16; x++) { const c = rgba([0.46, 0.41, 0.30]); p.px(x, 3, c[0], c[1], c[2]); }
      break;
    }
    case T.PISTON_FACE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.78, 0.72, 0.56], 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) {
        const c = rgba(shade([0.66, 0.60, 0.46], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.PISTON_BACK: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.55, 0.50, 0.38], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) {
        const c = rgba([0.40, 0.36, 0.26]); p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.PISTON_ARM:
    case T.PISTON_ARM_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const base = K === T.PISTON_ARM ? [0.72, 0.66, 0.50] : [0.80, 0.74, 0.58];
        const c = rgba(shade(base, 0.92 + rng() * 0.16));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.50, 0.45, 0.33]); p.px(x, 0, c[0], c[1], c[2]); }
      break;
    }

    // ------------------------------------------------------------ item logistics
    case T.HOPPER_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.30, 0.30, 0.33], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the open funnel mouth
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) {
        const c = rgba([0.10, 0.10, 0.12]); p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 3; i < 13; i++) {
        const c = rgba(shade([0.42, 0.42, 0.46], 1.05));
        p.px(i, 3, c[0], c[1], c[2]); p.px(i, 12, c[0], c[1], c[2]);
        p.px(3, i, c[0], c[1], c[2]); p.px(12, i, c[0], c[1], c[2]);
      }
      break;
    }
    case T.HOPPER_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.32, 0.32, 0.35], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) {
        const c = rgba([0.44, 0.44, 0.48]); p.px(x, 1, c[0], c[1], c[2]);
        const d = rgba([0.20, 0.20, 0.23]); p.px(x, 2, d[0], d[1], d[2]);
      }
      // the tapered spout
      for (let y = 10; y < 16; y++) {
        const w = 5 - Math.floor((y - 10) / 2);
        for (let x = 8 - w; x <= 7 + w; x++) {
          const c = rgba(shade([0.38, 0.38, 0.42], 0.95 + rng() * 0.12));
          p.px(x, y, c[0], c[1], c[2]);
        }
      }
      break;
    }
    case T.DISPENSER_TOP: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.42, 0.42, 0.44], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let i = 4; i < 12; i++) {
        const c = rgba([0.28, 0.28, 0.30]); p.px(i, 4, c[0], c[1], c[2]);
        p.px(i, 11, c[0], c[1], c[2]); p.px(4, i, c[0], c[1], c[2]); p.px(11, i, c[0], c[1], c[2]);
      }
      break;
    }
    case T.DISPENSER_SIDE: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.44, 0.44, 0.46], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 0; x < 16; x++) { const c = rgba([0.30, 0.30, 0.32]); p.px(x, 7, c[0], c[1], c[2]); }
      for (let x = 0; x < 16; x++) { const c = rgba([0.54, 0.54, 0.56]); p.px(x, 8, c[0], c[1], c[2]); }
      break;
    }
    case T.DISPENSER_FRONT: {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const c = rgba(shade([0.46, 0.46, 0.48], 0.9 + rng() * 0.2));
        p.px(x, y, c[0], c[1], c[2]);
      }
      // the barrel mouth
      for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
        const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
        const c = rgba(d < 2.5 ? [0.08, 0.08, 0.10] : [0.16, 0.16, 0.18]);
        p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }
    case T.REPEATER: {
      p.clear();
      // stone base slab with a redstone line across it
      for (let y = 4; y < 12; y++) for (let x = 2; x < 14; x++) {
        const c = rgba(shade([0.62, 0.60, 0.56], 0.94 + rng() * 0.12));
        p.px(x, y, c[0], c[1], c[2]);
      }
      for (let x = 2; x < 14; x++) {
        const c = rgba([0.80, 0.12, 0.10]); p.px(x, 7, c[0], c[1], c[2]);
        p.px(x, 8, c[0], c[1], c[2]);
      }
      // the two torches
      for (let y = 1; y < 6; y++) {
        const c = rgba(shade([0.42, 0.28, 0.16], 0.95 + rng() * 0.1));
        p.px(3, y, c[0], c[1], c[2]); p.px(4, y, c[0], c[1], c[2]);
        p.px(11, y, c[0], c[1], c[2]); p.px(12, y, c[0], c[1], c[2]);
      }
      for (let y = 0; y < 2; y++) for (let x = 3; x < 5; x++) {
        const c = rgba([0.95, 0.22, 0.16]); p.px(x, y, c[0], c[1], c[2]);
      }
      for (let y = 0; y < 2; y++) for (let x = 11; x < 13; x++) {
        const c = rgba([0.95, 0.22, 0.16]); p.px(x, y, c[0], c[1], c[2]);
      }
      break;
    }

    default: {
      const c = rgba(base);
      p.fill(c[0], c[1], c[2]);
    }
  }

  // glowstone-style bloom: brighten the tile
  if (d.glow) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const c = p.get(x, y);
      p.px(x, y, Math.min(255, c[0] + 60), Math.min(255, c[1] + 50), Math.min(255, c[2] + 20), c[3]);
    }
  }
}

/**
 * Paint every block tile exactly once and hand the results to two consumers:
 *   - `layerPixel(index, x, y)` for the WebGL2 texture array (one tile per layer, the
 *     correct fix for distance aliasing: every tile keeps its own mip pyramid),
 *   - `blitToAtlas(index, dest)` for the packed 2D atlas that the HUD icons sample.
 */
export function paintAllTiles(layerPixel, blitToAtlas) {
  const scratch = new Uint8Array(TILE_PX * TILE_PX * 4);
  for (let id = 0; id < BLOCKS.length; id++) {
    const b = BLOCKS[id];
    if (!b || id === 0) continue;
    for (let face = 0; face < ATLAS_SLOTS; face++) {
      const tileIndex = id * ATLAS_SLOTS + face;
      if (tileIndex >= ATLAS_TILE_COUNT) break;
      scratch.fill(0);
      const p = new TilePainter(scratch, 0, 0);
      const desc = b.tex[Math.min(face, b.tex.length - 1)] || b.tex[0];
      paintTile(p, desc, (id * 7919 + face * 104729 + 12345) | 0);
      const mirror = !!desc.mirror && face < 4;
      const flipY = !!desc.flipY;
      if (layerPixel) {
        for (let y = 0; y < TILE_PX; y++) {
          const sy = flipY ? TILE_PX - 1 - y : y;
          for (let x = 0; x < TILE_PX; x++) {
            const sx = mirror ? TILE_PX - 1 - x : x;
            const si = (sy * TILE_PX + sx) * 4;
            layerPixel(tileIndex, x, y, scratch[si], scratch[si + 1], scratch[si + 2], scratch[si + 3]);
          }
        }
      }
      if (blitToAtlas) blitToAtlas(tileIndex, scratch, mirror, flipY);
    }
  }
}

/** Build the packed 2D atlas (used by the HUD icon renderer). */
export function generateAtlasPixels() {
  const buf = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  paintAllTiles(null, (tileIndex, scratch, mirror, flipY) => {
    const tx = tileIndex % ATLAS_COLS, ty = (tileIndex / ATLAS_COLS) | 0;
    const ox = tx * TILE_PX, oy = ty * TILE_PX;
    for (let y = 0; y < TILE_PX; y++) {
      const sy = flipY ? TILE_PX - 1 - y : y;
      for (let x = 0; x < TILE_PX; x++) {
        const sx = mirror ? TILE_PX - 1 - x : x;
        const si = (sy * TILE_PX + sx) * 4;
        const di = ((oy + y) * ATLAS_W + ox + x) * 4;
        buf[di] = scratch[si]; buf[di + 1] = scratch[si + 1];
        buf[di + 2] = scratch[si + 2]; buf[di + 3] = scratch[si + 3];
      }
    }
  });
  return buf;
}

/**
 * UV rect for one tile, in tile-local space.
 * With a texture array each layer is a single tile, so the rect is the whole layer minus
 * half a texel — enough to keep bilinear filtering from wrapping to the opposite edge.
 */
export function tileUV(_tileIndex) {
  const inset = 0.5 / TILE_PX;
  return [inset, inset, 1 - inset * 2, 1 - inset * 2];
}
