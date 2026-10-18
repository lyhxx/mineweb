// probe: report the WebGL2 limits that constrain the block-id / texture-array design.
(() => {
  const g = window.__MINEWEB__;
  const gl = g.renderer.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    maxArrayTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    max3DTextureSize: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxElementsIndices: gl.getParameter(gl.MAX_ELEMENTS_INDICES),
    maxElementsVertices: gl.getParameter(gl.MAX_ELEMENTS_VERTICES),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
    currentLayersUsed: 32 * 32,
    blockCount: window.__MINEWEB_BLOCK_COUNT || 'n/a',
  };
})()
