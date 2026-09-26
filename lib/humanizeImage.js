/**
 * Image Humanization Module
 *
 * Faithful JavaScript port of the Python `humanize.py` pipeline used to reduce
 * AI-generated image artifacts and make outputs look like real camera captures.
 *
 * Pipeline (matches the Python order and parameters):
 *   1. Resize trick        - downscale to 0.92x then back (LANCZOS) to break upscaling grids
 *   2. FFT phase scramble  - randomize high-frequency phases (strength 0.2)
 *   3. Gaussian blur       - subtle optical low-pass (sigma 0.25)
 *   4. Unsharp mask        - lens-style re-sharpen (radius 0.9, percent 60)
 *   5. Chromatic aberration- shift R/B channels (shift 1.3)
 *   6. Vignette            - natural lens shading (intensity 0.09)
 *   7. PRNU sensor noise   - multiplicative fixed-pattern noise (sigma 0.003)
 *   8. Color/contrast jitter + JPEG re-encode (quality 88, 4:4:4)
 *
 * All heavy numeric work runs on raw Float64 channel arrays extracted via sharp.
 * The FFT is a self-contained Cooley-Tukey (radix-2) implementation with a
 * Bluestein fallback for arbitrary (non power-of-two) image dimensions, so no
 * external FFT dependency is required.
 */

const sharp = require('sharp');

// ---------------------------------------------------------------------------
// 1D FFT primitives (radix-2 + Bluestein), with per-size table caching
// ---------------------------------------------------------------------------

const _radix2Cache = new Map();
const _bluesteinCache = new Map();

function _getRadix2Tables(n) {
  let t = _radix2Cache.get(n);
  if (t) return t;
  const levels = Math.round(Math.log2(n));
  const half = n / 2;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const angle = (2 * Math.PI * i) / n;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  t = { levels, cos, sin };
  _radix2Cache.set(n, t);
  return t;
}

function _reverseBits(x, bits) {
  let y = 0;
  for (let i = 0; i < bits; i++) {
    y = (y << 1) | (x & 1);
    x >>>= 1;
  }
  return y >>> 0;
}

// In-place radix-2 FFT (n must be a power of two).
function _transformRadix2(re, im) {
  const n = re.length;
  if (n <= 1) return;
  const { levels, cos, sin } = _getRadix2Tables(n);

  for (let i = 0; i < n; i++) {
    const j = _reverseBits(i, levels);
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  for (let size = 2; size <= n; size *= 2) {
    const halfsize = size / 2;
    const tablestep = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + halfsize; j++, k += tablestep) {
        const l = j + halfsize;
        const tpre = re[l] * cos[k] + im[l] * sin[k];
        const tpim = -re[l] * sin[k] + im[l] * cos[k];
        re[l] = re[j] - tpre;
        im[l] = im[j] - tpim;
        re[j] += tpre;
        im[j] += tpim;
      }
    }
  }
}

function _getBluesteinTables(n) {
  let t = _bluesteinCache.get(n);
  if (t) return t;
  let m = 1;
  while (m < 2 * n + 1) m *= 2;
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i * i) % (2 * n);
    const angle = (Math.PI * j) / n;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  t = { m, cos, sin };
  _bluesteinCache.set(n, t);
  return t;
}

