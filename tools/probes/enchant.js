// probe: open the enchanting table UI with an item in the slot so it can be screenshotted.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const inv = g.player.inventory;

  // place an enchanting table in front of the player and look at it
  const tx = Math.floor(p.x) + 1, tz = Math.floor(p.z) + 3;
  const ty = w.findSurfaceY(tx, tz);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (let dy = 0; dy <= 4; dy++) w.setBlockAt(tx + dx, ty + dy, tz + dz, 0);
  }
  w.setBlockAt(tx, ty, tz, 59);          // enchanting table
  // a couple of bookshelves beside it, like a real setup
  w.setBlockAt(tx - 2, ty, tz, 20);
  w.setBlockAt(tx + 2, ty, tz, 20);
  w.setBlockAt(tx - 2, ty + 1, tz, 20);
  w.setBlockAt(tx + 2, ty + 1, tz, 20);

  // give the player levels and put a sword in the table
  p.level = 24;
  p.xp = 0;
  const swordKey = 34;                    // iron sword item id (-34)
  inv.slots.fill(null);
  // build a real ItemStack through the inventory's own path
  inv.selected = 0;
  inv.add(-swordKey, 1);
  inv.clickSlot(0, false, false);          // pick it up with the cursor
  inv.clickEnchantSlot(false);             // drop it into the table slot
  inv.cursor = null;
  g.enchantSeed = 3;

  p.x = tx + 0.5; p.z = tz + 3.5; p.y = ty + 2.2;
  p.yaw = 0; p.pitch = -0.28;
  w.update(p.x, p.z, 600);
  for (let i = 0; i < 20; i++) g.stepFrame(1 / 60);
  g.openEnchanting();

  const gl = g.renderer.gl;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    img.data.set(buf.subarray(src, src + W * 4), y * W * 4);
  }
  ctx.putImageData(img, 0, 0);
  return {
    url: cv.toDataURL('image/png'),
    offers: (inv.enchantOffers || []).filter(Boolean).map((o) => `${o.key}:${o.level} cost ${o.cost}`),
    playerLevel: p.level,
  };
})()
