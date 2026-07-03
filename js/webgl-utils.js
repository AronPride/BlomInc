/**
 * Shared WebGL2 helpers for BLOM reaction-diffusion pages.
 */
const BlomWebGL = {
  VERT_SRC: `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`,

  compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh));
    }
    return sh;
  },

  createProgram(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, this.compileShader(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, this.compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    return prog;
  },

  cacheUniforms(gl, prog, names) {
    const u = {};
    gl.useProgram(prog);
    for (const n of names) u[n] = gl.getUniformLocation(prog, n);
    return u;
  },

  floatToHalf(val) {
    const f = new Float32Array(1);
    const i = new Int32Array(f.buffer);
    f[0] = val;
    const x = i[0];
    const sign = (x >> 16) & 0x8000;
    let mant = (x >> 12) & 0x07ff;
    let exp = (x >> 23) & 0xff;
    if (exp < 103) return sign;
    if (exp > 142) {
      return sign | 0x7c00 | ((exp === 255) ? ((x & 0x007fffff) ? 0x0200 : 0) : 0);
    }
    if (exp < 113) {
      mant |= 0x0800;
      mant >>= (114 - exp);
      exp = 0;
    } else {
      exp -= 112;
    }
    return sign | (exp << 10) | (mant >> 1);
  },

  probeFramebufferFormat(gl, internalFormat, texType) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, gl.RGBA, texType, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  },

  chooseTextureFormat(gl) {
    const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
    const hasHalf = !!gl.getExtension('EXT_color_buffer_half_float');
    if (hasFloat && this.probeFramebufferFormat(gl, gl.RGBA32F, gl.FLOAT)) {
      return { internal: gl.RGBA32F, uploadType: gl.FLOAT, useHalf: false };
    }
    if (hasHalf && this.probeFramebufferFormat(gl, gl.RGBA16F, gl.HALF_FLOAT)) {
      return { internal: gl.RGBA16F, uploadType: gl.HALF_FLOAT, useHalf: true };
    }
    if (this.probeFramebufferFormat(gl, gl.RGBA16F, gl.HALF_FLOAT)) {
      gl.getExtension('EXT_color_buffer_half_float');
      return { internal: gl.RGBA16F, uploadType: gl.HALF_FLOAT, useHalf: true };
    }
    throw new Error('Float render targets unavailable on this GPU');
  },

  createWebGL2Context(canvas) {
    const base = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true
    };
    const tries = [
      { ...base, powerPreference: 'high-performance' },
      base,
      { alpha: false }
    ];
    for (const attrs of tries) {
      const gl = canvas.getContext('webgl2', attrs);
      if (gl) return gl;
    }
    return null;
  },

  setupQuadVAO(gl, programs) {
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    for (const prog of programs) {
      gl.useProgram(prog);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    return vao;
  },

  createFloatTexture(gl, w, h, fmt) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, fmt.uploadType, null);
    return tex;
  },

  createByteTexture(gl, w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  },

  uploadByteTex(gl, tex, w, h, source) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  },

  createFBO(gl, tex) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
    }
    return fbo;
  },

  uploadFloatTex(gl, tex, w, h, data, fmt, halfBufRef) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (fmt.useHalf) {
      if (!halfBufRef.buf || halfBufRef.buf.length !== data.length) {
        halfBufRef.buf = new Uint16Array(data.length);
      }
      for (let i = 0; i < data.length; i++) {
        halfBufRef.buf[i] = this.floatToHalf(data[i]);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, gl.HALF_FLOAT, halfBufRef.buf);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, gl.RGBA, gl.FLOAT, data);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
};