// In-place FFT for arbitrary length via Bluestein's algorithm.
function _transformBluestein(re, im) {
  const n = re.length;
  const { m, cos, sin } = _getBluesteinTables(n);

  const areal = new Float64Array(m);
  const aimag = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    areal[i] = re[i] * cos[i] + im[i] * sin[i];
    aimag[i] = -re[i] * sin[i] + im[i] * cos[i];
  }

  const breal = new Float64Array(m);
  const bimag = new Float64Array(m);
  breal[0] = cos[0];
  bimag[0] = sin[0];
  for (let i = 1; i < n; i++) {
    breal[i] = breal[m - i] = cos[i];
    bimag[i] = bimag[m - i] = sin[i];
  }

  // Circular convolution of a and b via size-m radix-2 FFTs.
  _transformRadix2(areal, aimag);
  _transformRadix2(breal, bimag);
  for (let i = 0; i < m; i++) {
    const tmp = areal[i] * breal[i] - aimag[i] * bimag[i];
    aimag[i] = areal[i] * bimag[i] + aimag[i] * breal[i];
    areal[i] = tmp;
  }
  // Inverse transform (swap re/im).
  _transformRadix2(aimag, areal);
  for (let i = 0; i < m; i++) {
    areal[i] /= m;
    aimag[i] /= m;
  }

  for (let i = 0; i < n; i++) {
    re[i] = areal[i] * cos[i] + aimag[i] * sin[i];
    im[i] = -areal[i] * sin[i] + aimag[i] * cos[i];
  }
}

function _fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) === 0) _transformRadix2(re, im);
  else _transformBluestein(re, im);
}

function _ifft(re, im) {
  // inverse == swap real/imag, forward, swap back (caller normalizes)
  _fft(im, re);
}

// 2D FFT (row transforms then column transforms). Operates in place.
// When inverse is true the result is divided by (w*h) to match numpy's ifft2.
function _fft2(re, im, w, h, inverse) {
  const rowRe = new Float64Array(w);
  const rowIm = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) { rowRe[x] = re[base + x]; rowIm[x] = im[base + x]; }
    if (inverse) _ifft(rowRe, rowIm); else _fft(rowRe, rowIm);
    for (let x = 0; x < w; x++) { re[base + x] = rowRe[x]; im[base + x] = rowIm[x]; }
  }

  const colRe = new Float64Array(h);
  const colIm = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) { colRe[y] = re[y * w + x]; colIm[y] = im[y * w + x]; }
    if (inverse) _ifft(colRe, colIm); else _fft(colRe, colIm);
    for (let y = 0; y < h; y++) { re[y * w + x] = colRe[y]; im[y * w + x] = colIm[y]; }
  }

  if (inverse) {
    const norm = w * h;
    for (let i = 0; i < re.length; i++) { re[i] /= norm; im[i] /= norm; }
  }
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

// Standard normal via Box-Muller.
function _gaussRand() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Pixel-domain effects (operate on Float64 channel arrays, length w*h, 0-255)
// ---------------------------------------------------------------------------

function _nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Reflect an out-of-range index back into [0, n) (mirror padding, no edge seam).
function _reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n - 2;
  let m = i % period;
  if (m < 0) m += period;
  return m < n ? m : period - m;
}

// Step 2: FFT phase scramble. Randomizes phase of frequencies above 30% of the
// min-dimension radius. Matches fft_phase_scramble() in humanize.py.
//
// For non power-of-two dimensions the channel is reflection-padded to the next
// power of two so the FFT stays on the fast radix-2 path. Reflection avoids a
// hard edge (which would inject spurious high-frequency energy) and the random
// high-frequency phase perturbation is visually equivalent to operating at the
// exact size, while being dramatically faster than a Bluestein transform.
function _fftPhaseScramble(ch, w, h, strength) {
  const W2 = _nextPow2(w);
  const H2 = _nextPow2(h);
  const padded = W2 !== w || H2 !== h;

  const cw = padded ? W2 : w;
  const chh = padded ? H2 : h;

  let re;
  if (padded) {
    re = new Float64Array(cw * chh);
    for (let y = 0; y < chh; y++) {
      const sy = _reflectIndex(y, h);
      const srcRow = sy * w;
      const dstRow = y * cw;
      for (let x = 0; x < cw; x++) {
        re[dstRow + x] = ch[srcRow + _reflectIndex(x, w)];
      }
    }
  } else {
    re = Float64Array.from(ch);
  }
  const im = new Float64Array(cw * chh);

  _fft2(re, im, cw, chh, false);

  const cy = Math.floor(chh / 2);
  const cx = Math.floor(cw / 2);
  const thr = Math.min(cw, chh) * 0.3;
  const thr2 = thr * thr;
  const shX = Math.floor(cw / 2);
  const shY = Math.floor(chh / 2);

  for (let y = 0; y < chh; y++) {
    const sy = (y + shY) % chh;
    const dy = sy - cy;
    for (let x = 0; x < cw; x++) {
      const sx = (x + shX) % cw;
      const dx = sx - cx;
      if (dx * dx + dy * dy > thr2) {
        const theta = (Math.random() * 2 - 1) * Math.PI * strength;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        const idx = y * cw + x;
        const rr = re[idx];
        const ii = im[idx];
        // Rotate the complex value by theta (phase += theta, magnitude preserved).
        re[idx] = rr * c - ii * s;
        im[idx] = rr * s + ii * c;
      }
    }
  }

  _fft2(re, im, cw, chh, true);

  // Copy the (real) top-left w×h region back into the channel.
  for (let y = 0; y < h; y++) {
    const srcRow = y * cw;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      let v = re[srcRow + x];
      if (v < 0) v = 0; else if (v > 255) v = 255;
      ch[dstRow + x] = v;
    }
  }
}

