/** Broadband noise reduction (spectral gating) + a classic noise gate. */
import { fft, hann } from "./fft";

export type DenoiseSettings = {
  enabled: boolean;
  amount: number; // 0..1 — how aggressively broadband noise is subtracted
  gateEnabled: boolean;
  thresholdDb: number; // gate opens above this level
  attackMs: number;
  releaseMs: number;
  floorDb: number; // attenuation applied when the gate is closed
};

export const DEFAULT_DENOISE: DenoiseSettings = {
  enabled: true,
  amount: 0.55,
  gateEnabled: true,
  thresholdDb: -46,
  attackMs: 5,
  releaseMs: 120,
  floorDb: -32,
};

const FFT_SIZE = 1024;
const HOP = FFT_SIZE / 4;

/** Per-bin noise floor, taken as a low percentile of each bin over time. */
function noiseProfile(frames: Float32Array[], bins: number) {
  const profile = new Float32Array(bins);
  if (!frames.length) return profile;
  const scratch = new Float32Array(frames.length);
  for (let b = 0; b < bins; b++) {
    for (let f = 0; f < frames.length; f++) scratch[f] = frames[f]![b]!;
    const sorted = Array.from(scratch).sort((a, c) => a - c);
    profile[b] = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  }
  return profile;
}

/**
 * Spectral-gating denoise: estimates a per-bin noise floor from the take
 * itself, then attenuates bins that sit close to it. Phase is preserved,
 * so the result stays natural enough for pitch tracking afterwards.
 */
export function spectralDenoise(signal: Float32Array, amount: number): Float32Array {
  if (amount <= 0.001 || signal.length < FFT_SIZE * 2) return signal;
  const bins = FFT_SIZE / 2;
  const win = hann(FFT_SIZE);
  const positions: number[] = [];
  for (let pos = 0; pos + FFT_SIZE <= signal.length; pos += HOP) positions.push(pos);

  // --- analysis pass -------------------------------------------------------
  const reFrames: Float32Array[] = [];
  const imFrames: Float32Array[] = [];
  const magFrames: Float32Array[] = [];
  for (const pos of positions) {
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) re[i] = signal[pos + i]! * win[i]!;
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b]!, im[b]!);
    reFrames.push(re);
    imFrames.push(im);
    magFrames.push(mag);
  }

  const profile = noiseProfile(magFrames, bins);
  const oversub = 1 + amount * 2.5; // how far above the floor we subtract
  const floorGain = Math.max(0.02, 1 - amount); // never fully mute a bin

  // --- gain mask, smoothed over time and frequency --------------------------
  const masks: Float32Array[] = magFrames.map((mag) => {
    const g = new Float32Array(bins);
    for (let b = 0; b < bins; b++) {
      const m = mag[b]!;
      const n = profile[b]! * oversub;
      const clean = m - n;
      g[b] = m > 1e-9 ? Math.max(floorGain, clean / m) : floorGain;
    }
    return g;
  });
  for (const g of masks) {
    for (let b = 1; b < bins - 1; b++) g[b] = (g[b - 1]! + g[b]! * 2 + g[b + 1]!) / 4;
  }
  for (let f = 1; f < masks.length; f++) {
    const prev = masks[f - 1]!;
    const cur = masks[f]!;
    for (let b = 0; b < bins; b++) cur[b] = prev[b]! * 0.35 + cur[b]! * 0.65;
  }

  // --- synthesis (overlap-add with window normalisation) --------------------
  const out = new Float32Array(signal.length);
  const norm = new Float32Array(signal.length);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let f = 0; f < positions.length; f++) {
    const pos = positions[f]!;
    const src re = 0; // placeholder removed
  }
  for (let f = 0; f < positions.length; f++) {
    const pos = positions[f]!;
    const sr = reFrames[f]!;
    const si = imFrames[f]!;
    const mask = masks[f]!;
    for (let b = 0; b < bins; b++) {
      const g = mask[b]!;
      re[b] = sr[b]! * g;
      im[b] = si[b]! * g;
      if (b > 0) {
        // mirror for a real-valued inverse transform
        re[FFT_SIZE - b] = re[b]!;
        im[FFT_SIZE - b] = -im[b]!;
      }
    }
    re[0] = sr[0]! * mask[0]!;
    im[0] = 0;
    re[bins] = 0;
    im[bins] = 0;

    // inverse FFT via conjugation
    for (let i = 0; i < FFT_SIZE; i++) im[i] = -im[i]!;
    fft(re, im);
    const scale = 1 / FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = re[i]! * scale * win[i]!;
      out[pos + i] = out[pos + i]! + v;
      norm[pos + i] = norm[pos + i]! + win[i]! * win[i]!;
    }
  }

  for (let i = 0; i < out.length; i++) {
    const n = norm[i]!;
    out[i] = n > 1e-6 ? out[i]! / n : signal[i]!;
  }
  return out;
}

/** Envelope-following noise gate with attack/release and a soft floor. */
export function noiseGate(
  signal: Float32Array,
  sampleRate: number,
  opts: { thresholdDb: number; attackMs: number; releaseMs: number; floorDb: number },
): Float32Array {
  const threshold = Math.pow(10, opts.thresholdDb / 20);
  const floor = Math.pow(10, opts.floorDb / 20);
  const atk = Math.exp(-1 / (Math.max(0.5, opts.attackMs) * 0.001 * sampleRate));
  const rel = Math.exp(-1 / (Math.max(1, opts.releaseMs) * 0.001 * sampleRate));
  const detCoef = Math.exp(-1 / (0.004 * sampleRate)); // 4 ms level detector

  const out = new Float32Array(signal.length);
  let env = 0;
  let gain = floor;
  const hysteresis = 0.5; // closes at ~6 dB below the open threshold

  for (let i = 0; i < signal.length; i++) {
    const x = signal[i]!;
    const level = Math.abs(x);
    env = level > env ? level : env * detCoef + level * (1 - detCoef);
    const open = gain > (1 + floor) / 2 ? env > threshold * hysteresis : env > threshold;
    const target = open ? 1 : floor;
    const coef = target > gain ? atk : rel;
    gain = target + (gain - target) * coef;
    out[i] = x * gain;
  }
  return out;
}

export function cleanVocal(
  signal: Float32Array,
  sampleRate: number,
  settings: DenoiseSettings,
): Float32Array {
  let out = signal;
  if (settings.enabled) out = spectralDenoise(out, settings.amount);
  if (settings.gateEnabled) {
    out = noiseGate(out, sampleRate, {
      thresholdDb: settings.thresholdDb,
      attackMs: settings.attackMs,
      releaseMs: settings.releaseMs,
      floorDb: settings.floorDb,
    });
  }
  return out;
}

/** Rough noise-floor estimate (dBFS) used to suggest a gate threshold. */
export function estimateNoiseFloorDb(signal: Float32Array, sampleRate: number) {
  const win = Math.max(256, Math.floor(sampleRate * 0.02));
  const rms: number[] = [];
  for (let pos = 0; pos + win <= signal.length; pos += win) {
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = signal[pos + i]!;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / win));
  }
  if (!rms.length) return -60;
  rms.sort((a, b) => a - b);
  const q = rms[Math.floor(rms.length * 0.1)] ?? 0;
  return Math.max(-90, 20 * Math.log10(Math.max(q, 1e-6)));
}
