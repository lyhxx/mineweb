// probe: dump the sand and water atlas tiles as ASCII luminance art.
(() => {
  const g = window.__MINEWEB__;
  const gl = g.renderer.gl;
  const R = g.renderer;
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.atlasTex, 0);
  const readTile = (tx, ty) => {
    const px = new Uint8Array(16 * 16 * 4);
    gl.readPixels(tx * 16, ty * 16, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const rows = [];
    for (let y = 15; y >= 0; y--) {
      let line = '';
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
        const a = px[i + 3];
        if (a === 0) line += '_';
        else line += lum < 40 ? '#' : lum < 90 ? '+' : lum < 150 ? 'o' : lum < 200 ? '.' : ' ';
      }
      rows.push(line);
    }
    return rows;
  };
  const out = {};
  // tile index -> (tx = idx % 32, ty = floor(idx / 32))
  const tileOf = (blockId, face) => {
    const idx = blockId * 6 + face;
    return [idx % 32, Math.floor(idx / 32)];
  };
  const [sx, sy] = tileOf(8, 4);      // sand, top face
  const [wx, wy] = tileOf(9, 4);      // water, top face
  const [gx, gy] = tileOf(2, 4);      // grass, top face
  const [lx, ly] = tileOf(7, 0);      // leaves, north face
  out.sandTile = { coords: [sx, sy], rows: readTile(sx, sy) };
  out.waterTile = { coords: [wx, wy], rows: readTile(wx, wy) };
  out.grassTile = { coords: [gx, gy], rows: readTile(gx, gy) };
  out.leavesTile = { coords: [lx, ly], rows: readTile(lx, ly) };
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  // also: how many water quads are in the scene and where is sea level?
  let waterQuads = 0, waterChunks = 0;
  for (const c of g.world.chunks.values()) if (c._water && c._water.quads) { waterQuads += c._water.quads; waterChunks++; }
  out.waterQuads = waterQuads;
  out.waterChunks = waterChunks;
  out.eyeY = g.player.eyeY;
  return out;
})()
