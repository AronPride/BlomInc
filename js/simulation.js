/**
 * BLOM website: Gray-Scott reaction diffusion (WebGL2, optimized)
 */

const SIM_W = 1200;
const SIM_H = 400;
const FEED_MAX = 0.12;
const KILL_MAX = 0.08;
const GRADIENT_MODE = 4;
const PASSES = 25;
const SINE_SPEED = 0.72;
const TARGET_FPS = 45;

const VERT_SRC = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Stripped: no FBM noise path (dA_noise_amp is always 0)
const GRAYSCOTT_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 wh_rcp;
uniform sampler2D tex;
uniform sampler2D kf_map;
uniform float dA;
uniform float dB;
uniform float dt;
uniform vec2 txt_fk_top;
uniform vec2 txt_fk_bot;
uniform vec2 txt_y_range;
uniform vec2 txt_x_range;
uniform float gradient_mode;
const float FEED_MAX = 0.12;
const float KILL_MAX = 0.08;

void main() {
  vec2 posn = v_uv;
  vec4 val = texture(tex, posn);
  vec4 kf_val = texture(kf_map, posn);
  float new_feed, new_kill;
  float dir = mod(gradient_mode, 3.0);
  float t;
  if (dir < 0.5) {
    t = clamp((posn.y - txt_y_range.x) / (txt_y_range.y - txt_y_range.x), 0.0, 1.0);
  } else if (dir < 1.5) {
    t = clamp((posn.x - txt_x_range.x) / (txt_x_range.y - txt_x_range.x), 0.0, 1.0);
  } else {
    t = clamp(length(posn - vec2(0.5)) / 0.5, 0.0, 1.0);
  }
  vec2 fk_grad = mix(txt_fk_top, txt_fk_bot, t);
  float fg_feed = kf_val.r * FEED_MAX;
  float fg_kill = kf_val.g * KILL_MAX;
  bool gradient_in_foreground = (gradient_mode < 2.5);
  if (kf_val.b > 0.5) {
    if (gradient_in_foreground) { new_feed = fk_grad.x; new_kill = fk_grad.y; }
    else { new_feed = fg_feed; new_kill = fg_kill; }
  } else {
    if (gradient_in_foreground) { new_feed = fg_feed; new_kill = fg_kill; }
    else { new_feed = fk_grad.x; new_kill = fk_grad.y; }
  }
  vec2 texel = wh_rcp;
  vec4 laplace = -val;
  laplace += texture(tex, posn + vec2(-texel.x, 0.0)) * 0.20;
  laplace += texture(tex, posn + vec2( texel.x, 0.0)) * 0.20;
  laplace += texture(tex, posn + vec2(0.0, -texel.y)) * 0.20;
  laplace += texture(tex, posn + vec2(0.0,  texel.y)) * 0.20;
  laplace += texture(tex, posn + vec2(-texel.x, -texel.y)) * 0.05;
  laplace += texture(tex, posn + vec2( texel.x, -texel.y)) * 0.05;
  laplace += texture(tex, posn + vec2(-texel.x,  texel.y)) * 0.05;
  laplace += texture(tex, posn + vec2( texel.x,  texel.y)) * 0.05;
  float nA = val.r + (dA * laplace.r - val.r * val.g * val.g + new_feed * (1.0 - val.r)) * dt;
  float nB = val.g + (dB * laplace.g + val.r * val.g * val.g - (new_kill + new_feed) * val.g) * dt;
  fragColor = vec4(clamp(vec2(nA, nB), vec2(0.0), vec2(1.0)), 0.0, 1.0);
}`;

const KF_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 sq_fk;
uniform sampler2D logoMask;
void main() {
  float mask = step(0.25, texture(logoMask, v_uv).r);
  fragColor = vec4(sq_fk, mask, 1.0);
}`;

const RENDER_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
const vec3 bgColor = vec3(1.0, 0.98, 1.0);
const vec3 fgColor = vec3(0.867, 0.376, 0.588);

void main() {
  vec2 val = texture(tex, v_uv).rg;
  float intensity = clamp(val.r - 1.65 * val.g, 0.0, 1.0);
  fragColor = vec4(mix(fgColor, bgColor, intensity), 1.0);
}`;

const STAMP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D tex;
uniform vec2 center;
uniform vec2 radius;
uniform vec2 texSize;
uniform vec4 stampColor;

void main() {
  vec4 val = texture(tex, v_uv);
  vec2 px = vec2(v_uv.x * texSize.x, (1.0 - v_uv.y) * texSize.y);
  vec2 d = (px - center) / radius;
  fragColor = (dot(d, d) <= 1.0) ? stampColor : val;
}`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh));
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog));
  }
  return prog;
}

