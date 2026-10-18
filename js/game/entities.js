// game/entities.js — mobs, dropped items, and the box models used to draw them.
//
// Passive mobs wander and flee; hostile mobs spawn in the dark, path straight at the
// player and deal contact damage. Physics is a simple swept-AABB against the voxel grid.
import { makeRng, clamp } from '../core/math.js';
import { SOLID, LIQUID, baseId, BLOCKS } from '../core/blocks.js';
import { WORLD_H } from '../world/chunk.js';
import { tileUV } from '../core/atlas.js';
import { TILE, ATLAS_SLOTS } from '../core/blocks.js';

const GRAVITY = 32;

export const MOB_DEFS = {
  pig: {
    name: '猪', hp: 10, width: 0.9, height: 0.9, speed: 1.3, passive: true,
    body: [0.95, 0.72, 0.38, 0.62], accent: [0.98, 0.62, 0.62, 0.42],
    sound: 'pig', xp: 1,
  },
  cow: {
    name: '牛', hp: 10, width: 0.9, height: 1.3, speed: 1.2, passive: true,
    body: [0.34, 0.24, 0.18, 0.55], accent: [0.86, 0.84, 0.80, 0.85],
    sound: 'cow', xp: 1,
  },
  sheep: {
    name: '羊', hp: 8, width: 0.9, height: 1.2, speed: 1.25, passive: true,
    body: [0.94, 0.94, 0.92, 0.9], accent: [0.22, 0.20, 0.20, 0.55],
    sound: 'sheep', xp: 1,
  },
  chicken: {
    name: '鸡', hp: 4, width: 0.5, height: 0.7, speed: 1.1, passive: true,
    body: [0.95, 0.95, 0.94, 0.9], accent: [0.92, 0.45, 0.15, 0.9],
    sound: 'chicken', xp: 1,
  },
  zombie: {
    name: '僵尸', hp: 20, width: 0.6, height: 1.9, speed: 1.35, passive: false,
    body: [0.30, 0.55, 0.34, 0.9], accent: [0.20, 0.35, 0.24, 0.9],
    sound: 'zombie', xp: 5, damage: 3, hostile: true,
  },
  spider: {
    name: '蜘蛛', hp: 16, width: 1.4, height: 0.85, speed: 1.9, passive: false,
    body: [0.22, 0.16, 0.14, 0.95], accent: [0.42, 0.10, 0.10, 0.95],
    sound: 'spider', xp: 5, damage: 2, hostile: true, jumps: true, climbs: true, eyes: 4,
  },
  creeper: {
    name: '苦力怕', hp: 20, width: 0.6, height: 1.7, speed: 1.3, passive: false,
    body: [0.30, 0.62, 0.30, 0.9], accent: [0.10, 0.14, 0.10, 0.9],
    sound: 'creeper', xp: 5, damage: 0, hostile: true, explodes: true,
  },
  // Villagers are passive but trade instead of dropping loot. The profession decides
  // which trade table they roll, and it is stored on the mob so it survives the session.
  villager: {
    name: '村民', hp: 20, width: 0.6, height: 1.9, speed: 0.8, passive: true,
    body: [0.62, 0.48, 0.36, 0.95], accent: [0.34, 0.42, 1.0, 0.62],
    sound: 'villager', xp: 0, trades: true, noDespawn: true,
  },
  // The Ender Dragon is not a normal mob: it flies, ignores gravity, and is spawned
  // explicitly by the End dimension rather than by the night-time spawner.
  ender_dragon: {
    name: '末影龙', hp: 200, width: 8, height: 4, speed: 3.2, passive: false,
    body: [0.10, 0.08, 0.14, 1.0], accent: [0.42, 0.12, 0.55, 1.0],
    sound: 'dragon', xp: 500, damage: 6, hostile: true, boss: true, flies: true,
  },
  skeleton: {    name: '骷髅', hp: 20, width: 0.6, height: 1.95, speed: 1.4, passive: false,
    body: [0.85, 0.85, 0.82, 0.9], accent: [0.55, 0.55, 0.52, 0.9],
    sound: 'skeleton', xp: 5, damage: 2, hostile: true, ranged: true,
  },
};

let nextId = 1;

