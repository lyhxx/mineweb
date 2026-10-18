// render/gl.js — all WebGL2 plumbing: atlas texture, chunk streaming buffers, sky,
// box-model entities, block outlines and particles.
import { m4perspective, m4view, m4multiply, m4identity, m4aim, m4rotY, m4rotX, m4rotZ, m4translate, m4scale, frustumFromMatrix, aabbInFrustum } from '../core/math.js';
import { CX, CZ, WORLD_H } from '../world/chunk.js';
import { ATLAS_W, ATLAS_H, TILE_PX, LAYER_COUNT, generateAtlasPixels, paintAllTiles } from '../core/atlas.js';
import { VERT_BYTES } from '../world/mesher.js';

// ------------------------------------------------------------------ shaders
// Block textures come from a TEXTURE_2D_ARRAY; `aLayer` selects the tile.
const CHUNK_VS_FULL = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLight;
layout(location=3) in float aAO;
layout(location=4) in float aShade;
layout(location=5) in float aLayer;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uOrigin;
uniform vec3 uCam;
uniform float uFogStart;
uniform float uFogRange;
uniform float uModelMode;
out vec2 vUV;
out float vLayer;
out float vLight;
out float vFog;
void main() {
  // geometry arrives in chunk-local space; uOrigin lifts it into world space
  vec3 world = (uModelMode > 0.5) ? (uModel * vec4(aPos, 1.0)).xyz : (aPos + uOrigin);
  gl_Position = uVP * vec4(world, 1.0);
  vUV = aUV;
  vLayer = aLayer;
  vLight = clamp(aLight * aShade * aAO, 0.0, 1.6);
  // fog must be measured in world space (aPos alone is chunk-local)
  vFog = clamp((length(world - uCam) - uFogStart) / uFogRange, 0.0, 1.0);
}`;

const BLOCK_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
in float vLayer;
in float vLight;
in float vFog;
uniform sampler2DArray uAtlas;
uniform vec3 uSkyColor;
uniform vec3 uSkyLightColor;
uniform vec3 uTint;
uniform float uAlphaTest;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUV, vLayer));
  if (tex.a < uAlphaTest) discard;
  vec3 lit = tex.rgb * vLight * uTint * uSkyLightColor;
  vec3 col = mix(lit, uSkyColor, vFog);
  outColor = vec4(col, tex.a * uOpacity);
}`;

const WATER_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
in float vLayer;
in float vLight;
in float vFog;
uniform sampler2DArray uAtlas;
uniform vec3 uSkyColor;
uniform vec3 uSkyLightColor;
uniform vec3 uTint;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUV, vLayer));
  if (tex.a < 0.1) discard;
  vec3 lit = tex.rgb * max(vLight, 0.25) * uTint * uSkyLightColor;
  vec3 col = mix(lit, uSkyColor, vFog * 0.9);
  outColor = vec4(col, uOpacity * tex.a);
}`;

const ENTITY_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aShade;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec3 uCam;
uniform float uFogStart;
uniform float uFogRange;
out vec2 vUV;
out float vShade;
out float vFog;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  gl_Position = uVP * world;
  vUV = aUV;
  vShade = aShade;
  vFog = clamp((length(world.xyz - uCam) - uFogStart) / uFogRange, 0.0, 1.0);
}`;

// Entity parts are flat-coloured boxes; they sample a 1x1 white texture so the same
// shader can also tint them, with no texture lookups to get wrong.
const ENTITY_FS = `#version 300 es
precision highp float;
in vec2 vUV;
in float vShade;
in float vFog;
uniform vec3 uSkyColor;
uniform vec3 uSkyLightColor;
uniform vec4 uColor;
uniform float uLightMul;
uniform float uAlphaTest;
out vec4 outColor;
void main() {
  vec3 col = uColor.rgb * vShade * uLightMul * uSkyLightColor;
  outColor = vec4(mix(col, uSkyColor, vFog), uColor.a);
}`;

