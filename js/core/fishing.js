// core/fishing.js
//
// Fishing: the bobber's little state machine plus the three loot tables.
//
// The bobber goes idle -> flying -> floating -> biting -> back to the rod. Only a bite
// can be reeled in, and the window is short, which is what makes fishing feel like
// fishing rather than a button that dispenses cod.

export const BITE_MIN = 2.0;      // seconds before a bite can happen
export const BITE_MAX = 9.0;
export const BITE_WINDOW = 1.6;   // how long the bite stays on the hook

/** Weighted loot tables. Weights are relative within one table. */
export const LOOT = {
  fish: [
    { key: 'cod', weight: 60, min: 1, max: 1 },
    { key: 'salmon', weight: 25, min: 1, max: 1 },
    { key: 'pufferfish', weight: 10, min: 1, max: 1 },
    { key: 'clownfish', weight: 5, min: 1, max: 1 },
  ],
  junk: [
    { key: 'stick', weight: 20, min: 1, max: 1 },
    { key: 'string', weight: 18, min: 1, max: 1 },
    { key: 'empty_bottle', weight: 16, min: 1, max: 1 },
    { key: 'clay_ball', weight: 14, min: 1, max: 3 },
    { key: 'seeds', weight: 12, min: 1, max: 3 },
    { key: 'flint', weight: 10, min: 1, max: 2 },
    { key: 'rotten_flesh', weight: 10, min: 1, max: 2 },
  ],
  treasure: [
    { key: 'diamond', weight: 20, min: 1, max: 1 },
    { key: 'emerald', weight: 20, min: 1, max: 3 },
    { key: 'iron_ingot', weight: 24, min: 2, max: 6 },
    { key: 'gold_ingot', weight: 18, min: 1, max: 4 },
    { key: 'book', weight: 12, min: 1, max: 2 },
    { key: 'golden_carrot', weight: 6, min: 1, max: 2 },
  ],
};

/**
 * Roll one catch. `luck` (0..1) shifts the odds toward treasure, which is what an
 * enchanted rod would eventually do.
 */
export function rollCatch(rng = Math.random, luck = 0) {
  const r = rng();
  const treasureChance = 0.05 + 0.25 * luck;
  const junkChance = 0.15 - 0.10 * luck;
  let table;
  if (r < treasureChance) table = LOOT.treasure;
  else if (r < treasureChance + junkChance) table = LOOT.junk;
  else table = LOOT.fish;
  const total = table.reduce((n, e) => n + e.weight, 0);
  let roll = rng() * total;
  for (const entry of table) {
    roll -= entry.weight;
    if (roll <= 0) {
      const count = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
      return { key: entry.key, count, table: table === LOOT.treasure ? 'treasure' : table === LOOT.junk ? 'junk' : 'fish' };
    }
  }
  const last = table[table.length - 1];
  return { key: last.key, count: 1, table: 'fish' };
}

/**
 * The bobber state machine. Positions are plain numbers; the game owns the entity.
 * Returns the new state, so the caller can react (spawn particles, play a sound).
 */
export class Bobber {
  constructor(x, y, z, vx, vy, vz, rodId) {
    this.x = x; this.y = y; this.z = z;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.state = 'flying';          // flying -> floating -> biting -> retracted
    this.rodId = rodId;
    this.timer = 0;
    this.biteTimer = 0;
    this.age = 0;
  }

  /** Called every frame. `inWater` tells us whether the hook has landed in water. */
  update(dt, inWater, inGround, rng = Math.random) {
    this.age += dt;
    if (this.state === 'flying') {
      this.vy -= 24 * dt;
      this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
      if (inWater) {
        this.state = 'floating';
        this.timer = 0;
        this.biteTimer = BITE_MIN + rng() * (BITE_MAX - BITE_MIN);
      } else if (inGround) {
        this.state = 'retracted';
      }
      return this.state;
    }
    if (this.state === 'floating') {
      // bob gently on the surface
      this.y += Math.sin(this.age * 3) * 0.02;
      this.timer += dt;
      if (this.timer >= this.biteTimer) {
        this.state = 'biting';
        this.timer = 0;
      }
      return this.state;
    }
    if (this.state === 'biting') {
      this.timer += dt;
      if (this.timer > BITE_WINDOW) {
        // the fish got away; wait for another bite
        this.state = 'floating';
        this.timer = 0;
        this.biteTimer = BITE_MIN + rng() * (BITE_MAX - BITE_MIN);
      }
      return this.state;
    }
    return this.state;
  }

  get canReel() { return this.state === 'biting'; }
  get done() { return this.state === 'retracted'; }
}