export class Mob {
  constructor(kind, x, y, z) {
    this.id = nextId++;
    this.kind = kind;
    this.def = MOB_DEFS[kind];
    this.x = x; this.y = y; this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = Math.random() * Math.PI * 2;
    this.hp = this.def.hp;
    this.maxHp = this.def.hp;
    this.onGround = false;
    this.wanderTimer = 0;
    this.moveX = 0; this.moveZ = 0;
    this.hurtTime = 0;
    this.attackCooldown = 0;
    this.fleeTime = 0;
    this.life = 0;
    this.dead = false;
    this.legPhase = Math.random() * 10;
    this.fuse = -1;
    this.burning = false;
    this.soundTimer = 2 + Math.random() * 6;
  }

  get width() { return this.def.width; }
  get height() { return this.def.height; }

  aabb() {
    const hw = this.width / 2;
    return { minX: this.x - hw, maxX: this.x + hw, minY: this.y, maxY: this.y + this.height, minZ: this.z - hw, maxZ: this.z + hw };
  }

  collides(world, minX, minY, minZ, maxX, maxY, maxZ) {
    const x0 = Math.floor(minX + 1e-6), x1 = Math.floor(maxX - 1e-6);
    const y0 = Math.floor(minY + 1e-6), y1 = Math.floor(maxY - 1e-6);
    const z0 = Math.floor(minZ + 1e-6), z1 = Math.floor(maxZ - 1e-6);
    for (let y = y0; y <= y1; y++) {
      if (y < 0) return true;
      if (y >= WORLD_H) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (SOLID[baseId(world.getBlockRaw(x, y, z))]) return true;
        }
      }
    }
    return false;
  }

  update(dt, world, player, api) {
    this.life += dt;
    if (this.dead) return;
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.soundTimer -= dt;
    if (this.soundTimer <= 0) {
      this.soundTimer = 6 + Math.random() * 14;
      if (api && api.sound && Math.random() < 0.5) api.sound(this.def.sound);
    }

    const hostile = !!this.def.hostile;
    const distToPlayer = Math.hypot(player.x - this.x, player.y - this.y, player.z - this.z);
    const night = api && api.isNight ? api.isNight() : false;

    // ---- decide movement
    let wantX = 0, wantZ = 0;
    if (this.fleeTime > 0) {
      this.fleeTime -= dt;
      const dx = this.x - player.x, dz = this.z - player.z;
      const d = Math.hypot(dx, dz) || 1;
      wantX = dx / d; wantZ = dz / d;
    } else if (hostile && distToPlayer < 24 && player.mode !== 'creative') {
      const dx = player.x - this.x, dz = player.z - this.z;
      const d = Math.hypot(dx, dz) || 1;
      wantX = dx / d; wantZ = dz / d;
      if (distToPlayer < 1.6 && this.attackCooldown <= 0 && !this.def.ranged) {
        this.attackCooldown = 1.0;
        if (api && api.hurtPlayer) api.hurtPlayer(this.def.damage || 2, this);
      }
      // skeletons loose an arrow from a distance
      if (this.def.ranged && distToPlayer < 16 && distToPlayer > 3 && this.attackCooldown <= 0) {
        this.attackCooldown = 1.8;
        if (api && api.mobShoot) api.mobShoot(this, player);
      }
      // spiders pounce when they get close
      if (this.def.jumps && distToPlayer < 4.5 && this.onGround && this.attackCooldown <= 0.4) {
        this.vy = 7.5;
        this.vx += (player.x - this.x) * 0.6;
        this.vz += (player.z - this.z) * 0.6;
      }
      if (this.def.explodes && distToPlayer < 3.0) {
        if (this.fuse < 0) this.fuse = 1.5;
      }
    } else {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2 + Math.random() * 5;
        if (Math.random() < 0.55) {
          this.yaw = Math.random() * Math.PI * 2;
          this.moveX = Math.sin(this.yaw); this.moveZ = -Math.cos(this.yaw);
        } else {
          this.moveX = 0; this.moveZ = 0;
        }
      }
      wantX = this.moveX; wantZ = this.moveZ;
    }

    if (this.fuse > 0) {
      this.fuse -= dt;
      if (this.fuse <= 0) {
        this.dead = true;
        if (api && api.explode) api.explode(this.x, this.y + 0.5, this.z, 3.4);
        return;
      }
    }

    // ---- daylight burning for undead
    if (hostile && (this.kind === 'zombie' || this.kind === 'skeleton')) {
      const sky = api && api.skyLightAt ? api.skyLightAt(Math.floor(this.x), Math.floor(this.y + this.height), Math.floor(this.z)) : 0;
      this.burning = !night && sky >= 14;
      if (this.burning) {
        this.burnTimer = (this.burnTimer || 0) + dt;
        if (this.burnTimer > 1) { this.burnTimer = 0; this.damage(1, api); }
      } else this.burnTimer = 0;
    }

    // ---- boss flight: circle the island at a fixed altitude, dive at the player
    if (this.def.flies) {
      this.legPhase += dt * 2.2;
      const wanted = 74;
      const chase = distToPlayer < 34;
      this.bossTimer = (this.bossTimer || 0) + dt;
      if (chase) {
        // swoop: aim straight at the player, keeping some height
        const k = Math.min(1, 1.2 * dt);
        this.vx += ((player.x - this.x) * 0.8 - this.vx) * k;
        this.vz += ((player.z - this.z) * 0.8 - this.vz) * k;
        this.vy += ((player.y + 3 - this.y) * 0.8 - this.vy) * k;
      } else {
        // patrol: slowly circle the origin, staying high
        const ang = Math.atan2(this.z, this.x) + dt * 0.22;
        const r = 40;
        const tx = Math.cos(ang) * r, tz = Math.sin(ang) * r;
        const k = Math.min(1, 0.6 * dt);
        this.vx += ((tx - this.x) * 0.5 - this.vx) * k;
        this.vz += ((tz - this.z) * 0.5 - this.vz) * k;
        this.vy += ((wanted - this.y) * 0.9 - this.vy) * k;
      }
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      // the dragon's head is also on local -Z, so the same convention as other mobs
      if (Math.hypot(this.vx, this.vz) > 0.5) this.yaw = Math.atan2(-this.vx, -this.vz);
      this.onGround = false;
      // contact damage
      if (distToPlayer < 3.4 && this.attackCooldown <= 0) {
        this.attackCooldown = 1.4;
        if (api && api.hurtPlayer) api.hurtPlayer(this.def.damage || 6, this);
      }
      this.attackCooldown -= dt;
      return;
    }

    // ---- physics
    const speed = this.def.speed * (this.fleeTime > 0 ? 1.5 : 1) * (night && hostile ? 1.1 : 1);
    const targetVX = wantX * speed, targetVZ = wantZ * speed;
    const accel = this.onGround ? 22 : 8;
    this.vx += (targetVX - this.vx) * Math.min(1, accel * dt);
    this.vz += (targetVZ - this.vz) * Math.min(1, accel * dt);
    // Face the direction of travel. Only update while actually moving, so an idle mob
    // keeps looking where it last went instead of snapping around. The model's front is
    // local -Z, and m4aim maps local +Z to (sin yaw, cos yaw), hence the negated atan2.
    const horiz = Math.hypot(this.vx, this.vz);
    if (horiz > 0.35) this.yaw = Math.atan2(-this.vx, -this.vz);

    const hw = this.width / 2;
    const inWater = LIQUID[baseId(world.getBlockRaw(Math.floor(this.x), Math.floor(this.y + 0.2), Math.floor(this.z)))] === 1;
    if (inWater) {
      this.vy += (3.0 - this.vy) * Math.min(1, 6 * dt);
    } else if (this.def.climbs && Math.hypot(this.vx, this.vz) > 0.5) {
      // spiders walk up walls: while pushing into a wall, drift up instead of stalling
      this.vy -= GRAVITY * dt;
      if (this.vy < -50) this.vy = -50;
      if (this.blockedX || this.blockedZ) this.vy = Math.max(this.vy, 3.2);
    } else {
      this.vy -= GRAVITY * dt;
      if (this.vy < -50) this.vy = -50;
    }

    const slide = (axis, delta) => {
      if (delta === 0) return;
      const tryMove = (lift) => {
        const by = this.y + lift;
        if (axis === 'x') {
          const nx = this.x + delta;
          if (!this.collides(world, nx - hw, by, this.z - hw, nx + hw, by + this.height, this.z + hw)) { this.y = by; this.x = nx; return true; }
        } else {
          const nz = this.z + delta;
          if (!this.collides(world, this.x - hw, by, nz - hw, this.x + hw, by + this.height, nz + hw)) { this.y = by; this.z = nz; return true; }
        }
        return false;
      };
      if (tryMove(0)) return;
      if (this.onGround || inWater) {
        for (const lift of [0.25, 0.55, 1.0]) if (tryMove(lift)) return;
      }
      if (axis === 'x') { this.vx = 0; this.blockedX = true; } else { this.vz = 0; this.blockedZ = true; }
    };
    this.blockedX = false;
    this.blockedZ = false;
    slide('x', this.vx * dt);
    slide('z', this.vz * dt);

    const ny = this.y + this.vy * dt;
    if (this.collides(world, this.x - hw, ny, this.z - hw, this.x + hw, ny + this.height, this.z + hw)) {
      if (this.vy < 0) {
        this.y = Math.floor(ny) + 1;
        this.onGround = true;
        // hop over one-block obstacles
        if (Math.hypot(this.vx, this.vz) > 0.3 && Math.random() < 0.12) this.vy = 8.2;
      }
      this.vy = 0;
    } else {
      this.y = ny;
      if (this.vy < 0) this.onGround = false;
    }
    if (this.y < -8) this.dead = true;

    // animation phase
    this.legPhase += Math.hypot(this.vx, this.vz) * dt * 6;

    // despawn if absurdly far away (trading partners stay put)
    if (distToPlayer > 96 && !this.def.noDespawn) this.dead = true;
  }

  damage(amount, api) {
    // the dragon shrugs off nothing, but it heals while crystals are alive
    this.hp -= amount;
    this.hurtTime = 0.35;
    if (this.def.passive) { this.fleeTime = 5; }
    if (this.hp <= 0) this.kill(api);
    else if (api && api.sound) api.sound(this.def.sound);
  }

  /** Called every frame for the dragon: regenerate while any healing crystal lives. */
  bossTick(dt, crystalsAlive) {
    if (!this.def.boss) return;
    if (crystalsAlive > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + 2.5 * dt);
    }
  }

  kill(api) {
    this.dead = true;
    if (api && api.onMobDeath) api.onMobDeath(this);
  }
}