// Separable Gaussian blur on a single channel. Returns a new Float64Array.
// `sigma` is the standard deviation (PIL GaussianBlur "radius" == sigma).
function _gaussianBlurChannel(ch, w, h, sigma) {
  if (sigma <= 0) return Float64Array.from(ch);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float64Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const val = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = val;
    sum += val;
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const tmp = new Float64Array(w * h);
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += ch[base + xx] * kernel[k + radius];
      }
      tmp[base + x] = acc;
    }
  }
  // Vertical pass
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// Step 4: Unsharp mask (PIL ImageFilter.UnsharpMask). out = orig + amount*(orig-blur).
function _unsharpChannel(ch, w, h, radius, percent, threshold) {
  const blur = _gaussianBlurChannel(ch, w, h, radius);
  const amount = percent / 100;
  for (let i = 0; i < ch.length; i++) {
    const diff = ch[i] - blur[i];
    if (Math.abs(diff) >= threshold) {
      let v = ch[i] + amount * diff;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      ch[i] = v;
    }
  }
}

// Bilinear sample with edge clamping.
function _sampleBilinear(ch, w, h, fx, fy) {
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (x0 < 0) x0 = 0; else if (x0 >= w) x0 = w - 1;
  if (x1 < 0) x1 = 0; else if (x1 >= w) x1 = w - 1;
  if (y0 < 0) y0 = 0; else if (y0 >= h) y0 = h - 1;
  if (y1 < 0) y1 = 0; else if (y1 >= h) y1 = h - 1;
  const a = ch[y0 * w + x0];
  const b = ch[y0 * w + x1];
  const c = ch[y1 * w + x0];
  const d = ch[y1 * w + x1];
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

// Step 5: Chromatic aberration. Shift R channel by (+shift, +shift/2) and B by
// the opposite, mimicking lateral lens dispersion.
function _chromaticAberration(r, b, w, h, shift) {
  const rOut = new Float64Array(w * h);
  const bOut = new Float64Array(w * h);
  const sy = shift / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      rOut[idx] = _sampleBilinear(r, w, h, x + shift, y + sy);
      bOut[idx] = _sampleBilinear(b, w, h, x - shift, y - sy);
    }
  }
  r.set(rOut);
  b.set(bOut);
}

// Step 6: Vignette. mask = clip(1 - intensity*d^2, 0.7, 1) with d normalized to [-1,1].
function _vignette(r, g, b, w, h, intensity) {
  for (let y = 0; y < h; y++) {
    const ny = h > 1 ? (y / (h - 1)) * 2 - 1 : 0;
    for (let x = 0; x < w; x++) {
      const nx = w > 1 ? (x / (w - 1)) * 2 - 1 : 0;
      const d2 = nx * nx + ny * ny;
      let m = 1 - intensity * d2;
      if (m < 0.7) m = 0.7; else if (m > 1) m = 1;
      const idx = y * w + x;
      r[idx] *= m;
      g[idx] *= m;
      b[idx] *= m;
    }
  }
}