const SKY_VS = `#version 300 es
precision highp float;
out vec2 vNdc;
void main() {
  // gl_VertexID trick: one oversized triangle covering the whole viewport.
  vec2 p = vec2((gl_VertexID == 1) ? 3.0 : -1.0, (gl_VertexID == 2) ? 3.0 : -1.0);
  vNdc = p;
  gl_Position = vec4(p, 0.999, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vNdc;
uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
// camera basis, so each pixel can rebuild its world-space view ray
uniform mat3 uViewRot;
uniform float uTanHalfFov;
uniform float uAspect;
out vec4 outColor;
void main() {
  // reconstruct the world-space ray for this pixel (view matrix is world -> view)
  vec3 rayView = normalize(vec3(vNdc.x * uTanHalfFov * uAspect, vNdc.y * uTanHalfFov, -1.0));
  vec3 ray = normalize(uViewRot * rayView);

  // sky gradient follows the ray's elevation, so the horizon stays level when you
  // look up or down (the old version used screen Y and drifted with pitch)
  float up = clamp(ray.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.62));
  // below the horizon fade to the horizon colour rather than going black
  col = mix(uHorizon, col, smoothstep(-0.12, 0.06, ray.y));

  vec3 sun = normalize(uSunDir);
  float cosA = dot(ray, sun);
  // a small hard disc, then a soft halo — a real sun, not a screen-space smear
  float disc = smoothstep(0.9993, 0.9997, cosA);
  float halo = pow(max(cosA, 0.0), 220.0) * 0.55 + pow(max(cosA, 0.0), 26.0) * 0.14;
  col += uSunColor * (disc * 1.6 + halo) * uSunGlow;

  // warm the sky near the sun while it is low, so dawn/dusk reads as dusk
  float lowSun = clamp(1.0 - abs(sun.y) * 2.4, 0.0, 1.0);
  float horizonBand = 1.0 - smoothstep(0.0, 0.30, abs(ray.y));
  float azimuth = pow(max(dot(normalize(vec3(ray.x, 0.0, ray.z) + 1e-5),
                                normalize(vec3(sun.x, 0.0, sun.z) + 1e-5)), 0.0), 3.0);
  col += uSunColor * horizonBand * azimuth * lowSun * 0.30 * uSunGlow;

  outColor = vec4(col, 1.0);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uOffset;
void main() { gl_Position = uVP * vec4(aPos + uOffset, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in float aLayer;
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uFogStart;
uniform float uFogRange;
out vec2 vUV;
out float vLayer;
out float vFog;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  vUV = aUV;
  vLayer = aLayer;
  vFog = clamp((length(aPos - uCam) - uFogStart) / uFogRange, 0.0, 1.0);
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;
in vec2 vUV;
in float vLayer;
in float vFog;
uniform sampler2DArray uAtlas;
uniform vec3 uSkyColor;
uniform vec3 uSkyLightColor;
uniform float uLightMul;
out vec4 outColor;
void main() {
  vec4 tex = texture(uAtlas, vec3(vUV, vLayer));
  if (tex.a < 0.4) discard;
  vec3 col = tex.rgb * uLightMul * uSkyLightColor;
  outColor = vec4(mix(col, uSkyColor, vFog), 1.0);
}`;

// ------------------------------------------------------------------ helpers
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    throw new Error('shader compile failed: ' + log + '\n' + src);
  }
  return s;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

