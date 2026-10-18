// probe: report how much chunk geometry actually reached the GPU, plus GL health.
(() => {
  const g = window.__MINEWEB__;
  const gl = g.renderer.gl;
  const out = { glError: gl.getError(), stats: Object.assign({}, g.renderer.stats), chunks: g.world.chunks.size };
  const sample = [];
  let withMesh = 0, withSlot = 0, totalQuads = 0;
  for (const c of g.world.chunks.values()) {
    if (c.mesh && c.mesh.opaque) withMesh++;
    if (c._opaque && c._opaque.quads) { withSlot++; totalQuads += c._opaque.quads; }
    if (sample.length < 3 && c._opaque) {
      const d = c.mesh && c.mesh.opaque ? c.mesh.opaque.data : null;
      sample.push({
        cx: c.cx, cz: c.cz, dirty: c.dirty, lit: c.lit, decorated: c.decorated,
        meshVersion: c.meshVersion, uploadedVersion: c._uploadedVersion,
        slotQuads: c._opaque.quads, slotVerts: c._opaque.verts,
        hasVao: !!c._opaque.vao, hasVbo: !!c._opaque.vbo,
        dataLen: d ? d.length : -1,
        firstVerts: d ? Array.from(d.slice(0, 12)).map((v) => Number(v.toFixed(3))) : [],
      });
    }
  }
  out.meshed = withMesh; out.uploaded = withSlot; out.totalQuads = totalQuads;
  out.sample = sample;
  out.viewProj = Array.from(g.renderer.vp).map((v) => Number(v.toFixed(3)));
  out.cam = { x: g.player.x, y: g.player.eyeY, z: g.player.z, yaw: g.player.yaw, pitch: g.player.pitch };
  out.progChunkUniforms = Object.keys(g.renderer.progChunk.u);
  out.progWaterUniforms = Object.keys(g.renderer.progWater.u);
  // is the drawn index buffer bound before drawChunks?
  out.viewport = Array.from(gl.getParameter(gl.VIEWPORT));
  out.canvasSize = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  return out;
})()