// Step 7: PRNU multiplicative sensor noise. Same per-pixel pattern on all channels.
function _prnu(r, g, b, w, h, sigma) {
  for (let i = 0; i < w * h; i++) {
    const factor = 1 + _gaussRand() * sigma;
    let rr = r[i] * factor;
    let gg = g[i] * factor;
    let bb = b[i] * factor;
    r[i] = rr < 0 ? 0 : rr > 255 ? 255 : rr;
    g[i] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
    b[i] = bb < 0 ? 0 : bb > 255 ? 255 : bb;
  }
}

// PIL ImageEnhance.Color: interpolate between luminance-gray and original.
function _colorEnhance(r, g, b, w, h, factor) {
  for (let i = 0; i < w * h; i++) {
    const l = r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
    r[i] = l + (r[i] - l) * factor;
    g[i] = l + (g[i] - l) * factor;
    b[i] = l + (b[i] - l) * factor;
  }
}

// PIL ImageEnhance.Contrast: interpolate between mean-gray and original.
function _contrastEnhance(r, g, b, w, h, factor) {
  const n = w * h;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += r[i] * 0.299 + g[i] * 0.587 + b[i] * 0.114;
  const mean = Math.floor(sum / n + 0.5);
  for (let i = 0; i < n; i++) {
    let rr = mean + (r[i] - mean) * factor;
    let gg = mean + (g[i] - mean) * factor;
    let bb = mean + (b[i] - mean) * factor;
    r[i] = rr < 0 ? 0 : rr > 255 ? 255 : rr;
    g[i] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
    b[i] = bb < 0 ? 0 : bb > 255 ? 255 : bb;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULTS = {
  resizeScale: 0.92,
  scrambleStrength: 0.2,
  blurSigma: 0.25,
  unsharpRadius: 0.9,
  unsharpPercent: 60,
  unsharpThreshold: 0,
  chromaShift: 1.3,
  vignetteIntensity: 0.09,
  prnuSigma: 0.003,
  colorMin: 0.96,
  colorMax: 1.04,
  contrastMin: 0.97,
  contrastMax: 1.03,
  jpegQuality: 88
};

/**
 * Apply the full humanization pipeline to an image buffer.
 *
 * @param {Buffer} input - Image buffer (any format sharp can decode)
 * @param {Object} options
 * @param {number} options.intensity - Global multiplier for the scramble/aberration/vignette/noise strengths (default 1)
 * @param {Object} options.params - Optional overrides for individual DEFAULTS values
 * @returns {Promise<{success: boolean, buffer?: Buffer, format?: string, error?: string}>}
 */
async function humanizeBuffer(input, options = {}) {
  try {
    const intensity = typeof options.intensity === 'number' ? options.intensity : 1;
    const p = Object.assign({}, DEFAULTS, options.params || {});

    // Stage 1: resize trick + raw RGB extraction.
    const meta = await sharp(input).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) return { success: false, error: 'Unable to read image dimensions' };

    const downW = Math.max(1, Math.round(W * p.resizeScale));
    const downH = Math.max(1, Math.round(H * p.resizeScale));

    const { data, info } = await sharp(input)
      .resize(downW, downH, { kernel: 'lanczos3' })
      .resize(W, H, { kernel: 'lanczos3', fit: 'fill' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const channels = info.channels; // expected 3 after removeAlpha on srgb
    const n = W * H;
    const r = new Float64Array(n);
    const g = new Float64Array(n);
    const b = new Float64Array(n);
    if (channels >= 3) {
      for (let i = 0; i < n; i++) {
        const o = i * channels;
        r[i] = data[o];
        g[i] = data[o + 1];
        b[i] = data[o + 2];
      }
    } else {
      // Grayscale fallback: replicate the single channel.
      for (let i = 0; i < n; i++) {
        const v = data[i * channels];
        r[i] = v; g[i] = v; b[i] = v;
      }
    }

    // Stage 2: FFT phase scramble (per channel, independent noise).
    const scramble = p.scrambleStrength * intensity;
    if (scramble > 0) {
      _fftPhaseScramble(r, W, H, scramble);
      _fftPhaseScramble(g, W, H, scramble);
      _fftPhaseScramble(b, W, H, scramble);
    }

    // Stage 3: subtle Gaussian blur (optical low-pass).
    if (p.blurSigma > 0) {
      const br = _gaussianBlurChannel(r, W, H, p.blurSigma);
      const bg = _gaussianBlurChannel(g, W, H, p.blurSigma);
      const bb = _gaussianBlurChannel(b, W, H, p.blurSigma);
      r.set(br); g.set(bg); b.set(bb);
    }

    // Stage 4: unsharp mask (lens sharpening).
    if (p.unsharpPercent > 0) {
      _unsharpChannel(r, W, H, p.unsharpRadius, p.unsharpPercent, p.unsharpThreshold);
      _unsharpChannel(g, W, H, p.unsharpRadius, p.unsharpPercent, p.unsharpThreshold);
      _unsharpChannel(b, W, H, p.unsharpRadius, p.unsharpPercent, p.unsharpThreshold);
    }

    // Stage 5: chromatic aberration.
    const chroma = p.chromaShift * intensity;
    if (chroma > 0) _chromaticAberration(r, b, W, H, chroma);

    // Stage 6: vignette.
    const vig = p.vignetteIntensity * intensity;
    if (vig > 0) _vignette(r, g, b, W, H, vig);

    // Stage 7: PRNU sensor noise.
    const prnuSigma = p.prnuSigma * intensity;
    if (prnuSigma > 0) _prnu(r, g, b, W, H, prnuSigma);

    // Stage 8a: color + contrast jitter.
    const colorFactor = p.colorMin + Math.random() * (p.colorMax - p.colorMin);
    const contrastFactor = p.contrastMin + Math.random() * (p.contrastMax - p.contrastMin);
    _colorEnhance(r, g, b, W, H, colorFactor);
    _contrastEnhance(r, g, b, W, H, contrastFactor);

    // Pack back to an interleaved 8-bit RGB buffer.
    const out = Buffer.allocUnsafe(n * 3);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let rv = r[i], gv = g[i], bv = b[i];
      out[o] = rv < 0 ? 0 : rv > 255 ? 255 : (rv + 0.5) | 0;
      out[o + 1] = gv < 0 ? 0 : gv > 255 ? 255 : (gv + 0.5) | 0;
      out[o + 2] = bv < 0 ? 0 : bv > 255 ? 255 : (bv + 0.5) | 0;
    }

    // Stage 8b: JPEG re-encode (quality 88, 4:4:4 chroma to match subsampling=0).
    const buffer = await sharp(out, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: p.jpegQuality, mozjpeg: false, chromaSubsampling: '4:4:4' })
      .toBuffer();

    return { success: true, buffer, format: 'jpeg' };
  } catch (error) {
    console.error('[Humanize] Error humanizing image:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Humanize an image file on disk and write the result to outputPath.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object} options - see humanizeBuffer
 */
async function humanizeImageFile(inputPath, outputPath, options = {}) {
  const fs = require('fs').promises;
  try {
    const inputBuffer = await fs.readFile(inputPath);
    const result = await humanizeBuffer(inputBuffer, options);
    if (!result.success) return result;
    await fs.writeFile(outputPath, result.buffer);
    return { success: true, outputPath, format: result.format };
  } catch (error) {
    console.error('[Humanize] Error humanizing image file:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  humanizeBuffer,
  humanizeImageFile,
  DEFAULTS
};
