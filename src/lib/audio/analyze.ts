import { spectrogram } from "./fft";

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

export type Analysis = {
  bpm: number;
  key: string;
  tonic: number; // 0-11
  mode: "major" | "minor";
  beats: number[]; // seconds
  downbeats: number[]; // seconds
  duration: number;
  confidence: number;
};

export function toMono(buffer: AudioBuffer): Float32Array {
  const len = buffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) + (d[i] ?? 0);
  }
  const g = 1 / Math.max(1, buffer.numberOfChannels);
  for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) * g;
  return out;
}

/** Peak envelope for waveform drawing. */
export function waveformPeaks(signal: Float32Array, buckets: number) {
  const peaks = new Float32Array(buckets);
  const size = Math.max(1, Math.floor(signal.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    const end = Math.min(signal.length, start + size);
    for (let i = start; i < end; i++) {
      const v = Math.abs(signal[i]!);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}

const FFT_SIZE = 1024;
const HOP = 512;

/** Spectral-flux onset strength envelope. */
export function onsetEnvelope(signal: Float32Array, sampleRate: number) {
  const frames = spectrogram(signal, FFT_SIZE, HOP);
  const env = new Float32Array(frames.length);
  for (let f = 1; f < frames.length; f++) {
    let flux = 0;
    const cur = frames[f]!;
    const prev = frames[f - 1]!;
    for (let b = 0; b < cur.length; b++) {
      const d = Math.log1p(cur[b]! * 40) - Math.log1p(prev[b]! * 40);
      if (d > 0) flux += d;
    }
    env[f] = flux;
  }
  // normalise + subtract local mean
  const out = new Float32Array(env.length);
  const w = 12;
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j < Math.min(env.length, i + w); j++) {
      sum += env[j]!;
      n++;
    }
    out[i] = Math.max(0, env[i]! - sum / Math.max(1, n));
  }
  return { env: out, frameRate: sampleRate / HOP };
}

function detectTempo(env: Float32Array, frameRate: number) {
  const minBpm = 70;
  const maxBpm = 180;
  const minLag = Math.floor((60 / maxBpm) * frameRate);
  const maxLag = Math.ceil((60 / minBpm) * frameRate);
  let best = { bpm: 120, score: 0, lag: minLag };
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < env.length; i++) sum += env[i]! * env[i + lag]!;
    // reinforce with the 2x lag (helps avoid half/double errors)
    let sum2 = 0;
    const lag2 = lag * 2;
    for (let i = 0; i + lag2 < env.length; i++) sum2 += env[i]! * env[i + lag2]!;
    const score = sum + 0.5 * sum2;
    if (score > best.score) best = { bpm: (60 * frameRate) / lag, score, lag };
  }
  return best;
}

function detectBeats(env: Float32Array, frameRate: number, bpm: number) {
  const period = (60 / bpm) * frameRate;
  let bestPhase = 0;
  let bestScore = -1;
  for (let phase = 0; phase < period; phase += 0.25) {
    let score = 0;
    for (let t = phase; t < env.length; t += period) {
      const i = Math.round(t);
      if (i < env.length) score += env[i]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < env.length; t += period) beats.push(t / frameRate);
  return beats;
}

// Krumhansl-Schmuckler profiles
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export function chromaVector(signal: Float32Array, sampleRate: number) {
  const size = 4096;
  const frames = spectrogram(signal, size, 2048);
  const chroma = new Float64Array(12);
  for (const mags of frames) {
    for (let b = 2; b < mags.length; b++) {
      const freq = (b * sampleRate) / size;
      if (freq < 55 || freq > 2000) continue;
      const midi = 69 + 12 * Math.log2(freq / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      chroma[pc] += mags[b]! * mags[b]!;
    }
  }
  const max = Math.max(...chroma);
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] = chroma[i]! / max;
  return chroma;
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

export function detectKey(chroma: Float64Array) {
  let best = { tonic: 0, mode: "major" as "major" | "minor", score: -2 };
  for (let t = 0; t < 12; t++) {
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(i + t) % 12]!;
    const maj = corr(rotated, MAJOR);
    const min = corr(rotated, MINOR);
    if (maj > best.score) best = { tonic: t, mode: "major", score: maj };
    if (min > best.score) best = { tonic: t, mode: "minor", score: min };
  }
  return best;
}

export function scalePitchClasses(tonic: number, mode: "major" | "minor") {
  const steps = mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return steps.map((s) => (tonic + s) % 12);
}

export function analyzeInstrumental(signal: Float32Array, sampleRate: number): Analysis {
  const { env, frameRate } = onsetEnvelope(signal, sampleRate);
  const tempo = detectTempo(env, frameRate);
  const bpm = Math.round(tempo.bpm * 10) / 10;
  const beats = detectBeats(env, frameRate, bpm);
  const chroma = chromaVector(signal, sampleRate);
  const key = detectKey(chroma);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  return {
    bpm,
    key: `${NOTE_NAMES[key.tonic]} ${key.mode}`,
    tonic: key.tonic,
    mode: key.mode,
    beats,
    downbeats,
    duration: signal.length / sampleRate,
    confidence: Math.max(0, Math.min(1, key.score)),
  };
}

/** Vocal onset times (seconds) via spectral flux peak picking. */
export function detectOnsets(signal: Float32Array, sampleRate: number) {
  const { env, frameRate } = onsetEnvelope(signal, sampleRate);
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i]!;
  mean /= Math.max(1, env.length);
  const threshold = mean * 1.6;
  const onsets: number[] = [];
  let lastIndex = -Infinity;
  const minGap = frameRate * 0.09;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i]! > threshold && env[i]! >= env[i - 1]! && env[i]! > env[i + 1]!) {
      if (i - lastIndex >= minGap) {
        onsets.push(i / frameRate);
        lastIndex = i;
      }
    }
  }
  return onsets;
}
