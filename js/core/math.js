// core/math.js — minimal, allocation-free math helpers for the voxel engine.
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function smoothstep(t) { return t * t * (3 - 2 * t); }
export function fract(v) { return v - Math.floor(v); }
export function sign(v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); }
export function mod(a, n) { return ((a % n) + n) % n; }

/** Deterministic 32-bit integer hash -> [0,1) */
export function hash2i(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function hash3i(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1013904223) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** mulberry32 PRNG — small, fast, reproducible. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- mat4 (column major, like GL)
export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function m4identity(m) {
  m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0;
  m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
  return m;
}

export function m4perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
  out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
  return out;
}

export function m4ortho(out, l, r, b, t, n, f) {
  const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
  out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0;
  out[12] = (l + r) * lr; out[13] = (t + b) * bt; out[14] = (f + n) * nf; out[15] = 1;
  return out;
}

export function m4multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

/** View matrix from yaw/pitch/eye position (right-handed, Y up, -Z forward at yaw=0). */
export function m4view(out, x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // forward = (sy*cp, sp, -cy*cp) ; right = (cy, 0, sy) ; up = right x forward
  const fx = sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, ry = 0, rz = sy;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  out[0] = rx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = ry; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = rz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(rx * x + ry * y + rz * z);
  out[13] = -(ux * x + uy * y + uz * z);
  out[14] = fx * x + fy * y + fz * z;
  out[15] = 1;
  return out;
}

export function m4translate(out, x, y, z) {
  m4identity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

export function m4scale(out, x, y, z) {
  m4identity(out);
  out[0] = x; out[5] = y; out[10] = z;
  return out;
}

export function m4rotY(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}

export function m4rotX(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}

export function m4rotZ(out, a) {
  const c = Math.cos(a), s = Math.sin(a);
  m4identity(out);
  out[0] = c; out[1] = s; out[4] = -s; out[5] = c;
  return out;
}

export function m4aim(out, x, y, z, yaw, pitch, sx, sy, sz) {
  // T * Ry * Rx * S
  const cy = Math.cos(yaw), sy2 = Math.sin(yaw);
  const cx = Math.cos(pitch), sx2 = Math.sin(pitch);
  const m = out;
  m[0] = cy * sx; m[1] = 0; m[2] = -sy2 * sx; m[3] = 0;
  m[4] = sy2 * sx2 * sy; m[5] = cx * sy; m[6] = cy * sx2 * sy; m[7] = 0;
  m[8] = sy2 * cx * sz; m[9] = -sx2 * sz; m[10] = cy * cx * sz; m[11] = 0;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return m;
}

/** Extract 6 frustum planes (a,b,c,d) from a view-projection matrix. */
export function frustumFromMatrix(vp, out) {
  const planes = out || new Float32Array(24);
  const rows = [
    [vp[0], vp[4], vp[8], vp[12]],
    [vp[1], vp[5], vp[9], vp[13]],
    [vp[2], vp[6], vp[10], vp[14]],
    [vp[3], vp[7], vp[11], vp[15]],
  ];
  const set = (i, a, b, c, d) => {
    const len = Math.hypot(a, b, c) || 1;
    planes[i * 4] = a / len; planes[i * 4 + 1] = b / len;
    planes[i * 4 + 2] = c / len; planes[i * 4 + 3] = d / len;
  };
  set(0, rows[3][0] + rows[0][0], rows[3][1] + rows[0][1], rows[3][2] + rows[0][2], rows[3][3] + rows[0][3]);
  set(1, rows[3][0] - rows[0][0], rows[3][1] - rows[0][1], rows[3][2] - rows[0][2], rows[3][3] - rows[0][3]);
  set(2, rows[3][0] + rows[1][0], rows[3][1] + rows[1][1], rows[3][2] + rows[1][2], rows[3][3] + rows[1][3]);
  set(3, rows[3][0] - rows[1][0], rows[3][1] - rows[1][1], rows[3][2] - rows[1][2], rows[3][3] - rows[1][3]);
  set(4, rows[3][0] + rows[2][0], rows[3][1] + rows[2][1], rows[3][2] + rows[2][2], rows[3][3] + rows[2][3]);
  set(5, rows[3][0] - rows[2][0], rows[3][1] - rows[2][1], rows[3][2] - rows[2][2], rows[3][3] - rows[2][3]);
  return planes;
}

export function aabbInFrustum(planes, minx, miny, minz, maxx, maxy, maxz) {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
    const px = a > 0 ? maxx : minx;
    const py = b > 0 ? maxy : miny;
    const pz = c > 0 ? maxz : minz;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

/** Ray / axis-aligned box intersection (slab method). Returns t or -1. */
export function rayBox(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz) {
  let tmin = -Infinity, tmax = Infinity;
  if (dx !== 0) {
    let t1 = (minx - ox) / dx, t2 = (maxx - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (ox < minx || ox > maxx) return -1;
  if (dy !== 0) {
    let t1 = (miny - oy) / dy, t2 = (maxy - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oy < miny || oy > maxy) return -1;
  if (dz !== 0) {
    let t1 = (minz - oz) / dz, t2 = (maxz - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oz < minz || oz > maxz) return -1;
  if (tmax < Math.max(tmin, 0)) return -1;
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : -1);
}
