/**
 * BLOM Play: camera-driven Gray-Scott reaction diffusion (WebGL2)
 * Ported from backup_Feb7/backup_feb7.pde
 */

const MAX_SIM_W = 1280;
const MAX_SIM_H = 720;
const PASSES = 36;
const PRIME_PASSES = 4;
const START_WARMUP = 2;
const MIN_CALIB_SPAN = 0.025;
const CALIB_BLEND = 0.45;
const TARGET_FPS = 0;

/**
 * Maps t∈[0,1] to (F, k) on the Gray-Scott crescent (ReactionDiffusion3).
 * kOff shifts kill perpendicular to the ridge.
 */
function crescentFK(t, kOff) {
  const F = 0.006 + (0.100 - 0.006) * t;
  const k = -7.91 * F * F + 1.025 * F + 0.0325 + kOff;
  return [F, k];
}

// ReactionDiffusion3: patterns live on t ∈ [0.12, 0.72] — beyond that → uniform pink/white.
const CRESCENT_T_PATTERN_LO = 0.12;
const CRESCENT_T_PATTERN_HI = 0.72;

// Fixed Gray-Scott band (former preset 7 “Spots”) — presets no longer change this.
const SIM_FK = {
  t_low: 0.28, t_high: 0.42,
  k_off_low: -0.004, k_off_high: 0.006
};

const DEFAULT_CAM_PRESET = 0;

/** B/L/O/M centroids in logo art (normalized 0–1 within the SVG viewBox). */
const LOGO_SEED_POINTS = [
  [0.17, 0.38], [0.17, 0.52], [0.17, 0.66],
  [0.27, 0.38], [0.27, 0.52],
  [0.50, 0.50],
  [0.76, 0.38], [0.83, 0.52], [0.76, 0.66]
];

/** Camera-input presets: how webcam RGB is turned into the driving signal. */
const CAM_PRESETS = [
  { id: '1', name: 'Blend', mode: 0, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'R + G sum' },
  { id: '2', name: 'Negative', mode: 1, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'Inverted brightness' },
  { id: '3', name: 'Skin', mode: 2, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'Warm skin-weighted luma' },
  { id: '4', name: 'Chroma', mode: 3, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'Color contrast edges' },
  { id: '5', name: 'Ruby', mode: 4, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'Red channel emphasis' },
  { id: '6', name: 'Spots', mode: 5, cal_lo: 0.06, cal_hi: 0.94,
    hint: 'Color separation' }
];

/** @deprecated alias */
const KF_PRESETS = CAM_PRESETS;

/** Sample camera signal in JS (must match camSignal() in GRAYSCOTT_MOTION_FRAG). */
function sampleCamSignal(r, g, b, mode) {
  switch (mode) {
    case 0: return r + g;
    case 1: return 2.0 - (r + g);
    case 2: return 0.55 * r + 0.40 * g + 0.05 * b;
    case 3: return Math.abs(r - g) + 0.45 * Math.abs(g - b);
    case 4: return Math.max(r - g * 0.55, 0);
    case 5: return Math.max(r, g, b) - Math.min(r, g, b);
    default: return r + g;
  }
}

/** Neutral Gray-Scott outside face in face-only mode (low F, high k → uniform field). */
const NEUTRAL_FEED = 0.006;
const NEUTRAL_KILL = 0.068;

/** BLOM watermark — fixed crescent F/k (Spots band — reliably patterns). */
const LOGO_MASK_URL = 'logo-mask.svg';
const LOGO_SVG_W = 750;
const LOGO_SVG_H = 184;
const LOGO_FK = crescentFK(0.35, 0.001);

function clampPatternT(t) {
  return Math.max(CRESCENT_T_PATTERN_LO, Math.min(CRESCENT_T_PATTERN_HI, t));
}

/** Precompute F/k corners on the crescent for the fixed sim band. */
function simFKCorners() {
  const fkLo = crescentFK(clampPatternT(SIM_FK.t_low), SIM_FK.k_off_low);
  const fkHi = crescentFK(clampPatternT(SIM_FK.t_high), SIM_FK.k_off_high);
  return {
    feed_lo: fkLo[0],
    kill_lo: fkLo[1],
    feed_hi: fkHi[0],
    kill_hi: fkHi[1]
  };
}

const COPY_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
void main() { fragColor = texture(tex, v_uv); }`;

const STAMP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
uniform vec2 center;
uniform vec2 radius;
uniform vec2 texSize;

void main() {
  vec4 val = texture(tex, v_uv);
  vec2 px = vec2(v_uv.x * texSize.x, (1.0 - v_uv.y) * texSize.y);
  vec2 d = (px - center) / radius;
  if (dot(d, d) <= 1.0) {
    // Match SEED_FRAG: u=1 equilibrium with local v=1 perturbation
    fragColor = vec4(1.0, 1.0, 0.0, 1.0);
  } else {
    fragColor = val;
  }
}`;

const LOGO_SEED_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
uniform sampler2D logoMask;

void main() {
  vec4 val = texture(tex, v_uv);
  float logoM = max(texture(logoMask, v_uv).r, max(texture(logoMask, v_uv).g, texture(logoMask, v_uv).b));
  if (logoM > 0.05) {
    fragColor = vec4(1.0, 1.0, 0.0, 1.0);
  } else {
    fragColor = val;
  }
}`;

const SEED_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 texSize;
uniform float seedPhase;
uniform float seedDensity;
uniform float gridCols;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  float u = 1.0;
  float v = 0.0;
  vec2 px = vec2(v_uv.x * texSize.x, v_uv.y * texSize.y);

  float cellW = max(10.0, texSize.x / gridCols);
  float gridRows = max(8.0, floor(texSize.y / cellW + 0.5));
  float cellH = texSize.y / gridRows;
  vec2 cellSize = vec2(cellW, cellH);

  // Primary grid — elliptical dots, full width and height
  vec2 gid = floor(px / cellSize);
  vec2 gcenter = (gid + 0.5) * cellSize;
  vec2 grel = (px - gcenter) / (cellSize * 0.36);
  if (dot(grel, grel) <= 1.0) v = 1.0;

  // Staggered grid — fills gaps between rows and columns
  vec2 off = cellSize * 0.5;
  vec2 gid2 = floor((px - off) / cellSize);
  vec2 center2 = off + (gid2 + 0.5) * cellSize;
  vec2 rel2 = (px - center2) / (cellSize * 0.30);
  if (dot(rel2, rel2) <= 1.0) v = 1.0;

  // Fine hash specks scattered across the entire frame
  if (hash21(floor(px / 10.0) + seedPhase) > seedDensity) v = 1.0;
  if (hash21(floor((px + vec2(6.0, 9.0)) / 15.0) + seedPhase * 2.17) > seedDensity + 0.05) v = 1.0;

  fragColor = vec4(u, v, 0.0, 1.0);
}`;