/** Build the list of boxes used to draw a mob, in mob-local space (feet at y=0). */
export function mobParts(mob) {
  const d = mob.def;
  const body = d.body, accent = d.accent;
  const parts = [];
  const legSwing = Math.sin(mob.legPhase) * 0.5;
  const legSwing2 = Math.sin(mob.legPhase + Math.PI) * 0.5;
  const h = d.height;
  const w = d.width;

  if (mob.kind === 'ender_dragon') {
    // a long segmented body, two big wings, a head and a tail — all in one flat colour
    // with a violet sheen so it reads at a distance
    const wing = Math.sin(mob.legPhase * 1.6) * 0.55;
    parts.push({ x: -1.1, y: 0.9, z: -1.4, w: 2.2, h: 1.2, d: 2.8, color: body });   // torso
    parts.push({ x: -0.6, y: 1.3, z: -2.8, w: 1.2, h: 1.0, d: 1.6, color: body });   // neck base
    parts.push({ x: -0.5, y: 1.5, z: -4.2, w: 1.0, h: 0.9, d: 1.6, color: accent }); // head
    parts.push({ x: -0.55, y: 1.7, z: -5.4, w: 1.1, h: 0.6, d: 1.0, color: body });  // snout
    // two glowing eyes
    for (const side of [-0.30, 0.30]) {
      parts.push({ x: side - 0.08, y: 1.95, z: -4.9, w: 0.16, h: 0.16, d: 0.10, color: [0.95, 0.35, 1.0, 1] });
    }
    // wings, flapping
    for (const side of [-1, 1]) {
      parts.push({
        x: side * 1.0, y: 1.5, z: -0.6, w: 4.2, h: 0.22, d: 2.6,
        color: accent, rotY: side * (0.25 + wing * 0.35), rotZ: side * (0.18 + wing * 0.30),
      });
    }
    // tail, tapering
    for (let i = 0; i < 5; i++) {
      const t = i / 5;
      parts.push({
        x: -0.55 + t * 0.0, y: 0.9 - t * 0.35, z: 1.4 + i * 1.1,
        w: 1.3 - t * 0.9, h: 0.85 - t * 0.55, d: 1.1, color: body,
      });
    }
    return parts;
  }

  if (mob.kind === 'chicken') {
    parts.push({ x: -w / 2, y: h * 0.35, z: -w / 2, w, h: h * 0.5, d: w, color: body });
    parts.push({ x: -w * 0.3, y: h * 0.85, z: -w * 0.3, w: w * 0.6, h: h * 0.3, d: w * 0.6, color: body });
    parts.push({ x: -0.06, y: h * 1.0, z: -w * 0.55, w: 0.12, h: 0.12, d: 0.12, color: accent });
    return parts;
  }

  if (mob.kind === 'spider') {
    // low body + two body segments + eight angled legs; four red eyes on the front
    const legPhase2 = Math.sin(mob.legPhase);
    parts.push({ x: -w * 0.34, y: h * 0.30, z: -w * 0.34, w: w * 0.68, h: h * 0.55, d: w * 0.62, color: body });
    parts.push({ x: -w * 0.26, y: h * 0.36, z: w * 0.24, w: w * 0.52, h: h * 0.48, d: w * 0.42, color: body });
    // head block at the front
    parts.push({ x: -w * 0.22, y: h * 0.42, z: -w * 0.62, w: w * 0.44, h: h * 0.42, d: w * 0.32, color: body });
    // eyes (tiny bright boxes on the head)
    for (const [ex, ey] of [[-0.16, 0.62], [-0.05, 0.66], [0.05, 0.66], [0.16, 0.62]]) {
      parts.push({ x: ex * w, y: h * ey, z: -w * 0.66, w: w * 0.09, h: h * 0.09, d: 0.05, color: [0.95, 0.12, 0.12, 1] });
    }
    // legs: four per side, splayed out and slightly angled by the walk phase
    for (let i = 0; i < 4; i++) {
      const zOff = -w * 0.30 + i * (w * 0.22);
      const swing = Math.sin(mob.legPhase + i * 1.6) * 0.35;
      for (const side of [-1, 1]) {
        parts.push({
          x: side * w * 0.28, y: h * 0.20, z: zOff,
          w: w * 0.42, h: 0.10, d: 0.10, color: accent,
          rotY: side * (0.5 + swing), rotZ: side * 0.35,
        });
      }
    }
    void legPhase2;
    return parts;
  }

  // legs
  const legH = h * 0.42;
  const legW = w * 0.28;
  parts.push({ x: -w / 2 + 0.02, y: 0, z: -w / 2 + 0.02, w: legW, h: legH, d: legW, color: accent, rotX: legSwing, pivot: 'top' });
  parts.push({ x: w / 2 - legW - 0.02, y: 0, z: -w / 2 + 0.02, w: legW, h: legH, d: legW, color: accent, rotX: legSwing2, pivot: 'top' });
  parts.push({ x: -w / 2 + 0.02, y: 0, z: w / 2 - legW - 0.02, w: legW, h: legH, d: legW, color: accent, rotX: legSwing2, pivot: 'top' });
  parts.push({ x: w / 2 - legW - 0.02, y: 0, z: w / 2 - legW - 0.02, w: legW, h: legH, d: legW, color: accent, rotX: legSwing, pivot: 'top' });

  // torso
  const torsoH = h * 0.55;
  parts.push({ x: -w / 2, y: legH, z: -w / 2, w, h: torsoH, d: w, color: body });

  if (mob.kind === 'zombie' || mob.kind === 'skeleton') {
    // arms held forward, Minecraft-zombie style
    const armH = torsoH * 0.85;
    parts.push({ x: -w / 2 - 0.06, y: legH + torsoH * 0.75, z: -w / 2, w: 0.18, h: armH, d: 0.18, color: accent, rotX: -1.3 });
    parts.push({ x: w / 2 - 0.12, y: legH + torsoH * 0.75, z: -w / 2, w: 0.18, h: armH, d: 0.18, color: accent, rotX: -1.3 });
    // head
    parts.push({ x: -w * 0.42, y: legH + torsoH, z: -w * 0.42, w: w * 0.84, h: h * 0.24, d: w * 0.84, color: body });
    return parts;
  }

  if (mob.kind === 'creeper') {
    parts.push({ x: -w * 0.42, y: legH + torsoH, z: -w * 0.42, w: w * 0.84, h: h * 0.26, d: w * 0.84, color: body });
    return parts;
  }

  // quadrupeds: head + snout
  const headY = legH + torsoH * 0.72;
  const headSize = w * 0.62;
  parts.push({ x: -headSize / 2 - w * 0.02, y: headY, z: -w * 0.72, w: headSize, h: headSize, d: headSize, color: body });
  parts.push({ x: -headSize * 0.28, y: headY + headSize * 0.12, z: -w * 0.72 - headSize * 0.35, w: headSize * 0.56, h: headSize * 0.45, d: headSize * 0.35, color: accent });
  if (mob.kind === 'cow') {
    parts.push({ x: -w * 0.2, y: headY + headSize * 0.9, z: -w * 0.6, w: 0.07, h: 0.14, d: 0.07, color: [0.9, 0.9, 0.86, 0.95] });
    parts.push({ x: w * 0.13, y: headY + headSize * 0.9, z: -w * 0.6, w: 0.07, h: 0.14, d: 0.07, color: [0.9, 0.9, 0.86, 0.95] });
  }
  return parts;
}

