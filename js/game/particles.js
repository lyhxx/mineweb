// game/particles.js — block break/land/explosion particles with a fixed-size pool.
import { TILE, ATLAS_SLOTS } from '../core/blocks.js';
import { tileUV } from '../core/atlas.js';

const MAX = 200;

export class Particles {
  constructor(world) {
    this.world = world;
    this.pool = [];
    for (let i = 0; i < MAX; i++) {
      this.pool.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 0.1, u0: 0, v0: 0, u1: 1, v1: 1, layer: 0, gravity: 20,
      });
    }
    this.head = 0;
  }

  spawnBlockBreak(wx, wy, wz, id, count = 14) {
    const layer = TILE[id * ATLAS_SLOTS + 4];
    const [u0, v0, du, dv] = tileUV(layer);
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.head];
      this.head = (this.head + 1) % MAX;
      const cu = u0 + Math.random() * du * 0.75;
      const cv = v0 + Math.random() * dv * 0.75;
      p.alive = true;
      p.x = wx + 0.15 + Math.random() * 0.7;
      p.y = wy + 0.15 + Math.random() * 0.7;
      p.z = wz + 0.15 + Math.random() * 0.7;
      p.vx = (Math.random() - 0.5) * 2.2;
      p.vy = 1.2 + Math.random() * 2.4;
      p.vz = (Math.random() - 0.5) * 2.2;
      p.life = 0;
      p.maxLife = 0.7 + Math.random() * 0.7;
      p.size = 0.035 + Math.random() * 0.03;
      p.u0 = cu; p.v0 = cv;
      p.u1 = cu + du * 0.22; p.v1 = cv + dv * 0.22;
      p.layer = layer;
      p.gravity = 22;
    }
  }

  spawnDig(wx, wy, wz, id, nx, ny, nz, count = 3) {
    const layer = TILE[id * ATLAS_SLOTS + 4];
    const [u0, v0, du, dv] = tileUV(layer);
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.head];
      this.head = (this.head + 1) % MAX;
      p.alive = true;
      p.x = wx + 0.5 + nx * 0.55 + (Math.random() - 0.5) * 0.3;
      p.y = wy + 0.5 + ny * 0.55 + (Math.random() - 0.5) * 0.3 + 0.25;
      p.z = wz + 0.5 + nz * 0.55 + (Math.random() - 0.5) * 0.3;
      p.vx = nx * 0.6 + (Math.random() - 0.5) * 0.8;
      p.vy = 0.6 + Math.random() * 1.1;
      p.vz = nz * 0.6 + (Math.random() - 0.5) * 0.8;
      p.life = 0;
      p.maxLife = 0.35 + Math.random() * 0.4;
      p.size = 0.028 + Math.random() * 0.022;
      const cu = u0 + Math.random() * du * 0.8, cv = v0 + Math.random() * dv * 0.8;
      p.u0 = cu; p.v0 = cv; p.u1 = cu + du * 0.2; p.v1 = cv + dv * 0.2;
      p.layer = layer;
      p.gravity = 18;
    }
  }

  spawnExplosion(x, y, z, count = 60) {
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.head];
      this.head = (this.head + 1) % MAX;
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
      const s = 3 + Math.random() * 7;
      p.alive = true;
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.cos(a) * Math.cos(e) * s;
      p.vy = Math.sin(e) * s + 2;
      p.vz = Math.sin(a) * Math.cos(e) * s;
      p.life = 0;
      p.maxLife = 0.6 + Math.random() * 0.9;
      p.size = 0.06 + Math.random() * 0.09;
      // lava tile, so the fireball reads as molten rock
      const [eu0, ev0, edu, edv] = tileUV(TILE[10 * ATLAS_SLOTS + 4]);
      const cu = eu0 + Math.random() * edu;
      p.u0 = cu; p.v0 = ev0 + Math.random() * edv * 0.8;
      p.u1 = cu + edu * 0.25; p.v1 = p.v0 + edv * 0.25;
      p.layer = TILE[10 * ATLAS_SLOTS + 4];
      p.gravity = 6;
    }
  }

  spawnSplash(x, y, z, count = 24) {
    const layer = TILE[9 * ATLAS_SLOTS + 4];
    const [wu0, wv0, wdu, wdv] = tileUV(layer);
    for (let i = 0; i < count; i++) {
      const p = this.pool[this.head];
      this.head = (this.head + 1) % MAX;
      p.alive = true;
      p.x = x + (Math.random() - 0.5) * 0.8;
      p.y = y + Math.random() * 0.3;
      p.z = z + (Math.random() - 0.5) * 0.8;
      p.vx = (Math.random() - 0.5) * 2.5;
      p.vy = 1.5 + Math.random() * 3;
      p.vz = (Math.random() - 0.5) * 2.5;
      p.life = 0;
      p.maxLife = 0.5 + Math.random() * 0.5;
      p.size = 0.03 + Math.random() * 0.03;
      const cu = wu0 + Math.random() * wdu * 0.8;
      const cv = wv0 + Math.random() * wdv * 0.8;
      p.u0 = cu; p.v0 = cv; p.u1 = cu + wdu * 0.2; p.v1 = cv + wdv * 0.2;
      p.layer = layer;
      p.gravity = 20;
    }
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; continue; }
      p.vy -= p.gravity * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      // cheap voxel collision: stop on solid ground
      if (this.world && this.world.isSolidAt(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        p.vx *= 0.4; p.vz *= 0.4; p.vy = 0;
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
    }
  }

  active() {
    const out = [];
    for (const p of this.pool) if (p.alive) out.push(p);
    return out;
  }

  get count() { let n = 0; for (const p of this.pool) if (p.alive) n++; return n; }
}
