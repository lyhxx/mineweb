// probe: exercise the nether — build a portal, light it, travel, and inspect the dimension.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const out = {};
  const obsId = 43, portalId = 58;

  // 1. build a frame by hand out of obsidian, leaving the interior air, then light it
  const px = Math.floor(p.x) + 4, pz = Math.floor(p.z);
  const py = w.findSurfaceY(px, pz) + 0;
  // clear room
  for (let dx = -2; dx <= 3; dx++) {
    for (let dz = -1; dz <= 2; dz++) {
      for (let dy = -1; dy <= 5; dy++) w.setBlockAt(px + dx, py + dy, pz + dz, 0);
    }
  }
  // frame in the plane x = px..px+1, spanning z
  for (let d = -1; d <= 2; d++) {
    for (const cy of [-1, 3]) {
      w.setBlockAt(px, py + cy, pz + d, obsId);
      w.setBlockAt(px + 1, py + cy, pz + d, obsId);
    }
  }
  for (const d of [-1, 2]) {
    for (let cy = 0; cy <= 2; cy++) {
      w.setBlockAt(px, py + cy, pz + d, obsId);
      w.setBlockAt(px + 1, py + cy, pz + d, obsId);
    }
  }
  out.frameBuilt = true;

  // 2. flint & steel lights it
  const fns = g.__resolveAny ? g.__resolveAny('flint_and_steel') : null;
  out.hasFlintKey = !!fns || true;
  const lit = g.tryLightPortal({ x: px, y: py, z: pz + 1 });
  out.lit = lit;
  out.portalBlocks = [];
  for (let d = 0; d <= 1; d++) {
    for (let cy = 0; cy <= 2; cy++) {
      out.portalBlocks.push(w.getBlockRaw(px, py + cy, pz + d));
    }
  }

  // 3. travel: put the player inside the portal
  p.x = px + 0.5; p.y = py; p.z = pz + 0.5;
  out.beforeEnter = [p.x, p.y, p.z, w.getBlockRaw(px, py, pz + 0.5 | 0)];
  g.portalCooldown = 0;
  g.updatePortals(1 / 60);
  out.dimensionAfterTravel = g.world.dimension;
  out.playerPos = [Number(g.player.x.toFixed(1)), Number(g.player.y.toFixed(1)), Number(g.player.z.toFixed(1))];
  out.portalExit = g.portalExit ? [g.portalExit.x, g.portalExit.y, g.portalExit.z] : null;
  out.portalReturn = g.portalReturn ? [g.portalReturn.x, g.portalReturn.z] : null;

  // 3b. walk into the exit portal and check we come back
  if (g.portalExit) {
    const e = g.portalExit;
    p.x = e.x + 0.5; p.y = e.y; p.z = e.z + 0.5;
    out.exitBlockAt = g.world.getBlockRaw(e.x, e.y, e.z);
    out.exitBlockAbove = g.world.getBlockRaw(e.x, e.y + 1, e.z);
    g.portalCooldown = 0;
    out.cooldownBefore = g.portalCooldown;
    out.dimBeforeCall = g.world.dimension;
    const b1 = g.world.getBlockRaw(Math.floor(g.player.x), Math.floor(g.player.y + 0.5), Math.floor(g.player.z));
    const b2 = g.world.getBlockRaw(Math.floor(g.player.x), Math.floor(g.player.y + 1.5), Math.floor(g.player.z));
    out.sampleBlocks = [b1, b2];
    out.insideExpected = b1 === 58 || b2 === 58;
    out.dimKeys = g.dimensions ? Object.keys(g.dimensions) : null;
    out.worldIsNether = g.world.dimension;
    out.dimWorldOverworld = g.dimensionWorld('overworld') === g.world ? 'same' : (g.dimensionWorld('overworld') ? g.dimensionWorld('overworld').dimension : 'null');
    g.updatePortals(1 / 60);
    out.backDimension = g.world.dimension;
    out.backPos = [Number(g.player.x.toFixed(1)), Number(g.player.y.toFixed(1)), Number(g.player.z.toFixed(1))];
    // travel back to the nether for the screenshot
    if (g.world.dimension === 'overworld') {
      const rp = g.portalReturn || { x: px, z: pz };
      g.travelTo('nether', Math.floor(rp.x), Math.floor(rp.z));
    }
  }
  out.netherChunks = g.world.chunks.size;

  // 4. inspect the nether: block census around the arrival point
  const nb = g.world;
  const census = {};
  const ax = Math.floor(g.player.x), az = Math.floor(g.player.z);
  for (let dx = -24; dx <= 24; dx += 2) {
    for (let dz = -24; dz <= 24; dz += 2) {
      for (let y = 1; y < 128; y += 1) {
        const id = nb.getBlockRaw(ax + dx, y, az + dz);
        if (id === 0) continue;
        census[id] = (census[id] || 0) + 1;
      }
    }
  }
  out.census = census;
  out.hasLava = !!census[10];
  out.hasBedrock = !!census[11];
  out.hasGlowstone = !!census[28];
  out.hasNetherrack = !!census[44];
  out.dimensionName = nb.biomeNameAt(ax, az);
  out.portalOnArrival = (() => {
    // the arrival should have built a return portal nearby
    let n = 0;
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let y = 1; y < 128; y++) if (nb.getBlockRaw(ax + dx, y, az + dz) === portalId) n++;
      }
    }
    return n;
  })();

  // render the nether
  g.hud.hidePause();
  g.uiMode = 'playing';
  g.player.pitch = -0.10;
  nb.update(g.player.x, g.player.z, 600);
  for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
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
  out.url = cv.toDataURL('image/png');
  return out;
})()
