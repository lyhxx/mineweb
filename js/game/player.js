// game/player.js — player state, movement physics, collisions, survival stats.
import { clamp } from '../core/math.js';
import { SOLID, LIQUID, baseId } from '../core/blocks.js';
import { WORLD_H } from '../world/chunk.js';
import { maxDurability } from './inventory.js';

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const GRAVITY = 32.0;
export const JUMP_SPEED = 8.94;
export const WALK_SPEED = 4.317;
export const SPRINT_SPEED = 5.612;
export const SNEAK_SPEED = 1.31;
export const SWIM_SPEED = 2.2;
export const FLY_SPEED = 10.9;
export const FLY_SPRINT_SPEED = 21.8;
export const TERMINAL_VELOCITY = 78.4;

export const GAMEMODE = { SURVIVAL: 'survival', CREATIVE: 'creative' };

export class Player {
  constructor(world, spawn) {
    this.world = world;
    this.x = spawn.x; this.y = spawn.y; this.z = spawn.z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.sprinting = false;
    this.sneaking = false;
    this.blocking = false;   // shield raised: right button held with a shield in hand
    this.flying = false;
    this.health = 20;
    this.maxHealth = 20;
    this.hunger = 20;
    this.saturation = 5;
    this.air = 300;             // breath ticks (5 min)
    this.maxAir = 300;
    this.xp = 0;
    this.level = 0;
    this.mode = GAMEMODE.SURVIVAL;
    this.fallStart = null;
    this.lastDamageTime = -100;
    this.hurtTime = 0;
    this.dead = false;
    this.walkDistance = 0;
    this.bob = 0;
    this.spawnPoint = { ...spawn };
    this.tickTimer = 0;
    this.regenTimer = 0;
    this.stepDistance = 0;
  }

  get eyeY() { return this.y + EYE_HEIGHT; }

  get feetBlockY() { return Math.floor(this.y); }

  aabb() {
    const hw = PLAYER_WIDTH / 2;
    return {
      minX: this.x - hw, maxX: this.x + hw,
      minY: this.y, maxY: this.y + PLAYER_HEIGHT,
      minZ: this.z - hw, maxZ: this.z + hw,
    };
  }