const GRAYSCOTT_MOTION_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;

const float ANISO_STRENGTH = 0.4;
const float ANISO_SIGN = 1.0;
const float BODY_DRIFT = 0.0;

const float T_PATTERN_LO = ${CRESCENT_T_PATTERN_LO.toFixed(2)};
const float T_PATTERN_HI = ${CRESCENT_T_PATTERN_HI.toFixed(2)};

uniform vec2 wh_rcp;
uniform sampler2D tex;
uniform sampler2D kf_map;
uniform sampler2D dA_map;
uniform sampler2D faceMask;
uniform sampler2D logoMask;
uniform float dA;
uniform float dA_low;
uniform float feed_lo;
uniform float kill_lo;
uniform float feed_hi;
uniform float kill_hi;
uniform float t_low;
uniform float t_high;
uniform float k_off_low;
uniform float k_off_high;
uniform float reverseK;
uniform float reverseD;
uniform float intensity;
uniform float intensity_ref;
uniform float kf_lo;
uniform float kf_hi;
uniform float cam_mode;
uniform float faceOnlyActive;
uniform float logo_feed;
uniform float logo_kill;
uniform float dt;
uniform float drift_x;
uniform float drift_y;
uniform float motion_force;

vec2 crescentFK(float tc, float kOff) {
  float F = mix(0.006, 0.100, clamp(tc, 0.0, 1.0));
  float k = -7.91 * F * F + 1.025 * F + 0.0325 + kOff;
  return vec2(F, k);
}

float camSignal(vec3 rgb, float mode) {
  float r = rgb.r;
  float g = rgb.g;
  float b = rgb.b;
  if (mode < 0.5) return r + g;
  if (mode < 1.5) return 2.0 - (r + g);
  if (mode < 2.5) return 0.55 * r + 0.40 * g + 0.05 * b;
  if (mode < 3.5) return abs(r - g) + 0.45 * abs(g - b);
  if (mode < 4.5) return max(r - g * 0.55, 0.0);
  return max(max(r, g), b) - min(min(r, g), b);
}

void main() {
  float new_kill, new_feed, new_dA, new_dB;
  vec2 posn = v_uv;
  vec2 drift = vec2(drift_x, drift_y);
  float drift_len = length(drift) + 1e-6;
  vec2 flow_dir = drift / drift_len;
  vec2 body_pos = posn;
  if (BODY_DRIFT > 0.0) {
    float drift_speed = min(motion_force * BODY_DRIFT, 0.001);
    body_pos = clamp(posn - flow_dir * drift_speed * dt, vec2(0.0), vec2(1.0));
  }
  vec4 val = texture(tex, body_pos);
  vec4 kf_val = texture(kf_map, posn);
  vec4 dA_val = texture(dA_map, posn);

  float rawLuma = camSignal(kf_val.rgb, cam_mode);
  float t_lin = clamp((rawLuma - kf_lo) / max(kf_hi - kf_lo, 0.001), 0.0, 1.0);
  float gain = intensity_ref / max(intensity, 0.001);
  float t_cam = clamp(0.5 + (t_lin - 0.5) * gain, 0.0, 1.0);

  if (reverseK > 0.5) {
    new_kill = mix(kill_hi, kill_lo, t_cam);
    new_feed = mix(feed_hi, feed_lo, t_cam);
  } else {
    new_kill = mix(kill_lo, kill_hi, t_cam);
    new_feed = mix(feed_lo, feed_hi, t_cam);
  }

  vec2 neutralFk = vec2(${NEUTRAL_FEED.toFixed(3)}, ${NEUTRAL_KILL.toFixed(3)});
  vec2 patternFk = vec2(new_feed, new_kill);

  float faceW = texture(faceMask, posn).r;
  if (faceOnlyActive > 0.5) {
    float rim = 1.0 - clamp(faceW, 0.0, 1.0);
    float rimU = smoothstep(0.06, 0.20, rim);
    float rimT = clamp(mix(t_low, t_high, rimU), T_PATTERN_LO, T_PATTERN_HI);
    float rimKo = mix(k_off_low, k_off_high, rimU);
    vec2 rimFk = crescentFK(rimT, rimKo);
    vec2 edgeFk = mix(neutralFk, rimFk, smoothstep(0.12, 0.32, faceW));
    new_feed = mix(edgeFk.x, patternFk.x, smoothstep(0.42, 0.78, faceW));
    new_kill = mix(edgeFk.y, patternFk.y, smoothstep(0.42, 0.78, faceW));
  } else {
    new_feed = patternFk.x;
    new_kill = patternFk.y;
  }

  if (reverseD > 0.5) {
    new_dA = dA_val.g * (dA - dA_low) + dA_low;
    new_dB = new_dA / 2.0;
  } else {
    new_dA = dA_val.g * (dA_low - dA) + dA;
    new_dB = new_dA / 2.0;
  }
  float motion = min(motion_force * 0.06 * ANISO_STRENGTH, 0.85) * ANISO_SIGN;
  vec2 texel = wh_rcp;
  vec4 laplace = -val;
  float w_mx = 0.20 * (1.0 - motion * flow_dir.x);
  float w_px = 0.20 * (1.0 + motion * flow_dir.x);
  float w_my = 0.20 * (1.0 - motion * flow_dir.y);
  float w_py = 0.20 * (1.0 + motion * flow_dir.y);
  float diag = 0.05;
  laplace += texture(tex, posn + vec2(-texel.x, 0.0)) * w_px;
  laplace += texture(tex, posn + vec2( texel.x, 0.0)) * w_mx;
  laplace += texture(tex, posn + vec2(0.0, -texel.y)) * w_py;
  laplace += texture(tex, posn + vec2(0.0,  texel.y)) * w_my;
  laplace += texture(tex, posn + vec2(-texel.x, -texel.y)) * diag;
  laplace += texture(tex, posn + vec2( texel.x, -texel.y)) * diag;
  laplace += texture(tex, posn + vec2(-texel.x,  texel.y)) * diag;
  laplace += texture(tex, posn + vec2( texel.x,  texel.y)) * diag;
  float sum_w = w_mx + w_px + w_my + w_py + 4.0 * diag;
  laplace = -val + (laplace + val) / sum_w;
  if (dA_val.r == 1.0) {
    new_kill = 0.068;
    new_feed = 0.06;
  }

  float logoM = max(texture(logoMask, posn).r, max(texture(logoMask, posn).g, texture(logoMask, posn).b));
  if (logoM > 0.1) {
    new_feed = logo_feed;
    new_kill = logo_kill;
  }

  float nA = val.r + (new_dA * laplace.r - val.r * val.g * val.g + new_feed * (1.0 - val.r)) * dt;
  float nB = val.g + (new_dB * laplace.g + val.r * val.g * val.g - (new_kill + new_feed) * val.g) * dt;
  fragColor = vec4(clamp(vec2(nA, nB), vec2(0.0), vec2(1.0)), 0.0, 1.0);
}`;

const RENDER_VIBRANT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
uniform sampler2D faceMask;
uniform float faceHighlight;

void main() {
  vec2 val = texture(tex, v_uv).rg;
  float intensity = val.r - 1.65 * val.g;
  vec3 color_low = vec3(1.0, 0.968, 1.0);
  vec3 color_high = vec3(1.0, 0.2, 0.55);
  float curved = pow(max(intensity, 0.0), 0.82);
  vec3 col = mix(color_high, color_low, curved);
  float mask = texture(faceMask, v_uv).r;
  col = mix(col, min(col * 1.2, vec3(1.0)), mask * faceHighlight);
  fragColor = vec4(col, 1.0);
}`;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function computeSimSize(video, layout) {
  const vw = (video && video.videoWidth) ? video.videoWidth : 640;
  const vh = (video && video.videoHeight) ? video.videoHeight : 480;
  const headerH = 52;
  const pad = 12;
  const sideW = layout ? (layout.controlW + pad * 2) : 32;
  const maxH = Math.min(MAX_SIM_H, window.innerHeight - headerH - pad * 2);
  const maxW = Math.min(MAX_SIM_W, window.innerWidth - sideW);
  let h = maxH;
  let portraitW = Math.floor(h * vw / vh);
  if (portraitW > maxW) {
    portraitW = maxW;
    h = Math.floor(portraitW * vh / vw);
  }
  portraitW = Math.max(320, Math.min(portraitW, MAX_SIM_W));
  h = Math.max(240, Math.min(h, MAX_SIM_H));
  return { w: portraitW, h };
}