/** Unit cube 0..1 with per-face shading and 0..1 UVs; used for all box models. */
function makeBoxGeometry() {
  const faces = [
    { n: [0, 0, -1], shade: 0.80, v: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
    { n: [0, 0, 1], shade: 0.80, v: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { n: [-1, 0, 0], shade: 0.68, v: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { n: [1, 0, 0], shade: 0.68, v: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [0, 1, 0], shade: 1.00, v: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { n: [0, -1, 0], shade: 0.52, v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  ];
  const uv = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const order = [0, 1, 2, 0, 2, 3];
  const out = [];
  for (const f of faces) {
    for (const k of order) {
      const p = f.v[k], t = uv[k];
      out.push(p[0], p[1], p[2], t[0], t[1], f.shade);
    }
  }
  return new Float32Array(out);
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      // 4x MSAA keeps the voxel edges clean without a post-process pass
      antialias: true, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;

    this.progChunk = program(gl, CHUNK_VS_FULL, BLOCK_FS);
    this.__chunkVs = CHUNK_VS_FULL;     // exposed for the diagnostic harness
    this.progWater = program(gl, CHUNK_VS_FULL, WATER_FS);
    this.progEntity = program(gl, ENTITY_VS, ENTITY_FS);
    this.progSky = program(gl, SKY_VS, SKY_FS);
    this.progLine = program(gl, LINE_VS, LINE_FS);
    this.progParticle = program(gl, PARTICLE_VS, PARTICLE_FS);

    this.atlasTex = this._createAtlas();
    this.maxQuads = 1 << 15;

    this.skyVao = this._createSkyQuad();
    this.lineVao = this._createLineBox();

    // entity box geometry (interleaved pos+uv+shade)
    this.entityVao = gl.createVertexArray();
    gl.bindVertexArray(this.entityVao);
    const ebuf = gl.createBuffer();
    this.entityGeo = makeBoxGeometry();
    this.entityQuads = this.entityGeo.length / (6 * 6);
    gl.bindBuffer(gl.ARRAY_BUFFER, ebuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.entityGeo, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);

    this.particleVao = gl.createVertexArray();
    this.particleVbo = gl.createBuffer();
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(6 * 6 * 200), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 20);
    gl.bindVertexArray(null);
    this.particleQuads = 0;

    this.proj = m4identity(new Float32Array(16));
    this.view = m4identity(new Float32Array(16));
    this.vp = m4identity(new Float32Array(16));
    this.frustum = new Float32Array(24);
    this.tmpModel = m4identity(new Float32Array(16));

    this.stats = { draws: 0, quads: 0, uploads: 0, bytesUploaded: 0, culled: 0 };

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(0.55, 0.72, 0.95, 1);
  }

  /**
   * Block textures live in a WebGL2 texture ARRAY: one 16x16 tile per layer.
   * Mipmapping is then safe — each tile has its own pyramid, so a distant surface is
   * filtered instead of collapsing into black stripes from neighbouring tiles.
   */
  _createAtlas() {
    const gl = this.gl;
    const layerBytes = TILE_PX * TILE_PX * 4;
    const pixels = new Uint8Array(layerBytes * LAYER_COUNT);
    paintAllTiles((index, x, y, r, g, b, a) => {
      const i = index * layerBytes + (y * TILE_PX + x) * 4;
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
    }, null);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    const levels = Math.floor(Math.log2(TILE_PX)) + 1;
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, TILE_PX, TILE_PX, LAYER_COUNT);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, TILE_PX, TILE_PX, LAYER_COUNT,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Anisotropic filtering keeps ground textures from smearing into mush at grazing
    // angles. A 16px tile magnified across a receding plain needs the extra samples;
    // without it distant terrain shimmers and reads as noise.
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      this.maxAnisotropy = Math.min(8, max);
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, this.maxAnisotropy);
    } else {
      this.maxAnisotropy = 1;
    }
    this.atlasArray = tex;
    return tex;
  }

  /** Bind the block texture array to a texture unit. */
  bindAtlas(unit = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasArray);
  }

  _createSkyQuad() {
    // The sky uses the gl_VertexID trick, so an empty VAO is all that is needed.
    const gl = this.gl;
    return gl.createVertexArray();
  }

  _createLineBox() {
    const gl = this.gl;
    const e = 0.002;
    const p = [
      [0 - e, 0 - e, 0 - e], [1 + e, 0 - e, 0 - e], [1 + e, 0 - e, 1 + e], [0 - e, 0 - e, 1 + e],
      [0 - e, 1 + e, 0 - e], [1 + e, 1 + e, 0 - e], [1 + e, 1 + e, 1 + e], [0 - e, 1 + e, 1 + e],
    ];
    const edges = [
      0, 1, 1, 2, 2, 3, 3, 0,
      4, 5, 5, 6, 6, 7, 7, 4,
      0, 4, 1, 5, 2, 6, 3, 7,
    ];
    const data = new Float32Array(edges.length * 3);
    for (let i = 0; i < edges.length; i++) {
      data[i * 3] = p[edges[i]][0]; data[i * 3 + 1] = p[edges[i]][1]; data[i * 3 + 2] = p[edges[i]][2];
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.lineVertexCount = edges.length;
    return vao;
  }

  resize(width, height, dpr) {
    const gl = this.gl;
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.aspect = w / h;
    gl.viewport(0, 0, w, h);
    this.pixelWidth = w; this.pixelHeight = h;
  }

  /**
   * Upload a chunk mesh into a per-chunk VAO/VBO.
   *
   * The mesher emits *fully unrolled* triangles — six vertices per quad, with no vertex
   * reuse — so an index buffer is not just redundant, it was actively wrong: the indices
   * were generated for four-vertex quads, which pointed at the wrong vertices and only
   * covered two thirds of the geometry. That mismatch is what produced the fanned-out
   * triangles and black holes in the terrain. Drawing with drawArrays matches the data.
   */
  uploadChunk(chunk) {
    const gl = this.gl;
    const mesh = chunk.mesh;
    for (const kind of ['opaque', 'water']) {
      const part = mesh ? mesh[kind] : null;
      const slot = chunk['_' + kind] || (chunk['_' + kind] = { vao: null, vbo: null, verts: 0, quads: 0 });
      if (!part || part.verts === 0) { slot.verts = 0; slot.quads = 0; continue; }
      if (!slot.vao) {
        slot.vao = gl.createVertexArray();
        slot.vbo = gl.createBuffer();
        gl.bindVertexArray(slot.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERT_BYTES, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERT_BYTES, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, VERT_BYTES, 20);
        gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, VERT_BYTES, 24);
        gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, VERT_BYTES, 28);
        gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, VERT_BYTES, 32);
        gl.bindVertexArray(null);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, slot.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, part.data, gl.DYNAMIC_DRAW);
      slot.verts = part.verts;
      slot.quads = Math.floor(part.verts / 6);
      this.stats.uploads++;
      this.stats.bytesUploaded += part.data.byteLength;
    }
  }

  freeChunk(chunk) {
    const gl = this.gl;
    for (const kind of ['opaque', 'water']) {
      const slot = chunk['_' + kind];
      if (!slot) continue;
      if (slot.vbo) gl.deleteBuffer(slot.vbo);
      if (slot.vao) gl.deleteVertexArray(slot.vao);
      chunk['_' + kind] = null;
    }
  }

  // ------------------------------------------------------------------ frame setup
  beginFrame(cam, fov, renderDistanceBlocks) {
    const gl = this.gl;
    // near/far ratio kept tight enough for a 24-bit depth buffer; a very small near
    // plane is what produces shimmering on wide, flat surfaces like beaches
    m4perspective(this.proj, fov, this.aspect, 0.12, Math.max(320, renderDistanceBlocks * 1.9));
    // `fov` is already in radians here (m4perspective takes radians), so the sky shader
    // gets tan(fov/2) directly — scaling it again collapsed every pixel onto one ray.
    this.tanHalfFov = Math.tan(fov * 0.5);
    m4view(this.view, cam.x, cam.y, cam.z, cam.yaw, cam.pitch);
    m4multiply(this.vp, this.proj, this.view);
    frustumFromMatrix(this.vp, this.frustum);
    this.cam = cam;
    this.fogStart = renderDistanceBlocks * 0.62;
    this.fogRange = Math.max(28, renderDistanceBlocks * 0.9);
    this.stats.draws = 0; this.stats.quads = 0; this.stats.culled = 0;
    return this.vp;
  }

  drawSky(horizon, zenith, sunDir, sunGlow, sunColor) {
    const gl = this.gl;
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progSky.p);
    gl.uniform3fv(this.progSky.u.uHorizon, horizon);
    gl.uniform3fv(this.progSky.u.uZenith, zenith);
    gl.uniform3fv(this.progSky.u.uSunDir, sunDir);
    gl.uniform3fv(this.progSky.u.uSunColor, sunColor || [1.0, 0.96, 0.86]);
    gl.uniform1f(this.progSky.u.uSunGlow, sunGlow);
    // Camera basis for per-pixel ray reconstruction.
    // `view` is world -> view, so its rotation rows are (right, up, -forward). To get
    // from view space back to world the shader needs the transpose, which in
    // column-major upload order is these nine values.
    const v = this.view;
    gl.uniformMatrix3fv(this.progSky.u.uViewRot, false, new Float32Array([
      v[0], v[4], v[8],
      v[1], v[5], v[9],
      v[2], v[6], v[10],
    ]));
    gl.uniform1f(this.progSky.u.uTanHalfFov, this.tanHalfFov || 0.7);
    gl.uniform1f(this.progSky.u.uAspect, this.aspect || 1.0);
    gl.bindVertexArray(this.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  /** Draw all opaque chunk geometry. */
  drawChunks(world, originX, originZ, dayLight, skyColor, skyLightColor, tint) {
    // diagnostic hook used by tools/probes (never set in normal play)
    if (this.preChunkHook) this.preChunkHook(world, this);
    const gl = this.gl;
    const prog = this.progChunk;
    gl.useProgram(prog.p);
    this.bindAtlas(0);
    gl.uniform1i(prog.u.uAtlas, 0);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniform3f(prog.u.uCam, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform1f(prog.u.uFogStart, this.fogStart);
    gl.uniform1f(prog.u.uFogRange, this.fogRange);
    gl.uniform3fv(prog.u.uSkyColor, skyColor);
    gl.uniform3fv(prog.u.uSkyLightColor, skyLightColor);
    gl.uniform3fv(prog.u.uTint, tint);
    gl.uniform1f(prog.u.uAlphaTest, 0.5);
    gl.uniform1f(prog.u.uOpacity, 1.0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    let drawn = 0;
    for (const chunk of world.chunks.values()) {
      const slot = chunk._opaque;
      if (!slot || !slot.verts) continue;
      const bx = chunk.cx * CX, bz = chunk.cz * CZ;
      // frustum cull: pad by a block so partial chunks at the screen edge never pop
      if (!aabbInFrustum(this.frustum, bx - 1, -1, bz - 1, bx + CX + 1, WORLD_H + 1, bz + CZ + 1)) {
        this.stats.culled++;
        continue;
      }
      gl.uniform3f(prog.u.uOrigin, bx, 0, bz);
      gl.bindVertexArray(slot.vao);
      gl.drawArrays(gl.TRIANGLES, 0, slot.verts);
      this.stats.draws++; this.stats.quads += slot.quads;
      drawn++;
    }
    gl.bindVertexArray(null);
    return drawn;
  }

  drawWater(world, dayLight, skyColor, skyLightColor, tint) {
    const gl = this.gl;
    const prog = this.progWater;
    gl.useProgram(prog.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    // The liquid surface sits 1/8 of a block below the block boundary, which removes the
    // coplanar shimmer it would otherwise have against beach/floor blocks (classic
    // z-fighting stripes on a shoreline).
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1.0, -2.0);
    this.bindAtlas(0);
    gl.uniform1i(prog.u.uAtlas, 0);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniform3f(prog.u.uCam, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform1f(prog.u.uFogStart, this.fogStart);
    gl.uniform1f(prog.u.uFogRange, this.fogRange);
    gl.uniform3fv(prog.u.uSkyColor, skyColor);
    gl.uniform3fv(prog.u.uSkyLightColor, skyLightColor);
    gl.uniform3fv(prog.u.uTint, tint);
    gl.uniform1f(prog.u.uOpacity, 0.62);
    for (const chunk of world.chunks.values()) {
      const slot = chunk._water;
      if (!slot || !slot.verts) continue;
      const bx = chunk.cx * CX, bz = chunk.cz * CZ;
      if (!aabbInFrustum(this.frustum, bx - 1, -1, bz - 1, bx + CX + 1, WORLD_H + 1, bz + CZ + 1)) continue;
      gl.uniform3f(prog.u.uOrigin, bx, 0, bz);
      gl.bindVertexArray(slot.vao);
      gl.drawArrays(gl.TRIANGLES, 0, slot.verts);
      this.stats.draws++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
  }

  /**
   * Draw a box-model entity. `parts` is a list of
   * { x,y,z,w,h,d, uv:[u0,v0,du,dv] per face or single, color, light, rotY, rotX, pivot }.
   */
  drawBoxModel(model, parts, skyColor, skyLightColor) {
    const gl = this.gl;
    const prog = this.progEntity;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniform3f(prog.u.uCam, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform1f(prog.u.uFogStart, this.fogStart);
    gl.uniform1f(prog.u.uFogRange, this.fogRange);
    gl.uniform3fv(prog.u.uSkyColor, skyColor);
    gl.uniform3fv(prog.u.uSkyLightColor, skyLightColor);
    gl.bindVertexArray(this.entityVao);
    let quads = 0;
    for (const p of parts) {
      const m = m4identity(this.tmpModel);
      // translate to part origin then apply model transform
      m4translate(m, p.x, p.y, p.z);
      if (p.rotY || p.rotX || p.rotZ) {
        const r = m4identity(new Float32Array(16));
        if (p.rotY) m4rotY(r, p.rotY);
        if (p.rotX) { const rx = m4rotX(new Float32Array(16), p.rotX); m4multiply(r, r, rx); }
        if (p.rotZ) { const rz = m4rotZ(new Float32Array(16), p.rotZ); m4multiply(r, r, rz); }
        // rotate about pivot then scale
        const s = m4scale(new Float32Array(16), p.w ?? 1, p.h ?? 1, p.d ?? 1);
        const tmp = m4multiply(new Float32Array(16), r, s);
        m4multiply(m, m, tmp);
      } else {
        const s = m4scale(new Float32Array(16), p.w ?? 1, p.h ?? 1, p.d ?? 1);
        m4multiply(m, m, s);
      }
      m4multiply(m, model, m);
      gl.uniformMatrix4fv(prog.u.uModel, false, m);
      gl.uniform4fv(prog.u.uColor, p.color || [1, 1, 1, 0]);
      gl.uniform1f(prog.u.uLightMul, p.light ?? 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.entityGeo.length / 6);
      quads += this.entityQuads;
    }
    gl.bindVertexArray(null);
    this.stats.draws++;
    this.stats.quads += quads;
    return quads;
  }

  drawParticles(particles, skyColor, skyLightColor) {
    if (!particles.length) return;
    const gl = this.gl;
    const count = Math.min(particles.length, 200);
    const STRIDE_FLOATS = 6;
    const data = new Float32Array(count * 6 * STRIDE_FLOATS);
    // camera-facing billboard basis (yaw only, so particles stay upright)
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    const rx = cy, rz = sy;              // camera right in world space
    let o = 0;
    for (let i = 0; i < count; i++) {
      const p = particles[i];
      const s = p.size;
      const ax = p.x - rx * s, az = p.z - rz * s;
      const bx = p.x + rx * s, bz = p.z + rz * s;
      const y0 = p.y - s, y1 = p.y + s;
      const layer = p.layer || 0;
      // two triangles: (a,y0) (a,y1) (b,y1) / (a,y0) (b,y1) (b,y0)
      const verts = [
        ax, y0, az, p.u0, p.v1, layer,
        ax, y1, az, p.u0, p.v0, layer,
        bx, y1, bz, p.u1, p.v0, layer,
        ax, y0, az, p.u0, p.v1, layer,
        bx, y1, bz, p.u1, p.v0, layer,
        bx, y0, bz, p.u1, p.v1, layer,
      ];
      for (let k = 0; k < verts.length; k++) data[o++] = verts[k];
    }
    const prog = this.progParticle;
    gl.useProgram(prog.p);
    this.bindAtlas(0);
    gl.uniform1i(prog.u.uAtlas, 0);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniform3f(prog.u.uCam, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform1f(prog.u.uFogStart, this.fogStart);
    gl.uniform1f(prog.u.uFogRange, this.fogRange);
    gl.uniform3fv(prog.u.uSkyColor, skyColor);
    gl.uniform3fv(prog.u.uSkyLightColor, skyLightColor);
    gl.uniform1f(prog.u.uLightMul, 1.0);
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.drawArrays(gl.TRIANGLES, 0, count * 6);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    this.stats.draws++;
  }

  /**
   * Draw a chunk-style mesh (VERT_BYTES layout) with an arbitrary model matrix.
   * Used for the first-person held item, dropped item entities, and GUI block previews.
   */
  drawBlockMesh(model, vao, quads, skyColor, skyLightColor, lightMul = 1.0, alphaTest = 0.5, tint = [1, 1, 1]) {
    if (!vao || !quads) return;
    const gl = this.gl;
    const prog = this.progChunk;
    gl.useProgram(prog.p);
    this.bindAtlas(0);
    gl.uniform1i(prog.u.uAtlas, 0);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniformMatrix4fv(prog.u.uModel, false, model);
    gl.uniform3f(prog.u.uOrigin, 0, 0, 0);
    gl.uniform3f(prog.u.uCam, this.cam.x, this.cam.y, this.cam.z);
    gl.uniform1f(prog.u.uFogStart, 1e9);
    gl.uniform1f(prog.u.uFogRange, 1e9);
    gl.uniform3fv(prog.u.uSkyColor, skyColor);
    gl.uniform3fv(prog.u.uSkyLightColor, skyLightColor);
    const m = Math.max(0, Math.min(2, lightMul));
    gl.uniform3f(prog.u.uTint, tint[0] * m, tint[1] * m, tint[2] * m);
    gl.uniform1f(prog.u.uAlphaTest, alphaTest);
    gl.uniform1f(prog.u.uOpacity, 1.0);
    gl.uniform1f(prog.u.uModelMode, 1.0);
    // item meshes carry the same vertex layout as chunk meshes, including the texture
    // array layer, and are likewise fully unrolled triangles (six vertices per quad)
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, quads * 6);
    gl.bindVertexArray(null);
    gl.uniform1f(prog.u.uModelMode, 0.0);
    this.stats.draws++;
    this.stats.quads += quads;
  }

  drawOutline(x, y, z, color, width) {
    const gl = this.gl;
    const prog = this.progLine;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.u.uVP, false, this.vp);
    gl.uniform3f(prog.u.uOffset, x, y, z);
    gl.uniform4fv(prog.u.uColor, color);
    gl.bindVertexArray(this.lineVao);
    if (width) gl.lineWidth(width);
    gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    gl.bindVertexArray(null);
  }
}

export { frustumFromMatrix, aabbInFrustum };