  /** Does the given box intersect any solid voxel? */
  boxCollides(minX, minY, minZ, maxX, maxY, maxZ) {
    const world = this.world;
    const x0 = Math.floor(minX + 1e-7), x1 = Math.floor(maxX - 1e-7);
    const y0 = Math.floor(minY + 1e-7), y1 = Math.floor(maxY - 1e-7);
    const z0 = Math.floor(minZ + 1e-7), z1 = Math.floor(maxZ - 1e-7);
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

  update(dt, input) {
    if (this.dead) dt = Math.min(dt, 1 / 30);
    this.hurtTime = Math.max(0, this.hurtTime - dt);
    const hw = PLAYER_WIDTH / 2;
    const world = this.world;

    // ---- environment probes
    const feetId = baseId(world.getBlockRaw(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z)));
    const midId = baseId(world.getBlockRaw(Math.floor(this.x), Math.floor(this.y + 1.0), Math.floor(this.z)));
    const headId = baseId(world.getBlockRaw(Math.floor(this.x), Math.floor(this.eyeY), Math.floor(this.z)));
    this.inWater = LIQUID[feetId] === 1 || LIQUID[midId] === 1;
    this.headInWater = LIQUID[headId] === 1;

    // ---- desired horizontal velocity
    const forward = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let len = Math.hypot(forward, strafe);
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    let dirX = 0, dirZ = 0;
    if (len > 0) {
      const f = forward / len, s = strafe / len;
      dirX = sinY * f + cosY * s;
      dirZ = -cosY * f + sinY * s;
    }

    const creative = this.mode === GAMEMODE.CREATIVE;
    this.flying = creative && this.flying;
    let speed;
    if (this.flying) speed = input.sprint ? FLY_SPRINT_SPEED : FLY_SPEED;
    else if (this.inWater) speed = SWIM_SPEED * (input.sprint ? 1.35 : 1);
    else if (this.sneaking && this.onGround) speed = SNEAK_SPEED;
    else speed = (input.sprint && forward > 0 ? SPRINT_SPEED : WALK_SPEED);
    // Swiftness / Slowness potions scale all ground and water movement
    if (this.effects && !this.flying) speed *= this.effects.speedMultiplier();

    const accel = this.onGround || this.flying ? 46 : 12;
    const targetVX = dirX * speed;
    const targetVZ = dirZ * speed;
    this.vx += (targetVX - this.vx) * Math.min(1, accel * dt);
    this.vz += (targetVZ - this.vz) * Math.min(1, accel * dt);
    if (len === 0 && (this.onGround || this.flying)) {
      const damp = Math.min(1, 22 * dt);
      this.vx -= this.vx * damp;
      this.vz -= this.vz * damp;
    }

    // ---- vertical
    if (this.flying) {
      let vy = 0;
      if (input.jump) vy += speed;
      if (input.sneak) vy -= speed;
      this.vy += (vy - this.vy) * Math.min(1, 30 * dt);
    } else if (this.inWater) {
      this.vy -= GRAVITY * 0.22 * dt;
      if (input.jump) this.vy = 3.0;
      this.vy = Math.max(this.vy, -3.2);
      this.vy *= 0.94;
    } else {
      if (input.jump && this.onGround) { this.vy = JUMP_SPEED; this.onGround = false; }
      this.vy -= GRAVITY * dt;
      if (this.vy < -TERMINAL_VELOCITY) this.vy = -TERMINAL_VELOCITY;
    }

    // ---- integrate with per-axis collision resolution + ledge auto-step
    const moveX = this.vx * dt, moveY = this.vy * dt, moveZ = this.vz * dt;
    const canStep = this.onGround || this.inWater;
    const STEP_LIFT = 0.55;

    // try a small step up first when something blocks horizontal motion
    const slideAxis = (axis, delta) => {
      if (delta === 0) return;
      const tryMove = (lift) => {
        const baseY = this.y + lift;
        if (axis === 'x') {
          const nx = this.x + delta;
          if (!this.boxCollides(nx - hw, baseY, this.z - hw, nx + hw, baseY + PLAYER_HEIGHT, this.z + hw)) {
            this.y = baseY; this.x = nx; return true;
          }
        } else {
          const nz = this.z + delta;
          if (!this.boxCollides(this.x - hw, baseY, nz - hw, this.x + hw, baseY + PLAYER_HEIGHT, nz + hw)) {
            this.y = baseY; this.z = nz; return true;
          }
        }
        return false;
      };
      if (tryMove(0)) return;
      if (canStep) {
        for (const lift of [0.25, 0.55]) {
          if (tryMove(lift)) return;
        }
      }
      // blocked: kill only the component into the wall, keep the other
      if (axis === 'x') this.vx = 0; else this.vz = 0;
    };
    slideAxis('x', moveX);
    slideAxis('z', moveZ);

    if (moveY !== 0) {
      const ny = this.y + moveY;
      if (this.boxCollides(this.x - hw, ny, this.z - hw, this.x + hw, ny + PLAYER_HEIGHT, this.z + hw)) {
        if (moveY < 0) {
          this.y = Math.floor(ny) + 1;
          this.onGround = true;
          this.handleFallDamage();
        }
        this.vy = 0;
      } else {
        this.y = ny;
        if (moveY < 0) this.onGround = false;
      }
    }

    // ---- ground probe: standing still on a block keeps onGround true
    if (Math.abs(this.vy) < 1e-3 || this.onGround) {
      const probeY = this.y - 0.02;
      const on = this.boxCollides(this.x - hw, probeY, this.z - hw, this.x + hw, probeY + 0.04, this.z + hw);
      this.onGround = on;
      if (on) {
        this.vy = Math.max(this.vy, 0);
        // track fall start while grounded
        this.fallStart = null;
      }
    }

    // ---- fall tracking for real fall damage
    if (!this.onGround && !this.flying && !this.inWater && this.vy < 0) {
      if (this.fallStart === null) this.fallStart = this.y;
      else this.fallStart = Math.max(this.fallStart, this.y);
    }

    // ---- head-in-block safety: nudge out if we somehow end up inside terrain
    if (this.boxCollides(this.x - hw, this.y, this.z - hw, this.x + hw, this.y + PLAYER_HEIGHT, this.z + hw)) {
      this.y += 0.08;
    }
    if (this.y < -20) this.damage(1000, 'void');

    // ---- survival stats (20 ticks/sec like Minecraft)
    if (this.mode === GAMEMODE.SURVIVAL) {
      this.tickTimer += dt;
      while (this.tickTimer >= 1 / 20) { this.tickTimer -= 1 / 20; this.survivalTick(); }
    }
    if (this.headInWater && this.mode === GAMEMODE.SURVIVAL && !(this.effects && this.effects.has('water_breathing'))) {
      this.airTick = (this.airTick || 0) + dt;
      if (this.airTick > 1) {
        this.airTick = 0;
        this.air--;
        if (this.air <= 0) { this.air = 0; this.damage(2, 'drown'); }
      }
    } else if (this.air < this.maxAir) {
      this.air = Math.min(this.maxAir, this.air + dt * 60);
    }

    // ---- camera bob + footsteps
    const horizSpeed = Math.hypot(this.vx, this.vz);
    if (this.onGround && horizSpeed > 0.6) {
      this.stepDistance += horizSpeed * dt;
      this.bob = Math.sin(this.walkDistance * 6) * 0.035;
      this.walkDistance += horizSpeed * dt;
      if (this.stepDistance > 2.2) {
        this.stepDistance = 0;
        if (this.onFootstep) this.onFootstep(this);
      }
    } else {
      this.bob *= 0.9;
    }
  }