// ------------------------------------------------------------------ dropped items
export class ItemEntity {
  constructor(id, count, x, y, z) {
    this.id = id; this.count = count;
    this.x = x; this.y = y; this.z = z;
    this.vx = (Math.random() - 0.5) * 1.5;
    this.vy = 2.4; this.vz = (Math.random() - 0.5) * 1.5;
    this.age = 0;
    this.onGround = false;
    this.spin = Math.random() * Math.PI * 2;
    this.dead = false;
    this.pickupDelay = 0.4;
  }

  update(dt, world, player, api) {
    this.age += dt;
    this.pickupDelay = Math.max(0, this.pickupDelay - dt);
    this.spin += dt * 1.6;
    const hw = 0.125;
    this.vy -= GRAVITY * dt;
    const inWater = LIQUID[baseId(world.getBlockRaw(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)))] === 1;
    if (inWater) this.vy = Math.max(this.vy, -1.5);

    const tryMove = (dx, dy, dz) => {
      const nx = this.x + dx, ny = this.y + dy, nz = this.z + dz;
      const solidAt = (x, y, z) => SOLID[baseId(world.getBlockRaw(Math.floor(x), Math.floor(y), Math.floor(z)))];
      if (dy !== 0) {
        if (solidAt(nx, ny + (dy < 0 ? 0 : 0.25), nz)) {
          if (dy < 0) { this.y = Math.floor(ny) + 1; this.onGround = true; this.vy = 0; }
          else this.vy = 0;
          return;
        }
      } else if (solidAt(nx, this.y + 0.15, nz)) return;
      this.x = nx; this.y = ny; this.z = nz;
    };
    tryMove(this.vx * dt, this.vy * dt, this.vz * dt);
    if (this.onGround) { this.vx *= 0.7; this.vz *= 0.7; }

