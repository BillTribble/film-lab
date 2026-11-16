// Film lab WebGL2 renderer. One fragment shader does the whole look:
// film stock (3D LUT) -> lens vignette -> halation -> light leak (screen) -> grain.
// Grain goes last because a leak exposes the film; the grain sits over it.

const VERT = `#version 300 es
in vec2 a;
out vec2 v_uv;
void main() {
  v_uv = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); // y-down to match image rows
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D uOrig, uHalo, uGrain, uLeak, uBloom;
uniform float uMist;          // Black Pro-Mist style bloom
uniform sampler3D uLut;
uniform float uAspect, uStrength, uHalation, uVignette, uGrainAmt, uBefore;
uniform vec2 uGrainScale;     // image pixels / grain tile pixels
uniform float uGrainSize, uGrainChroma; // per-stock grain profile
uniform int uMode;            // 0 off, 1 generated, 2 real
uniform float uLeakAmt, uBleed;
uniform int uType;            // generated: 0 glow, 1 streak, 2 wash
uniform vec2 uPos, uDir;
uniform float uSize, uHue, uSeed;
uniform mat3 uLeakMat;        // real: photo uv -> leak uv
uniform float uLeakHue;
// Artifacts (see artifacts.js). Positions in aspect space, sizes in image heights.
uniform float uArtOpacity, uDustSeed, uDustDensity;
uniform int uScratchAxis, uNScratch, uNHair, uNSpot;
uniform vec4 uScratch[8];
uniform vec2 uScratchAux[8];
uniform vec4 uHairA[4], uHairB[4];
uniform vec4 uSpot[5];
// Scanned dust/scratch overlay: 0 none, 1 screen (light marks), 2 multiply (dark marks).
uniform sampler2D uDust;
uniform int uDustBlend;
uniform mat3 uDustMat;
uniform float uDustAmt;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(fract(h) * 6.0 + vec3(0, 4, 2), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - clamp(b, 0.0, 1.0)); }

// Leaks burn hot at the core and cool to red at the fringe.
vec3 leakRamp(float f) {
  vec3 deep = hsv(uHue - 0.025, 1.0, 1.0);
  vec3 warm = hsv(min(uHue + 0.035, 0.095), 0.92, 1.0);
  vec3 c = mix(deep, warm, smoothstep(0.25, 0.7, f));
  return mix(c, vec3(1.0, 0.9, 0.72), smoothstep(0.75, 1.0, f));
}

vec3 generatedLeak(vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, uv.y);
  vec2 n = p * 2.5 + uSeed;
  float f;
  if (uType == 0) {
    float r = length(p - uPos) / uSize;
    f = exp(-r * r * (1.4 + fbm(n) * 0.9));
  } else if (uType == 1) {
    vec2 d = p - uPos;
    float along = dot(d, uDir), across = dot(d, vec2(-uDir.y, uDir.x));
    float w = uSize * (0.6 + 0.9 * fbm(vec2(along * 1.6 + uSeed, uSeed)));
    f = exp(-pow(abs(across) / w, 1.6)) * (0.55 + 0.6 * fbm(vec2(along * 2.2 + uSeed * 1.7, 0.5)));
  } else {
    float t = dot(p - uPos, uDir) / uSize;
    f = 1.0 - smoothstep(0.0, 1.0, t + (fbm(n) - 0.5) * 0.6);
  }
  f = clamp(f, 0.0, 1.0);
  // Exposure-like response keeps saturated colour in the fringe.
  return leakRamp(f) * (1.0 - exp(-f * 2.6));
}

vec3 hueRotate(vec3 c, float a) { // YIQ rotation
  mat3 toY = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  mat3 fromY = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toY * c; float cs = cos(a), sn = sin(a);
  return fromY * vec3(y.x, y.y * cs - y.z * sn, y.y * sn + y.z * cs);
}

// Integer hash (lowbias32) -> 0..1, salted per use and by the dust seed.
uint ihash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float ihash01(ivec2 c, uint salt) {
  uint h = ihash(uint(c.x) * 0x9E3779B1u ^ ihash(uint(c.y) + uint(uDustSeed) * 0x85EBCA77u) ^ salt * 0xC2B2AE3Du);
  return float(h) / 4294967295.0;
}

// Soft coverage of a shape whose edge is d units away, anti-aliased to one pixel.
float cover(float d) { float aa = fwidth(d) + 1e-6; return 1.0 - smoothstep(-aa, aa, d); }

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

vec3 artifacts(vec3 c, vec2 uv) {
  vec2 p = vec2(uv.x * uAspect, uv.y);

  if (uDustBlend > 0) {
    vec3 d = texture(uDust, (uDustMat * vec3(uv, 1.0)).xy).rgb;
    c = uDustBlend == 1 ? screen(c, d * uDustAmt) : mix(c, c * d, uDustAmt);
  }

  // Water spots: faint drying rings, slightly tinted.
  for (int i = 0; i < 5; i++) {
    if (i >= uNSpot) break;
    vec4 s = uSpot[i];
    float d = length(p - s.xy);
    float ring = exp(-pow((d - s.z) / (s.z * 0.06), 2.0));
    float inside = 1.0 - smoothstep(s.z * 0.9, s.z, d);
    c *= 1.0 - ring * 0.22 * s.w * uArtOpacity;
    c = mix(c, c * vec3(1.03, 0.99, 1.02), inside * 0.5 * s.w * uArtOpacity);
  }

  // Scratches along the film strip. Bright = emulsion scratched through,
  // dark = scratch in the base. They wobble and break up along their length.
  float along = uScratchAxis == 0 ? uv.x : uv.y;
  float across = uScratchAxis == 0 ? uv.y : uv.x;
  float acrossScale = uScratchAxis == 0 ? 1.0 : uAspect; // to image heights
  for (int i = 0; i < 8; i++) {
    if (i >= uNScratch) break;
    vec4 s = uScratch[i];
    vec2 aux = uScratchAux[i];
    if (along < s.y || along > s.z) continue;
    float wob = (noise(vec2(along * 6.0, aux.x)) - 0.5) * 0.004 + sin(along * 23.0 + aux.x) * 0.0006;
    float d = abs(across - s.x - wob) * acrossScale - abs(s.w);
    float breakUp = smoothstep(0.25, 0.55, noise(vec2(along * 40.0, aux.x + 3.0)));
    float ends = smoothstep(s.y, s.y + 0.03, along) * (1.0 - smoothstep(s.z - 0.03, s.z, along));
    float a = cover(d) * breakUp * ends * aux.y * uArtOpacity;
    c = s.w > 0.0 ? mix(c, vec3(0.96, 1.0, 0.97), a) : c * (1.0 - 0.8 * a);
  }

  // Hairs: thin dark curves (quadratic Bezier, sampled as segments).
  for (int i = 0; i < 4; i++) {
    if (i >= uNHair) break;
    vec2 p0 = uHairA[i].xy, p1 = uHairA[i].zw, p2 = uHairB[i].xy;
    float d = 1e9;
    vec2 prev = p0;
    for (int k = 1; k <= 16; k++) {
      float t = float(k) / 16.0;
      vec2 q = mix(mix(p0, p1, t), mix(p1, p2, t), t);
      d = min(d, segDist(p, prev, q));
      prev = q;
    }
    c *= 1.0 - 0.9 * cover(d - uHairB[i].z) * uHairB[i].w * uArtOpacity;
  }

  // Dust: mostly tiny, some elongated specks, one chance per grid cell.
  // Integer hashing keeps the scatter random at any seed (float hashes band).
  if (uDustDensity > 0.0) {
    const float cell = 1.0 / 70.0;
    ivec2 base = ivec2(floor(p / cell));
    float dark = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      ivec2 id = base + ivec2(x, y);
      if (ihash01(id, 0u) > uDustDensity) continue;
      vec2 centre = (vec2(id) + vec2(ihash01(id, 1u), ihash01(id, 2u))) * cell;
      float r = mix(0.0005, 0.0024, pow(ihash01(id, 3u), 3.0));
      float ang = ihash01(id, 4u) * 6.2832;
      vec2 d = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (p - centre);
      d.x /= mix(1.0, 2.2, pow(ihash01(id, 5u), 2.0));
      dark = max(dark, cover(length(d) - r) * mix(0.55, 1.0, ihash01(id, 6u)));
    }
    c *= 1.0 - 0.85 * dark * uArtOpacity;
  }
  return c;
}

void main() {
  vec3 orig = texture(uOrig, v_uv).rgb;
  if (uBefore > 0.5) { o = vec4(orig, 1.0); return; }
  vec3 film = texture(uLut, orig * (63.0 / 64.0) + 0.5 / 64.0).rgb;
  vec3 c = mix(orig, film, uStrength);

  // Mist filter: highlights bloom in their own colour and contrast softens a
  // touch, while the blacks stay put (that is what makes it a *black* mist).
  // Halation strength here, so the mist can take on its red.
  float halo = texture(uHalo, v_uv).r;
  float hr = clamp(halo * uHalation * 2.0, 0.0, 1.0);

  if (uMist > 0.0) {
    // The slider runs to 4x the original strength: 25% is the old 100%.
    float m = uMist * 4.0;
    // A slightly warm glow, turning red where halation is, so the mist
    // carries the halation's red instead of washing it out to white.
    vec3 tint = mix(vec3(1.0, 0.9, 0.8), vec3(1.0, 0.5, 0.3), hr);
    vec3 bloom = texture(uBloom, v_uv).rgb * tint;
    c = screen(c, min(bloom * m, vec3(1.0)));
    c = mix(c, c * 0.93 + 0.035 * smoothstep(0.05, 0.4, c), min(1.0, m * 0.5));
  }

  vec2 q = (v_uv - 0.5) * vec2(uAspect, 1.0) / (0.5 * length(vec2(uAspect, 1.0)));
  c *= 1.0 - uVignette * 0.8 * smoothstep(0.35, 1.05, length(q));

  c = screen(c, halo * uHalation * vec3(1.0, 0.36, 0.16));

  if (uMode > 0) {
    vec3 L = uMode == 1 ? generatedLeak(v_uv)
                        : hueRotate(texture(uLeak, (uLeakMat * vec3(v_uv, 1.0)).xy).rgb, uLeakHue);
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    if (uBleed > 0.5) L *= mix(0.55, 1.6, smoothstep(0.2, 0.9, lum));
    c = screen(c, L * uLeakAmt);
  }

  // Grain: one scanned tile, sized per stock. Colour film grain is dye clouds,
  // so each channel also gets its own offset sample, blended in by uGrainChroma.
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  vec2 gu = v_uv * uGrainScale / uGrainSize;
  float gm = texture(uGrain, gu).r - 0.5;
  vec3 gc = vec3(gm, texture(uGrain, gu + vec2(0.37, 0.71)).r - 0.5, texture(uGrain, gu + vec2(0.83, 0.19)).r - 0.5);
  vec3 g = mix(vec3(gm), gc, uGrainChroma);
  c += g * uGrainAmt * 0.5 * (0.35 + 2.6 * l * (1.0 - l));
  // Dust and scratches sit on top of the grain, as on a scanned slide.
  c = artifacts(clamp(c, 0.0, 1.0), v_uv);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const LUT_N = 64;

export class FilmRenderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("This browser does not support WebGL2.");
    this.gl = gl;
    this.canvas = canvas;
    this.prog = this._program(VERT, FRAG);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.loc = {};
    this.tex = {};
    this.lutKey = "";
    this.grainSize = [1, 1];
    this.black = this._texture(new ImageData(1, 1));
    this.grey = this._texture(new ImageData(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1));
  }

  _program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  _texture(source, wrap, { mip = true } = {}) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
    return t;
  }

  _release(slot) {
    const t = this.tex[slot];
    if (t && t !== this.black && t !== this.grey) this.gl.deleteTexture(t);
  }

  /** Replace a 2D texture slot (orig, halo, leak) with an image source. */
  setImage(slot, img) {
    this._release(slot);
    this.tex[slot] = img ? this._texture(img) : this.black;
  }

  /**
   * Grain tile, repeated across the frame at 1 image pixel = 1 grain pixel.
   * No mipmaps: a fit-to-window preview shows the photo at a fraction of its
   * own pixel size, so the tile is minified heavily, and mip filtering averages
   * random noise to flat grey — which is why the grain disappeared on screen
   * (it survived only in a full-resolution export). Plain linear sampling keeps
   * the noise's contrast at every zoom, trading a little aliasing for grain you
   * can actually see.
   */
  setGrain(img) {
    this._release("grain");
    if (!img) { this.tex.grain = this.grey; return; }
    this.tex.grain = this._texture(img, this.gl.MIRRORED_REPEAT, { mip: false });
    this.grainSize = [img.width, img.height];
  }

  /** Film-stock cube from build_assets.py: RGBA bytes, index ((b*64+g)*64+r)*4. */
  setLut(key, data) {
    const gl = this.gl;
    if (this.tex.lut) gl.deleteTexture(this.tex.lut);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_N, LUT_N, LUT_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.tex.lut = t;
    this.lutKey = key;
  }

  _u(name) {
    if (!(name in this.loc)) this.loc[name] = this.gl.getUniformLocation(this.prog, name);
    return this.loc[name];
  }

  _draw(width, height, p) {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.prog);
    ["uOrig", "uHalo", "uGrain", "uLeak"].forEach((n, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[n.slice(1).toLowerCase()] || this.black);
      gl.uniform1i(this._u(n), i);
    });
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, this.tex.lut || null);
    gl.uniform1i(this._u("uLut"), 4);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.bloom || this.black);
    gl.uniform1i(this._u("uBloom"), 6);

    const f = (n, v) => gl.uniform1f(this._u(n), v);
    f("uAspect", p.aspect); f("uStrength", p.strength); f("uHalation", p.halation);
    f("uVignette", p.vignette); f("uGrainAmt", p.grain); f("uBefore", p.before ? 1 : 0);
    f("uMist", p.mist || 0);
    // Grain is sized in source-image pixels so it looks the same at any zoom.
    const px = p.imageWidth || width, py = p.imageHeight || height;
    gl.uniform2f(this._u("uGrainScale"), px / this.grainSize[0], py / this.grainSize[1]);
    f("uGrainSize", p.grainSize || 1); f("uGrainChroma", p.grainChroma || 0);
    gl.uniform1i(this._u("uMode"), p.leak ? p.leak.mode : 0);
    if (p.leak) {
      const L = p.leak;
      f("uLeakAmt", L.amount); f("uBleed", L.bleed ? 1 : 0);
      if (L.mode === 1) {
        gl.uniform1i(this._u("uType"), L.type);
        gl.uniform2f(this._u("uPos"), L.pos[0], L.pos[1]);
        gl.uniform2f(this._u("uDir"), L.dir[0], L.dir[1]);
        f("uSize", L.size); f("uHue", L.hue); f("uSeed", L.noiseSeed);
      } else {
        gl.uniformMatrix3fv(this._u("uLeakMat"), false, L.matrix);
        f("uLeakHue", L.hueShift);
      }
    }
    this._artifacts(p.artifacts);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _artifacts(a) {
    const gl = this.gl;
    const i = (n, v) => gl.uniform1i(this._u(n), v);
    // Scanned overlay (texture unit 5).
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.dust || this.black);
    i("uDust", 5);
    const scan = a?.scan;
    i("uDustBlend", scan ? scan.blend : 0);
    if (scan) {
      gl.uniformMatrix3fv(this._u("uDustMat"), false, scan.matrix);
      gl.uniform1f(this._u("uDustAmt"), scan.amount);
    }
    if (!a || !a.generated) { ["uNScratch", "uNHair", "uNSpot"].forEach((n) => i(n, 0)); gl.uniform1f(this._u("uDustDensity"), 0); return; }
    a = a.generated;
    const pad = (arr, len) => { const out = new Float32Array(len); out.set(arr.slice(0, len)); return out; };
    gl.uniform1f(this._u("uArtOpacity"), a.opacity);
    gl.uniform1f(this._u("uDustSeed"), a.dustSeed);
    gl.uniform1f(this._u("uDustDensity"), a.dustDensity);
    i("uScratchAxis", a.axis);
    i("uNScratch", a.scratches.length / 4);
    i("uNHair", a.hairs.length / 4);
    i("uNSpot", a.spots.length / 4);
    gl.uniform4fv(this._u("uScratch"), pad(a.scratches, 32));
    gl.uniform2fv(this._u("uScratchAux"), pad(a.scratchAux, 16));
    gl.uniform4fv(this._u("uHairA"), pad(a.hairs, 16));
    gl.uniform4fv(this._u("uHairB"), pad(a.hairsB, 16));
    gl.uniform4fv(this._u("uSpot"), pad(a.spots, 20));
  }

  /** Draw to this renderer's canvas at its current pixel size. */
  render(p) {
    this._draw(this.canvas.width, this.canvas.height, p);
  }

  /** Render at full resolution offscreen and return a JPEG blob. */
  async exportJpeg(width, height, p, quality = 0.95) {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    const rt = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rt);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
    this._draw(width, height, { ...p, imageWidth: width, imageHeight: height });
    const px = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(rt);
    // readPixels starts at the bottom row; flip to image order.
    const out = new ImageData(width, height);
    const row = width * 4;
    for (let y = 0; y < height; y++) out.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    const cv = new OffscreenCanvas(width, height);
    cv.getContext("2d").putImageData(out, 0, 0);
    return cv.convertToBlob({ type: "image/jpeg", quality });
  }

  dispose() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