function cacheUniforms(gl, prog, names) {
  const u = {};
  gl.useProgram(prog);
  for (const n of names) u[n] = gl.getUniformLocation(prog, n);
  return u;
}

function crescentFK(t, kOff) {
  const F = 0.006 + (0.100 - 0.006) * t;
  const k = -7.91 * F * F + 1.025 * F + 0.0325 + kOff;
  return [F, k];
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

class ReactionDiffusion {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', desynchronized: true
    });
    if (!this.gl) throw new Error('WebGL2 required');

    const gl = this.gl;
    this.useHalf = !!gl.getExtension('EXT_color_buffer_half_float');
    if (!gl.getExtension('EXT_color_buffer_float') && !this.useHalf) {
      console.warn('Float render targets may be unavailable on this GPU');
    }
    this.texInternal = this.useHalf ? gl.RGBA16F : gl.RGBA32F;
    this.texType = this.useHalf ? gl.HALF_FLOAT : gl.FLOAT;

    this.progGrayScott = createProgram(gl, VERT_SRC, GRAYSCOTT_FRAG);
    this.progKF = createProgram(gl, VERT_SRC, KF_FRAG);
    this.progRender = createProgram(gl, VERT_SRC, RENDER_FRAG);
    this.progStamp = createProgram(gl, VERT_SRC, STAMP_FRAG);

    this.uGS = cacheUniforms(gl, this.progGrayScott, [
      'tex', 'kf_map', 'dA', 'dB', 'dt', 'wh_rcp',
      'txt_fk_top', 'txt_fk_bot', 'txt_y_range', 'txt_x_range', 'gradient_mode'
    ]);
    this.uKF = cacheUniforms(gl, this.progKF, ['sq_fk', 'logoMask']);
    this.uRender = cacheUniforms(gl, this.progRender, ['tex']);
    this.uStamp = cacheUniforms(gl, this.progStamp, ['tex', 'center', 'radius', 'texSize', 'stampColor']);

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    for (const prog of [this.progGrayScott, this.progKF, this.progRender, this.progStamp]) {
      gl.useProgram(prog);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    this.texA = this.createSimTexture();
    this.texB = this.createSimTexture();
    this.fboA = this.createFBO(this.texA);
    this.fboB = this.createFBO(this.texB);
    this.srcTex = this.texA;
    this.dstTex = this.texB;
    this.srcFbo = this.fboA;
    this.dstFbo = this.fboB;

    this.kfTex = this.createSimTexture();
    this.kfFbo = this.createFBO(this.kfTex);
    this.logoMaskTex = this.createSimTexture();

    this.seedBuffer = new Float32Array(SIM_W * SIM_H * 4);
    this.whRcp = new Float32Array([1 / SIM_W, 1 / SIM_H]);

    this.params = {
      t_bg: 0.35, k_off_bg: 0,
      t_sq_out: 0.25, t_sq_in: 1.0, k_off_sq: 0.015,
      t_txt_top: 0.60, k_off_top: -0.002,
      t_txt_bot: 0.30, k_off_bot: 0,
      dA: 1.0
    };
    this.base = { ...this.params };
    this.sine = {};
    this.seedMode = 0;
    this.pointerDown = false;
    this.startTime = performance.now();
    this.lastFrameTime = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
    canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    canvas.addEventListener('pointerup', () => { this.pointerDown = false; });
    canvas.addEventListener('pointerleave', () => { this.pointerDown = false; });
    window.addEventListener('keydown', e => this.onKey(e));
  }

  createSimTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.texInternal, SIM_W, SIM_H, 0, gl.RGBA, this.texType, null);
    return tex;
  }

  createFBO(tex) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fbo;
  }

  uploadFloatTex(tex, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Client uploads must use FLOAT; HALF_FLOAT expects Uint16 data and corrupts seed values.
    gl.texImage2D(gl.TEXTURE_2D, 0, this.texInternal, SIM_W, SIM_H, 0, gl.RGBA, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  uploadLogoMask(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.logoMaskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SIM_W, SIM_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  drawQuad() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  swap() {
    [this.srcTex, this.dstTex] = [this.dstTex, this.srcTex];
    [this.srcFbo, this.dstFbo] = [this.dstFbo, this.srcFbo];
  }

  reseed() {
    this.seedMode = (this.seedMode + 1) % 10;
    this.seedSimulation(this.seedMode);
    this.updateKFMap();
  }

  async init() {
    await this.loadLogo('assets/blom-logo.png');
    this.initSineWaves();
    this.snapshotSineBases();
    this.updateSine(0);
    await delay(25);
    this.gl.bindVertexArray(this.vao);
    this.seedDefault();
    this.updateKFMap();
    this.startTime = performance.now();
    this.lastFrameTime = 0;
    requestAnimationFrame(t => this.loop(t));
  }

  async loadLogo(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = SIM_W;
    canvas.height = SIM_H;
    const ctx = canvas.getContext('2d');
    const imgW = img.width, imgH = img.height;
    let scale = Math.min(SIM_W / imgW, SIM_H / imgH);
    scale = Math.min(scale, 1.0);
    const drawnW = imgW * scale, drawnH = imgH * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIM_W, SIM_H);
    const logoLeft = (SIM_W - drawnW) / 2;
    const logoTop = (SIM_H - drawnH) / 2;
    ctx.drawImage(img, logoLeft, logoTop, drawnW, drawnH);
    this.logoMaskData = ctx.getImageData(0, 0, SIM_W, SIM_H).data;
    this.logoBounds = { left: logoLeft, top: logoTop, w: drawnW, h: drawnH };
    this.uploadLogoMask(canvas);
  }

  applyDefaultSeed(data) {
    const stampRect = (x0, y0, w, h) => {
      const xA = Math.max(0, Math.floor(x0));
      const yA = Math.max(0, Math.floor(y0));
      const xB = Math.min(SIM_W, Math.ceil(x0 + w));
      const yB = Math.min(SIM_H, Math.ceil(y0 + h));
      for (let y = yA; y < yB; y++) {
        for (let x = xA; x < xB; x++) {
          const i = (y * SIM_W + x) * 4;
          data[i] = 0;
          data[i + 1] = 1;
        }
      }
    };
    const stampDot = (cx, cy, r) => {
      const x0 = Math.max(0, Math.floor(cx - r));
      const x1 = Math.min(SIM_W, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(SIM_H, Math.ceil(cy + r));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          if (dx * dx + dy * dy > r * r) continue;
          const i = (y * SIM_W + x) * 4;
          data[i] = 0;
          data[i + 1] = 1;
        }
      }
    };

    const lineH = 12;
    stampRect(0, SIM_H * 0.5 - lineH * 0.5, SIM_W, lineH);

    const lb = this.logoBounds;
    if (!lb) return;
    const dotR = 7;
    const bX = lb.left + lb.w * 0.09;
    stampDot(bX, lb.top + lb.h * 0.32, dotR);
    stampDot(bX, lb.top + lb.h * 0.50, dotR);
    stampDot(bX, lb.top + lb.h * 0.68, dotR);

    const oY = lb.top + lb.h * 0.50;
    stampDot(lb.left + lb.w * 0.48, oY, dotR);
    stampDot(lb.left + lb.w * 0.52, oY, dotR);
    stampDot(lb.left + lb.w * 0.56, oY, dotR);
  }

  seedDefault() {
    const data = this.seedBuffer;
    data.fill(0);
    for (let i = 0; i < SIM_W * SIM_H; i++) {
      const j = i * 4;
      data[j] = 1.0;
      data[j + 3] = 1.0;
    }
    this.applyDefaultSeed(data);
    this.uploadFloatTex(this.srcTex, data);
    this.uploadFloatTex(this.dstTex, data);
  }

  resize() {
    this.dpr = 1;
    const aspect = SIM_W / SIM_H;
    let dispCssW = Math.min(SIM_W, window.innerWidth);
    let dispCssH = dispCssW / aspect;
    if (dispCssH > window.innerHeight) {
      dispCssH = Math.min(SIM_H, window.innerHeight);
      dispCssW = dispCssH * aspect;
    }
    this.canvas.width = Math.floor(dispCssW);
    this.canvas.height = Math.floor(dispCssH);
    this.canvas.style.width = dispCssW + 'px';
    this.canvas.style.height = dispCssH + 'px';
    this.displayRect = { ox: 0, oy: 0, dispW: this.canvas.width, dispH: this.canvas.height, w: this.canvas.width, h: this.canvas.height };
  }

  screenToSim(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const dr = this.displayRect;
    if (mx < 0 || mx > dr.dispW || my < 0 || my > dr.dispH) return null;
    return { x: mx / dr.dispW * SIM_W, y: my / dr.dispH * SIM_H };
  }

  initSineWaves() {
    const m = 1.0 / SINE_SPEED;
    // Fixed periods + phase offsets tuned for visible pattern at t=0 (matches original sketch)
    this.sine = {
      triPeriodTop: 90 * m,
      triPeriodBot: 70 * m,
      triPeriodSq: 110 * m,
      triPeriodBg: 130 * m,
      triOffsetTop: 28,
      triOffsetBot: 12,
      triOffsetSq: 42,
      triOffsetBg: 60,
      kFreqTop: 0.19, kFreqBot: 0.13, kFreqSq: 0.17, kFreqBg: 0.09,
      kPhaseTop: 2.5, kPhaseBot: 2.0, kPhaseSq: 1.0, kPhaseBg: 3.0,
      dAFreq: 0.14, dAPhase: 0.8
    };
  }

  snapshotSineBases() { this.base = { ...this.params }; }

  triangleWave(sec, period, offset) {
    const t = ((sec + offset) % period) / period;
    return 1.0 - Math.abs(2.0 * t - 1.0);
  }

  updateSine(sec) {
    const T_LO = 0.12, T_HI = 0.72;
    const s = this.sine, p = this.params;
    p.t_txt_top = lerp(T_LO, T_HI, this.triangleWave(sec, s.triPeriodTop, s.triOffsetTop));
    p.t_txt_bot = lerp(T_LO, T_HI, this.triangleWave(sec, s.triPeriodBot, s.triOffsetBot));
    p.t_sq_in = lerp(T_LO, T_HI, this.triangleWave(sec, s.triPeriodSq, s.triOffsetSq));
    p.t_bg = lerp(T_LO, T_HI, this.triangleWave(sec, s.triPeriodBg, s.triOffsetBg));
    p.k_off_top = Math.min(this.base.k_off_top + 0.003 * Math.sin(sec * s.kFreqTop + s.kPhaseTop), 0.015);
    p.k_off_bot = Math.min(this.base.k_off_bot + 0.003 * Math.sin(sec * s.kFreqBot + s.kPhaseBot), 0.015);
    p.k_off_sq = this.base.k_off_sq + 0.003 * Math.sin(sec * s.kFreqSq + s.kPhaseSq);
    p.k_off_bg = this.base.k_off_bg + 0.002 * Math.sin(sec * s.kFreqBg + s.kPhaseBg);
    p.dA = clamp(this.base.dA + 0.15 * Math.sin(sec * s.dAFreq + s.dAPhase), 0.3, 2.0);
  }

  updateKFMap() {
    const gl = this.gl;
    const sq = crescentFK(this.params.t_sq_out, this.params.k_off_sq);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.kfFbo);
    gl.viewport(0, 0, SIM_W, SIM_H);
    gl.useProgram(this.progKF);
    gl.uniform2f(this.uKF.sq_fk, sq[0] / FEED_MAX, sq[1] / KILL_MAX);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.logoMaskTex);
    gl.uniform1i(this.uKF.logoMask, 0);
    this.drawQuad();
  }

  seedSimulation(mode) {
    const data = this.seedBuffer;
    data.fill(0);
    for (let i = 0; i < SIM_W * SIM_H; i++) {
      const j = i * 4;
      data[j] = 1.0;
      data[j + 3] = 1.0;
    }
    const setSeedRect = (x0, y0, w, h) => {
      const x1 = Math.min(SIM_W, x0 + w), y1 = Math.min(SIM_H, y0 + h);
      for (let y = Math.max(0, y0); y < y1; y++) {
        for (let x = Math.max(0, x0); x < x1; x++) {
          const i = (y * SIM_W + x) * 4;
          data[i] = 0;
          data[i + 1] = 1;
        }
      }
    };
    switch (mode) {
      case 0: setSeedRect(0, 0, SIM_W, SIM_H); break;
      case 1: setSeedRect(0, 0, SIM_W, SIM_H / 2); break;
      case 2: setSeedRect(0, SIM_H / 2, SIM_W, SIM_H / 2); break;
      case 3: setSeedRect(0, SIM_H * 0.35, SIM_W, SIM_H * 0.3); break;
      case 4:
        const colW = SIM_W * 0.06;
        for (let c = 0; c < 4; c++) {
          const cx = SIM_W * (0.125 + c * 0.25);
          setSeedRect(cx - colW / 2, 0, colW, SIM_H);
        }
        break;
      case 5:
        const stripeH = SIM_H / 10;
        for (let s = 0; s < 5; s++) setSeedRect(0, s * 2 * stripeH, SIM_W, stripeH);
        break;
      case 6:
        const cellW = SIM_W / 8, cellH = SIM_H / 4;
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 8; c++)
            if ((r + c) % 2 === 0) setSeedRect(c * cellW, r * cellH, cellW, cellH);
        break;
      case 9:
        for (let i = 0; i < 120; i++) {
          const rx = rand(0, SIM_W), ry = rand(0, SIM_H), rs = rand(5, 20);
          setSeedRect(rx - rs / 2, ry - rs / 2, rs, rs);
        }
        break;
    }
    this.uploadFloatTex(this.srcTex, data);
    this.uploadFloatTex(this.dstTex, data);
  }

  addSeedAt(mx, my) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dstFbo);
    gl.viewport(0, 0, SIM_W, SIM_H);
    gl.useProgram(this.progStamp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.uStamp.tex, 0);
    gl.uniform2f(this.uStamp.center, mx, my);
    gl.uniform2f(this.uStamp.radius, 27.5, 27.5);
    gl.uniform2f(this.uStamp.texSize, SIM_W, SIM_H);
    gl.uniform4f(this.uStamp.stampColor, 0, 1, 0, 1);
    this.drawQuad();
    this.swap();
  }

  runSimulation() {
    const gl = this.gl;
    const p = this.params;
    const u = this.uGS;
    const fkTop = crescentFK(p.t_txt_top, p.k_off_top);
    const fkBot = crescentFK(p.t_txt_bot, p.k_off_bot);

    gl.useProgram(this.progGrayScott);
    gl.uniform1f(u.dA, p.dA);
    gl.uniform1f(u.dB, p.dA * 0.5);
    gl.uniform1f(u.dt, 1.0);
    gl.uniform2f(u.wh_rcp, this.whRcp[0], this.whRcp[1]);
    gl.uniform2f(u.txt_fk_top, fkTop[0], fkTop[1]);
    gl.uniform2f(u.txt_fk_bot, fkBot[0], fkBot[1]);
    gl.uniform2f(u.txt_y_range, 0, 1);
    gl.uniform2f(u.txt_x_range, 0, 1);
    gl.uniform1f(u.gradient_mode, GRADIENT_MODE);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.kfTex);
    gl.uniform1i(u.kf_map, 1);

    gl.viewport(0, 0, SIM_W, SIM_H);
    for (let i = 0; i < PASSES; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.dstFbo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.uniform1i(u.tex, 0);
      this.drawQuad();
      this.swap();
    }
  }

  renderToScreen() {
    const gl = this.gl;
    const dr = this.displayRect;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, dr.w, dr.h);
    gl.clearColor(1, 0.98, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progRender);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.uRender.tex, 0);
    this.drawQuad();
  }

  onPointerDown(e) {
    this.pointerDown = true;
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.screenToSim(e.clientX, e.clientY);
    if (pt) this.addSeedAt(pt.x, pt.y);
  }

  onPointerMove(e) {
    if (!this.pointerDown) return;
    const pt = this.screenToSim(e.clientX, e.clientY);
    if (pt) this.addSeedAt(pt.x, pt.y);
  }

  onKey(e) {
    if (e.key === 'r' || e.key === 'R') this.reseed();
  }

  loop(now) {
    const frameInterval = 1000 / TARGET_FPS;
    if (this.lastFrameTime && now - this.lastFrameTime < frameInterval) {
      requestAnimationFrame(t => this.loop(t));
      return;
    }
    this.lastFrameTime = now;

    const sec = (now - this.startTime) / 1000;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);

    this.updateSine(sec);
    this.updateKFMap();
    this.runSimulation();
    this.renderToScreen();

    requestAnimationFrame(t => this.loop(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('rd-canvas-container');
  const canvas = document.getElementById('canvas');
  if (!canvas) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (container) container.classList.add('rd-fallback');
    return;
  }

  const sim = new ReactionDiffusion(canvas);
  sim.init().catch(err => {
    console.error('[Blom RD]', err);
    if (container) container.classList.add('rd-fallback');
  });
});