  handleFallDamage() {
    if (this.fallStart === null || this.mode === GAMEMODE.CREATIVE) { this.fallStart = null; return; }
    const drop = this.fallStart - this.y;
    this.fallStart = null;
    if (drop > 3.2) {
      const dmg = Math.floor(drop - 3.0);
      if (dmg > 0) { this.damage(dmg, 'fall'); if (this.onHurt) this.onHurt(dmg, 'fall'); }
    }
  }

  survivalTick() {
    // hunger: exertion drains it, then health regenerates or starves
    const moving = Math.hypot(this.vx, this.vz) > 0.5;
    this.exhaustion = (this.exhaustion || 0) + (moving ? 0.02 : 0.005) + (this.sprinting ? 0.04 : 0);
    if (this.exhaustion >= 4) {
      this.exhaustion = 0;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
    this.regenTimer += 1 / 20;
    if (this.hunger >= 18 && this.health < this.maxHealth && this.regenTimer > 3.5) {
      this.regenTimer = 0;
      this.health = Math.min(this.maxHealth, this.health + 1);
      this.exhaustion += 3;
    }
    if (this.hunger === 0 && this.regenTimer > 3.0) {
      this.regenTimer = 0;
      this.damage(1, 'starve');
    }
    if (this.health <= 0) this.die();
  }

  damage(amount, cause = 'generic') {
    if (this.mode === GAMEMODE.CREATIVE && cause !== 'void') return;
    // A raised shield absorbs most of a physical hit. Environmental damage (fall, drown,
    // starve, void, poison) cannot be blocked, matching the original game.
    const blockable = cause === 'mob' || cause === 'arrow' || cause === 'explosion';
    if (this.blocking && blockable && amount > 0) {
      amount *= 0.25;
      if (this.inventory) {
        const s = this.inventory.held;
        if (s && s.id < 0) {
          const maxDur = maxDurability(s.id);
          if (maxDur > 0) {
            if (s.durability === null || s.durability === undefined) s.durability = maxDur;
            s.durability -= 1;
            if (s.durability <= 0) {
              this.inventory.slots[this.inventory.selected] = null;
              if (this.onShieldBreak) this.onShieldBreak();
            }
          }
        }
      }
    }
    this.health = Math.max(0, this.health - amount);
    this.hurtTime = 0.45;
    this.lastDamageTime = 0;
    if (this.health <= 0) this.die();
  }

  heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); }

  eat() {
    if (this.hunger < 20) {
      this.hunger = Math.min(20, this.hunger + 6);
      this.saturation = Math.min(10, this.saturation + 3);
      return true;
    }
    return false;
  }

  die() {
    this.dead = true;
    this.health = 0;
    if (this.onDeath) this.onDeath();
  }

  respawn(spawn) {
    const s = spawn || this.spawnPoint;
    this.x = s.x; this.y = s.y; this.z = s.z;
    this.vx = this.vy = this.vz = 0;
    this.health = this.maxHealth;
    this.hunger = 20;
    this.saturation = 5;
    this.air = this.maxAir;
    this.dead = false;
    this.fallStart = null;
    this.hurtTime = 0;
  }

  addXp(n) {
    this.xp += n;    while (this.xp >= this.xpNeeded()) {
      this.xp -= this.xpNeeded();
      this.level++;
      if (this.onLevelUp) this.onLevelUp();
    }
  }

  xpNeeded() { return 7 + this.level * 3; }

  /** Direction the player is looking. */
  lookDir() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return [Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp];
  }
}