/** Fixed seed profile for the Spots sim band. */
function getPresetSeedProfile() {
  return { warmup: 2 };
}

class PlaySimulation {
  constructor(canvas, video, camCanvas, layout) {
    this.canvas = canvas;
    this.video = video;
    this.camCanvas = camCanvas;
    this.camCtx = camCanvas.getContext('2d');
    this.layout = layout || null;

    const { w, h } = computeSimSize(video, layout);
    this.simW = w;
    this.simH = h;
    this.whRcp = [1 / w, 1 / h];
    canvas.width = w;
    canvas.height = h;
    this.applyCanvasLayout();

    this.gl = BlomWebGL.createWebGL2Context(canvas);
    if (!this.gl) throw new Error('WebGL2 required');

    const gl = this.gl;
    this.fmt = BlomWebGL.chooseTextureFormat(gl);
    this.halfUploadRef = { buf: null };

    this.pass = 0;

    this.progCopy = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, COPY_FRAG);
    this.progStamp = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, STAMP_FRAG);
    this.progLogoSeed = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, LOGO_SEED_FRAG);
    this.progSeed = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, SEED_FRAG);
    this.progGrayScott = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, GRAYSCOTT_MOTION_FRAG);
    this.progRender = BlomWebGL.createProgram(gl, BlomWebGL.VERT_SRC, RENDER_VIBRANT_FRAG);

    this.uCopy = BlomWebGL.cacheUniforms(gl, this.progCopy, ['tex']);
    this.uStamp = BlomWebGL.cacheUniforms(gl, this.progStamp, ['tex', 'center', 'radius', 'texSize']);
    this.uLogoSeed = BlomWebGL.cacheUniforms(gl, this.progLogoSeed, ['tex', 'logoMask']);
    this.uSeed = BlomWebGL.cacheUniforms(gl, this.progSeed, ['texSize', 'seedPhase', 'seedDensity', 'gridCols']);
    this.uGS = BlomWebGL.cacheUniforms(gl, this.progGrayScott, [
      'tex', 'kf_map', 'dA_map', 'faceMask', 'logoMask', 'dA', 'dA_low',
      'feed_lo', 'kill_lo', 'feed_hi', 'kill_hi',
      't_low', 't_high', 'k_off_low', 'k_off_high',
      'reverseK', 'reverseD', 'intensity', 'intensity_ref', 'kf_lo', 'kf_hi', 'cam_mode',
      'faceOnlyActive', 'logo_feed', 'logo_kill',
      'dt', 'drift_x', 'drift_y', 'motion_force', 'wh_rcp'
    ]);
    this.uRender = BlomWebGL.cacheUniforms(gl, this.progRender, ['tex', 'faceMask', 'faceHighlight']);

    this.vao = BlomWebGL.setupQuadVAO(gl, [
      this.progCopy, this.progStamp, this.progLogoSeed, this.progSeed, this.progGrayScott, this.progRender
    ]);

    this.logoMaskCanvas = document.createElement('canvas');
    this.logoMaskCtx = this.logoMaskCanvas.getContext('2d');
    this.logoMaskReady = false;

    this.faceMaskCanvas = document.createElement('canvas');
    this.faceMaskCtx = this.faceMaskCanvas.getContext('2d');
    this.faceTrack = true;
    this.faceTracker = null;
    this.faceEllipse = null;
    this.onFrame = null;

    this.initTextures();
    this.initParams();
    this.initDAMap();
    this.updateFaceMask();

    this.running = false;
    this.lastFrameTime = 0;
    this.frameCount = 0;

    this.gl.bindVertexArray(this.vao);
  }

  applyCanvasLayout() {
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.maxWidth = 'none';
    this.canvas.style.display = 'block';
    this.canvas.style.objectFit = 'contain';
  }

  /** Same radius as an unmodified mouse click. */
  defaultSeedRadius() {
    return Math.max(6, Math.min(this.simW, this.simH) * 0.022);
  }

  /** Map screen coordinates to sim pixel space (top-left origin, matches stamp shader). */
  clientToSim(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { x: nx * this.simW, y: ny * this.simH };
  }

  /** Stamp a u=1,v=1 seed dot at sim coordinates (matches SEED_FRAG). */
  stampSeedAt(sx, sy, radius) {
    const gl = this.gl;
    const r = radius != null ? radius : this.defaultSeedRadius();
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dstFbo);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.useProgram(this.progStamp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.uStamp.tex, 0);
    gl.uniform2f(this.uStamp.center, sx, sy);
    gl.uniform2f(this.uStamp.radius, r, r);
    gl.uniform2f(this.uStamp.texSize, this.simW, this.simH);
    this.drawQuad();
    this.swap();
  }

  seedAt(sx, sy) {
    this.stampSeedAt(sx, sy);
  }

  /** Full-frame click-sized stamp grid (S key). */
  seedFullScreen() {
    this.initNeutralField();
    this.seedStampGrid();
    this.seedFaceRegion();
    this.stampLogoSeed();
  }

  /**
   * Startup seeding — same stamp pass as a mouse click, spaced across the frame.
   * Dot size matches click; spacing ~3.8× radius (slightly denser for even coverage).
   */
  seedStampGrid(opts) {
    opts = opts || {};
    const r = opts.radius != null ? opts.radius : this.defaultSeedRadius();
    const spacing = r * (opts.spacingMult != null ? opts.spacingMult : 3.8);
    const cols = Math.max(2, Math.floor(this.simW / spacing) + 1);
    const rows = Math.max(2, Math.floor(this.simH / spacing) + 1);
    const spanX = Math.max(0, (cols - 1) * spacing);
    const spanY = Math.max(0, (rows - 1) * spacing);
    const x0 = (this.simW - spanX) * 0.5;
    const y0 = (this.simH - spanY) * 0.5;

    this.gl.bindVertexArray(this.vao);
    for (let row = 0; row < rows; row++) {
      const rowOff = (row % 2) * spacing * 0.5;
      for (let col = 0; col < cols; col++) {
        let sx = x0 + col * spacing + rowOff;
        if (sx > this.simW - r * 0.5) sx = x0 + col * spacing;
        const sy = y0 + row * spacing;
        this.stampSeedAt(sx, sy, r);
      }
    }
  }

  /** Extra seed dots on the tracked face oval — click-sized, eyes included. */
  seedFaceRegion() {
    const e = this.faceEllipse;
    if (!e) return;
    const r = this.defaultSeedRadius();
    this.stampSeedAt(e.cx, e.cy, r);
    this.stampSeedAt(e.cx - e.rx * 0.34, e.cy - e.ry * 0.22, r);
    this.stampSeedAt(e.cx + e.rx * 0.34, e.cy - e.ry * 0.22, r);
    this.stampSeedAt(e.cx, e.cy - e.ry * 0.18, r * 0.95);
    this.stampSeedAt(e.cx, e.cy + e.ry * 0.12, r * 0.95);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.stampSeedAt(
        e.cx + Math.cos(a) * e.rx * 0.42,
        e.cy + Math.sin(a) * e.ry * 0.38,
        r
      );
    }
  }

  initParams() {
    this.params = {};
    this.applySimFK();
    this.activePreset = DEFAULT_CAM_PRESET;
    this.applyCamPreset(DEFAULT_CAM_PRESET);
    this.params.dA = 0.27;
    this.params.dA_low = 0.2;
    this.params.camZoom = 1.4;
    this.params.camCenterX = 0.5;
    this.params.camCenterY = 0.48;
    this.params.camFrameShiftY = 0.028;
    this.params.faceHighlight = 0.45;
    this.params.intensity = 0.35;
    this.params.intensity_ref = 0.35;
    this.params.kf_lo_base = 0.04;
    this.params.kf_hi_base = 0.72;
    this.params.faceOnly = 1.0;
    this.params.faceOnlyActive = 1.0;
    this.params.motion_force = 5.0;
    this.params.drift_x = 0.0;
    this.params.drift_y = 0.0;
    this.params.reverseK = 0.0;
    this.params.reverseD = 0.0;
    this.params.logo_feed = LOGO_FK[0];
    this.params.logo_kill = LOGO_FK[1];
    this.params.pattern_range = 0.15;
    this.applyPatternRange();
  }

  /** Fixed Spots F/k band — unchanged when switching camera presets. */
  applySimFK() {
    this.params.t_low = SIM_FK.t_low;
    this.params.t_high = SIM_FK.t_high;
    this.params.k_off_low = SIM_FK.k_off_low;
    this.params.k_off_high = SIM_FK.k_off_high;
    const corners = simFKCorners();
    this.params.feed_lo = corners.feed_lo;
    this.params.kill_lo = corners.kill_lo;
    this.params.feed_hi = corners.feed_hi;
    this.params.kill_hi = corners.kill_hi;
  }

  applyCamPreset(index) {
    const preset = CAM_PRESETS[index];
    if (!preset) return;
    this.activePreset = index;
    this.params.cam_mode = preset.mode;
  }

  /** Bottom-left logo rect in sim pixel space (top-left origin). */
  getLogoPlacement() {
    const w = this.simW;
    const h = this.simH;
    const margin = Math.max(8, Math.min(w, h) * 0.025);
    const lw = w * 0.28;
    const lh = lw * (LOGO_SVG_H / LOGO_SVG_W);
    return { x: margin, y: h - lh - margin, w: lw, h: lh };
  }

  async loadLogoMask() {
    const svgW = LOGO_SVG_W;
    const svgH = LOGO_SVG_H;
    const img = new Image();

    try {
      const resp = await fetch(LOGO_MASK_URL);
      if (!resp.ok) throw new Error('fetch failed');
      let svgText = await resp.text();
      if (!/width="\d+px"/.test(svgText) && !/width="\d+"[^p]/.test(svgText)) {
        svgText = svgText.replace('<svg ', '<svg width="750" height="184" ');
      }
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      img.src = url;
      if (img.decode) {
        await img.decode();
      } else {
        await new Promise(function (resolve, reject) {
          img.onload = resolve;
          img.onerror = reject;
        });
      }
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('[Blom Play] Logo mask fetch failed, trying direct load.', err);
      img.src = LOGO_MASK_URL;
      if (img.decode) {
        await img.decode();
      } else {
        await new Promise(function (resolve, reject) {
          img.onload = resolve;
          img.onerror = function () { reject(new Error('Logo mask failed to load: ' + LOGO_MASK_URL)); };
        });
      }
    }

    const src = document.createElement('canvas');
    src.width = svgW;
    src.height = svgH;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, svgW, svgH);
    sctx.drawImage(img, 0, 0, svgW, svgH);

    const w = this.simW;
    const h = this.simH;
    this.logoMaskCanvas.width = w;
    this.logoMaskCanvas.height = h;
    const ctx = this.logoMaskCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const place = this.getLogoPlacement();
    ctx.drawImage(src, place.x, place.y, place.w, place.h);

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const lum = Math.max(data[i], data[i + 1], data[i + 2]);
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
      data[i + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);

    if (!this.logoMaskTex) {
      this.logoMaskTex = BlomWebGL.createByteTexture(this.gl, w, h);
    }
    BlomWebGL.uploadByteTex(this.gl, this.logoMaskTex, w, h, this.logoMaskCanvas);
    this.logoMaskReady = true;
  }

  /** Seed logo letters with the same stamp pass as a mouse click. */
  stampLogoSeed() {
    if (!this.logoMaskReady) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    const r = this.defaultSeedRadius();
    const place = this.getLogoPlacement();

    for (const pt of LOGO_SEED_POINTS) {
      this.stampSeedAt(place.x + pt[0] * place.w, place.y + pt[1] * place.h, r);
    }

    const w = this.simW;
    const h = this.simH;
    const img = this.logoMaskCtx.getImageData(0, 0, w, h).data;
    const step = Math.max(2, Math.floor(r * 1.4));
    for (let py = 0; py < h; py += step) {
      for (let px = 0; px < w; px += step) {
        const i = (py * w + px) * 4;
        if (img[i] > 18) {
          this.stampSeedAt(px + 0.5, py + 0.5, r * 0.8);
        }
      }
    }
  }

  applyPreset(index) {
    this.applyCamPreset(index);
  }

  /** Switch camera-input preset — recalibrate only, keep running patterns. */
  switchPreset(index) {
    if (index === this.activePreset) return null;
    this.applyCamPreset(index);
    this.updateKFMap();
    const cal = this.calibrate();
    this.renderToScreen();
    return cal;
  }

  /** Refresh KF map and calibrate for the active preset (face + full-frame percentiles). */
  autocalibrate() {
    if (this.video.readyState < 2) return null;
    return this.calibrate();
  }

  getPresetSeedProfile() {
    return getPresetSeedProfile();
  }

  /**
   * Calibrate camera mapping, then seed and warm up so patterns nucleate on current F/k.
   * @param {{ skipCalibrate?: boolean }} opts
   */
  reseedForPreset(opts) {
    opts = opts || {};
    let cal = null;
    if (!opts.skipCalibrate && this.video.readyState >= 2) {
      if (this.faceTracker) {
        this.faceTracker.update();
        this.applyFaceFrame(this.faceTracker.smooth);
      }
      cal = this.calibrate();
    }

    this.updateKFMap();
    if (this.faceTracker) {
      this.faceTracker.update();
      this.applyFaceFrame(this.faceTracker.smooth);
    }

    this.seedSimulation();
    this.seedFaceRegion();
    this.stampLogoSeed();
    if (!this.faceEllipse) this._needFaceSeed = true;

    const profile = this.getPresetSeedProfile();
    this.warmStart(profile.warmup);
    return cal;
  }

  /** Collect camera signal samples for calibration (face-biased when tracked). */
  collectCalSamples(data, w, h, mode) {
    const lumaSamples = [];
    const step = Math.max(1, Math.floor((w * h) / 8192));
    const e = this.faceEllipse;

    for (let i = 0; i < data.length; i += step * 4) {
      const px = (i >> 2) % w;
      const py = (i >> 2) / w | 0;
      if (e) {
        const dx = (px + 0.5 - e.cx) / e.rx;
        const dy = (py + 0.5 - e.cy) / e.ry;
        if (dx * dx + dy * dy > 1.08) continue;
      }
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      lumaSamples.push(sampleCamSignal(r, g, b, mode));
    }

    if (e && lumaSamples.length < 48) {
      lumaSamples.length = 0;
      for (let i = 0; i < data.length; i += step * 4) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        lumaSamples.push(sampleCamSignal(r, g, b, mode));
      }
    }
    return lumaSamples;
  }

  /** Wait for decoded camera frames with usable luma (avoids calibrate-on-black). */
  waitForCameraReady(maxAttempts) {
    maxAttempts = maxAttempts || 40;
    const self = this;
    return new Promise(function (resolve) {
      let attempts = 0;

      function schedule(fn) {
        if ('requestVideoFrameCallback' in self.video) {
          self.video.requestVideoFrameCallback(fn);
        } else {
          requestAnimationFrame(fn);
        }
      }

      function tick() {
        const v = self.video;
        if (v.readyState < 2) {
          if (++attempts >= maxAttempts) { resolve(false); return; }
          schedule(tick);
          return;
        }

        self.updateKFMap();
        const data = self.camCtx.getImageData(0, 0, self.simW, self.simH).data;
        let sum = 0;
        let count = 0;
        let minL = 2;
        let maxL = 0;
        const step = 4 * Math.max(1, Math.floor((self.simW * self.simH) / 4096));
        for (let i = 0; i < data.length; i += step) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const l = sampleCamSignal(r, g, b, self.params.cam_mode);
          sum += l;
          count++;
          minL = Math.min(minL, l);
          maxL = Math.max(maxL, l);
        }
        const avg = sum / Math.max(1, count);
        const spread = maxL - minL;

        if (spread >= MIN_CALIB_SPAN && avg >= 0.04) {
          resolve(true);
          return;
        }
        if (++attempts >= maxAttempts) {
          resolve(spread >= MIN_CALIB_SPAN * 0.5);
          return;
        }
        schedule(tick);
      }

      tick();
    });
  }

  setDA(value) {
    this.params.dA = Math.max(0.2, Math.min(1.15, value));
  }

  setCamZoom(value) {
    this.params.camZoom = Math.max(1.0, Math.min(4.0, value));
  }

  setDetail(value) {
    this.params.intensity = Math.max(0.2, Math.min(1.5, value));
  }

  setPatternRange(value) {
    this.params.pattern_range = Math.max(-1.0, Math.min(1.0, value));
    this.applyPatternRange();
  }

  /**
   * Pattern-range adjusts raw camera-luma window ends (kf_lo/kf_hi in raw space).
   * Intensity scales contrast around the window midpoint in the shader.
   */
  applyPatternRange() {
    const loBase = this.params.kf_lo_base;
    const hiBase = this.params.kf_hi_base;
    const t = this.params.pattern_range;
    const minSpan = 0.02;
    const span = Math.max(minSpan, hiBase - loBase);
    let loRaw;
    let hiRaw;

    if (t <= 0) {
      loRaw = loBase;
      hiRaw = loBase + Math.max(minSpan, span * (1.0 + t));
    } else {
      hiRaw = hiBase;
      loRaw = hiBase - Math.max(minSpan, span * (1.0 - t));
    }

    this.params.kf_lo = loRaw;
    this.params.kf_hi = hiRaw;
  }

  setFaceOnly(enabled) {
    this.params.faceOnly = enabled ? 1.0 : 0.0;
    this.updateFaceOnlyActive();
  }

  updateFaceOnlyActive() {
    const wantFaceOnly = this.params.faceOnly > 0.5;
    const hasFace = !!(this.faceEllipse && this.faceTracker && this.faceTracker.detected);
    this.params.faceOnlyActive = (wantFaceOnly && hasFace) ? 1.0 : 0.0;
  }

  getFaceOnly() {
    return this.params.faceOnly > 0.5;
  }

  setFaceTracker(tracker) {
    this.faceTracker = tracker;
  }

  getFaceEllipse() {
    return this.faceEllipse;
  }

  computeFaceEllipseSim(face) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || !face) return null;

    const zoom = this.params.camZoom;
    const srcW = vw / zoom;
    const srcH = vh / zoom;
    const cx = this.params.camCenterX * vw;
    const cy = this.params.camCenterY * vh;
    const srcX = Math.max(0, Math.min(vw - srcW, cx - srcW * 0.5));
    const srcY = Math.max(0, Math.min(vh - srcH, cy - srcH * 0.5));

    const fx0 = (face.cx - face.w * 0.5) * vw;
    const fy0 = (face.cy - face.h * 0.5) * vh;
    const fx1 = (face.cx + face.w * 0.5) * vw;
    const fy1 = (face.cy + face.h * 0.5) * vh;

    const toSim = (vx, vy) => ({
      x: (1 - (vx - srcX) / srcW) * this.simW,
      y: ((vy - srcY) / srcH) * this.simH
    });

    const tl = toSim(fx0, fy0);
    const br = toSim(fx1, fy1);
    const rawRx = Math.abs(br.x - tl.x) * 0.5;
    const rawRy = Math.abs(br.y - tl.y) * 0.5;
    return {
      cx: (tl.x + br.x) * 0.5,
      cy: (tl.y + br.y) * 0.5 + rawRy * 0.06,
      rx: Math.max(8, rawRx * 0.96),
      ry: Math.max(8, rawRy * 1.22)
    };
  }

  applyFaceFrame(face) {
    if (this.faceTrack && face && face.confidence > 0.25) {
      this.params.camCenterX = lerp(this.params.camCenterX, face.cx, 0.12);
      const shiftY = this.params.camFrameShiftY != null ? this.params.camFrameShiftY : 0.028;
      this.params.camCenterY = lerp(this.params.camCenterY, face.cy + shiftY, 0.12);
      this.faceEllipse = this.computeFaceEllipseSim(face);
    } else {
      this.faceEllipse = null;
    }
    this.updateFaceOnlyActive();
    this.updateFaceMask();
  }

  updateFaceMask() {
    if (!this.faceMaskCanvas || !this.faceMaskTex) return;
    const w = this.simW;
    const h = this.simH;
    this.faceMaskCanvas.width = w;
    this.faceMaskCanvas.height = h;
    const ctx = this.faceMaskCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const e = this.faceEllipse;
    if (e) {
      const img = ctx.createImageData(w, h);
      const data = img.data;
      const cx = e.cx;
      const cy = e.cy;
      const rx = e.rx;
      const ry = e.ry;
      const inner = 0.58;
      const outer = 1.08;
      const x0 = Math.max(0, Math.floor(cx - rx * outer));
      const x1 = Math.min(w, Math.ceil(cx + rx * outer));
      const y0 = Math.max(0, Math.floor(cy - ry * outer));
      const y1 = Math.min(h, Math.ceil(cy + ry * outer));

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const r = Math.sqrt(dx * dx + dy * dy);
          let a;
          if (r <= inner) {
            a = 1.0;
          } else if (r >= outer) {
            a = 0.0;
          } else {
            const t = (r - inner) / (outer - inner);
            a = 1.0 - t * t * (3.0 - 2.0 * t);
          }
          const i = (y * w + x) * 4;
          const v = Math.round(a * 255);
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    BlomWebGL.uploadByteTex(this.gl, this.faceMaskTex, w, h, this.faceMaskCanvas);
  }

  initTextures() {
    const gl = this.gl;
    const { simW: w, simH: h } = this;

    this.texA = BlomWebGL.createFloatTexture(gl, w, h, this.fmt);
    this.texB = BlomWebGL.createFloatTexture(gl, w, h, this.fmt);
    this.fboA = BlomWebGL.createFBO(gl, this.texA);
    this.fboB = BlomWebGL.createFBO(gl, this.texB);
    this.srcTex = this.texA;
    this.dstTex = this.texB;
    this.srcFbo = this.fboA;
    this.dstFbo = this.fboB;

    this.kfTex = BlomWebGL.createByteTexture(gl, w, h);
    this.kfPrevTex = BlomWebGL.createByteTexture(gl, w, h);
    this.kfFbo = BlomWebGL.createFBO(gl, this.kfTex);
    this.kfPrevFbo = BlomWebGL.createFBO(gl, this.kfPrevTex);

    this.dATex = BlomWebGL.createFloatTexture(gl, w, h, this.fmt);
    this.dAFbo = BlomWebGL.createFBO(gl, this.dATex);
    this.dATempTex = BlomWebGL.createFloatTexture(gl, w, h, this.fmt);
    this.dATempFbo = BlomWebGL.createFBO(gl, this.dATempTex);
    this.faceMaskTex = BlomWebGL.createByteTexture(gl, w, h);
    this.logoMaskTex = null;

    this.seedBuffer = new Float32Array(w * h * 4);
    this.dABuffer = new Float32Array(w * h * 4);
  }

  drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  swap() {
    [this.srcTex, this.dstTex] = [this.dstTex, this.srcTex];
    [this.srcFbo, this.dstFbo] = [this.dstFbo, this.srcFbo];
  }

  blitTexture(srcTex, dstFbo) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.useProgram(this.progCopy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uCopy.tex, 0);
    this.drawQuad();
  }

  primeSimulation() {
    for (let i = 0; i < PRIME_PASSES; i++) this.runSimulation();
    this.renderToScreen();
  }

  warmStart(passes) {
    const n = passes != null ? passes : this.getPresetSeedProfile().warmup;
    for (let i = 0; i < n; i++) this.runSimulation();
  }

  runSeedPass(viewport, texSize, phase, profile) {
    const gl = this.gl;
    gl.viewport(viewport.x, viewport.y, viewport.w, viewport.h);
    gl.uniform2f(this.uSeed.texSize, texSize.w, texSize.h);
    gl.uniform1f(this.uSeed.seedPhase, phase);
    gl.uniform1f(this.uSeed.seedDensity, profile.density);
    gl.uniform1f(this.uSeed.gridCols, profile.gridCols);
    this.drawQuad();
  }

  initNeutralField() {
    const gl = this.gl;
    const neutral = this.seedBuffer;
    neutral.fill(0);
    for (let i = 0; i < this.simW * this.simH; i++) {
      neutral[i * 4] = 1.0;
      neutral[i * 4 + 3] = 1.0;
    }
    BlomWebGL.uploadFloatTex(gl, this.texA, this.simW, this.simH, neutral, this.fmt, this.halfUploadRef);
    BlomWebGL.uploadFloatTex(gl, this.texB, this.simW, this.simH, neutral, this.fmt, this.halfUploadRef);
    this.srcTex = this.texA;
    this.dstTex = this.texB;
    this.srcFbo = this.fboA;
    this.dstFbo = this.fboB;
    this.pass = 0;
  }

  seedSimulation() {
    this.initNeutralField();
    this.seedStampGrid();
  }

  seedReset() {
    this.seedSimulation();
  }

  initDAMap() {
    const data = this.dABuffer;
    data.fill(0);
    for (let i = 0; i < this.simW * this.simH; i++) {
      data[i * 4 + 3] = 1.0;
    }
    BlomWebGL.uploadFloatTex(this.gl, this.dATex, this.simW, this.simH, data, this.fmt, this.halfUploadRef);
  }

  reset() {
    this.gl.bindVertexArray(this.vao);
    this.initDAMap();
    this.reseedForPreset();
    this.renderToScreen();
  }

  updateKFMap() {
    if (this.video.readyState < 2) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    this.blitTexture(this.kfTex, this.kfPrevFbo);

    this.camCanvas.width = this.simW;
    this.camCanvas.height = this.simH;
    this.camCtx.save();
    this.camCtx.scale(-1, 1);

    const zoom = this.params.camZoom;
    const srcW = vw / zoom;
    const srcH = vh / zoom;
    const cx = this.params.camCenterX * vw;
    const cy = this.params.camCenterY * vh;
    const srcX = Math.max(0, Math.min(vw - srcW, cx - srcW * 0.5));
    const srcY = Math.max(0, Math.min(vh - srcH, cy - srcH * 0.5));
    this.camCtx.drawImage(
      this.video,
      srcX, srcY, srcW, srcH,
      -this.simW, 0, this.simW, this.simH
    );
    this.camCtx.restore();

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.kfTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      0, 0,
      this.simW, this.simH,
      gl.RGBA, gl.UNSIGNED_BYTE, this.camCanvas
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * Calibrate brightness window for the active camera-input mode.
   * Always produces a usable window; blends with prior cal for stability.
   */
  calibrate() {
    if (this.video.readyState < 2) return null;

    if (this.faceTracker) {
      this.faceTracker.update();
      this.applyFaceFrame(this.faceTracker.smooth);
    }

    this.updateKFMap();

    const preset = CAM_PRESETS[this.activePreset] || CAM_PRESETS[DEFAULT_CAM_PRESET];
    const mode = this.params.cam_mode;
    const w = this.simW;
    const h = this.simH;
    const img = this.camCtx.getImageData(0, 0, w, h);
    const data = img.data;
    const lumaSamples = this.collectCalSamples(data, w, h, mode);

    if (lumaSamples.length < 32) return null;

    const pct = (arr, p) => {
      arr.sort((a, b) => a - b);
      return arr[Math.floor(arr.length * p)];
    };

    let lo = pct(lumaSamples.slice(), preset.cal_lo);
    let hi = pct(lumaSamples.slice(), preset.cal_hi);
    let span = hi - lo;
    const minSpan = 0.06;

    if (span < minSpan) {
      lo = pct(lumaSamples.slice(), 0.04);
      hi = pct(lumaSamples.slice(), 0.96);
      span = hi - lo;
    }
    if (span < minSpan) {
      const mid = (lo + hi) * 0.5;
      lo = mid - minSpan * 0.5;
      hi = mid + minSpan * 0.5;
      span = minSpan;
    }

    const pad = Math.max(0.012, span * 0.12);
    const newLo = Math.max(0.0, lo - pad);
    const newHi = Math.min(2.5, hi + pad);
    const prevLo = this.params.kf_lo_base;
    const prevHi = this.params.kf_hi_base;
    const hasPrev = prevHi > prevLo + MIN_CALIB_SPAN;

    if (hasPrev) {
      this.params.kf_lo_base = lerp(prevLo, newLo, CALIB_BLEND);
      this.params.kf_hi_base = lerp(prevHi, newHi, CALIB_BLEND);
    } else {
      this.params.kf_lo_base = newLo;
      this.params.kf_hi_base = newHi;
    }
    this.applyPatternRange();
    this.params.intensity_ref = this.params.intensity;

    return {
      kf_lo: this.params.kf_lo,
      kf_hi: this.params.kf_hi,
      kf_lo_base: this.params.kf_lo_base,
      kf_hi_base: this.params.kf_hi_base,
      samples: lumaSamples.length,
      intensity: this.params.intensity
    };
  }

  runSimulation() {
    const gl = this.gl;
    const p = this.params;
    const u = this.uGS;

    gl.useProgram(this.progGrayScott);
    gl.uniform1f(u.dA, p.dA);
    gl.uniform1f(u.dA_low, p.dA_low);
    gl.uniform1f(u.feed_lo, p.feed_lo);
    gl.uniform1f(u.kill_lo, p.kill_lo);
    gl.uniform1f(u.feed_hi, p.feed_hi);
    gl.uniform1f(u.kill_hi, p.kill_hi);
    gl.uniform1f(u.t_low, p.t_low);
    gl.uniform1f(u.t_high, p.t_high);
    gl.uniform1f(u.k_off_low, p.k_off_low);
    gl.uniform1f(u.k_off_high, p.k_off_high);
    gl.uniform1f(u.reverseK, p.reverseK);
    gl.uniform1f(u.reverseD, p.reverseD);
    gl.uniform1f(u.intensity, p.intensity);
    gl.uniform1f(u.intensity_ref, p.intensity_ref);
    gl.uniform1f(u.kf_lo, p.kf_lo);
    gl.uniform1f(u.kf_hi, p.kf_hi);
    gl.uniform1f(u.cam_mode, p.cam_mode);
    gl.uniform1f(u.faceOnlyActive, p.faceOnlyActive);
    gl.uniform1f(u.logo_feed, p.logo_feed);
    gl.uniform1f(u.logo_kill, p.logo_kill);
    gl.uniform1f(u.dt, 1.0);
    gl.uniform1f(u.drift_x, p.drift_x);
    gl.uniform1f(u.drift_y, p.drift_y);
    gl.uniform1f(u.motion_force, p.motion_force);
    gl.uniform2f(u.wh_rcp, this.whRcp[0], this.whRcp[1]);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.kfTex);
    gl.uniform1i(u.kf_map, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.dATex);
    gl.uniform1i(u.dA_map, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.faceMaskTex);
    gl.uniform1i(u.faceMask, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.logoMaskReady ? this.logoMaskTex : this.faceMaskTex);
    gl.uniform1i(u.logoMask, 4);

    gl.viewport(0, 0, this.simW, this.simH);
    for (let i = 0; i < PASSES; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.dstFbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.uniform1i(u.tex, 0);
      this.drawQuad();
      this.swap();
      this.pass++;
    }
  }

  /** PNG data URL of the current frame (call while live). */
  captureFrame() {
    this.renderToScreen();
    return this.canvas.toDataURL('image/png');
  }

  renderToScreen() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(1, 0.98, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progRender);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.uRender.tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.faceMaskTex);
    gl.uniform1i(this.uRender.faceMask, 1);
    gl.uniform1f(this.uRender.faceHighlight, this.params.faceHighlight);
    this.drawQuad();
  }

  async start() {
    this.running = true;
    this.lastFrameTime = 0;
    this.frameCount = 0;
    this._needFaceSeed = false;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    await this.waitForCameraReady();
    const cal = this.reseedForPreset();
    this.renderToScreen();
    requestAnimationFrame(t => this.loop(t));
    return cal;
  }

  stop() {
    this.running = false;
  }

  loop(now) {
    if (!this.running) return;

    if (TARGET_FPS > 0) {
      const frameInterval = 1000 / TARGET_FPS;
      if (this.lastFrameTime && now - this.lastFrameTime < frameInterval) {
        requestAnimationFrame(t => this.loop(t));
        return;
      }
    }
    this.lastFrameTime = now;
    this.frameCount++;

    this.gl.bindVertexArray(this.vao);
    if (this.faceTracker) {
      const face = this.faceTracker.update();
      this.applyFaceFrame(face);
    }
    if (this._needFaceSeed && this.faceEllipse) {
      this.seedFaceRegion();
      this._needFaceSeed = false;
    }
    this.updateKFMap();
    this.runSimulation();
    this.renderToScreen();
    if (this.onFrame) this.onFrame();

    const fpsEl = document.getElementById('play-status');
    if (fpsEl && this.frameCount % 20 === 0) {
      const fps = Math.round(1000 / (now - (this._lastFpsTime || now - 16)));
      this._lastFpsTime = now;
      fpsEl.textContent = 'Live — ' + this.simW + '×' + this.simH + ' · ' + fps + ' fps · ' +
        CAM_PRESETS[this.activePreset].name;
    }

    requestAnimationFrame(t => this.loop(t));
  }
}

window.PlaySimulation = PlaySimulation;
window.CAM_PRESETS = CAM_PRESETS;
window.KF_PRESETS = CAM_PRESETS;
window.sampleCamSignal = sampleCamSignal;
window.crescentFK = crescentFK;
window.RENDER_VIBRANT_FRAG = RENDER_VIBRANT_FRAG;
window.SEED_FRAG = SEED_FRAG;
window.COPY_FRAG = COPY_FRAG;
window.getPresetSeedProfile = getPresetSeedProfile;