    // magnet + pickup
    const dx = player.x - this.x, dy = (player.y + 0.9) - this.y, dz = player.z - this.z;
    const dist = Math.hypot(dx, dy, dz);
    // Drift toward the player before the pickup radius is reached, so walking over a
    // drop always collects it. This steers the velocity toward a target speed instead of
    // adding impulses: an impulse gets cancelled by the ground friction applied above,
    // which left items crawling toward the player at a fraction of a block per second.
    if (this.pickupDelay <= 0 && !player.dead && dist > 0.05 && dist < 3.4) {
      const speed = 1.6 + (1 - dist / 3.4) * 6.4;
      const k = Math.min(1, 18 * dt);
      this.vx += ((dx / dist) * speed - this.vx) * k;
      this.vz += ((dz / dist) * speed - this.vz) * k;
      if (dy > 0.2) this.vy += ((dy / dist) * speed - this.vy) * k * 0.5;
    }
    if (dist < 1.6 && this.pickupDelay <= 0 && !player.dead) {
      const left = player.inventory.add(this.id, this.count);
      if (left < this.count && api && api.pickupSound) api.pickupSound();
      if (left <= 0) { this.dead = true; }
      else this.count = left;
    }
    if (this.age > 300) this.dead = true;

    // merge stacks that are close together, like Minecraft
    if (api && api.items) {
      for (const other of api.items) {
        if (other === this || other.dead || other.id !== this.id) continue;
        if (Math.hypot(other.x - this.x, other.y - this.y, other.z - this.z) < 0.7 && this.count + other.count <= 64) {
          other.count += this.count;
          this.dead = true;
          break;
        }
      }
    }
  }
}

/** Spawn a small herd around a point, respecting the biome. */
export function spawnInitialMobs(world, cx, cz, seed) {
  const rng = makeRng(seed);
  const mobs = [];
  const count = 8 + ((rng() * 8) | 0);
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2, r = 12 + rng() * 34;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const biome = world.biomeAt(Math.floor(x), Math.floor(z));
    const y = world.findSurfaceY(Math.floor(x), Math.floor(z));
    if (y < 62) continue;
    let kind;
    if (biome === 4) kind = rng() < 0.5 ? 'chicken' : 'sheep';
    else if (biome === 7 || biome === 8) kind = rng() < 0.5 ? 'sheep' : 'cow';
    else if (biome === 9) kind = rng() < 0.4 ? 'chicken' : 'pig';
    else kind = ['pig', 'cow', 'sheep', 'chicken'][(rng() * 4) | 0];
    mobs.push(new Mob(kind, x, y, z));
  }
  return mobs;
}
