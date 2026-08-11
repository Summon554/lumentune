import { NOTE_NAMES, chromaVector, detectKey, onsetEnvelope } from "./analyze";

export type BackingStyle = "pads" | "keys" | "drums";

export type BackingSpec = {
  bpm: number;
  tonic: number; // 0-11
  mode: "major" | "minor";
  bars: number;
  style: BackingStyle;
  sampleRate: number;
};

export type VocalMusicGuess = {
  bpm: number;
  tonic: number;
  mode: "major" | "minor";
  key: string;
};

/** Tempo + key guess taken straight from a dry vocal take. */
export function analyzeVocalForBacking(
  signal: Float32Array,
  sampleRate: number,
): VocalMusicGuess {
  const { env, frameRate } = onsetEnvelope(signal, sampleRate);

  // autocorrelation over a singable tempo range
  const minBpm = 70;
  const maxBpm = 160;
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * frameRate));
  const maxLag = Math.max(minLag + 1, Math.ceil((60 / minBpm) * frameRate));
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < env.length; i++) sum += env[i]! * env[i + lag]!;
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  const raw = (60 * frameRate) / bestLag;
  const bpm = Math.round(Math.max(70, Math.min(160, raw)));

  const key = detectKey(chromaVector(signal, sampleRate));
  return {
    bpm,
    tonic: key.tonic,
    mode: key.mode,
    key: `${NOTE_NAMES[key.tonic]} ${key.mode}`,
  };
}

const MAJOR_PROG = [0, 7, 9, 5]; // I  V  vi  IV (semitones from tonic)
const MINOR_PROG = [0, 8, 3, 10]; // i  VI  III  VII
const MAJOR_QUALITY = ["major", "major", "minor", "major"] as const;
const MINOR_QUALITY = ["minor", "major", "major", "major"] as const;

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function chordMidis(root: number, quality: "major" | "minor") {
  const third = quality === "major" ? 4 : 3;
  return [root, root + third, root + 7, root + 12];
}

function tone(
  ctx: OfflineAudioContext,
  type: OscillatorType,
  freq: number,
  at: number,
  dur: number,
  peak: number,
  attack = 0.02,
) {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function kick(ctx: OfflineAudioContext, at: number) {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(140, at);
  osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.9, at + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.32);
}

function noiseHit(
  ctx: OfflineAudioContext,
  at: number,
  dur: number,
  peak: number,
  highpass: number,
) {
  const len = Math.max(1, Math.floor(dur * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = highpass;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(at);
  src.stop(at + dur + 0.01);
}

/** Synthesises a simple diatonic backing track in the given key and tempo. */
export async function renderBacking(spec: BackingSpec): Promise<AudioBuffer> {
  const { bpm, tonic, mode, style } = spec;
  const beat = 60 / Math.max(40, bpm);
  const bars = Math.max(1, Math.min(400, Math.round(spec.bars)));
  const barLen = beat * 4;
  const total = bars * barLen + 1.2;
  const sampleRate = Math.max(8000, spec.sampleRate || 44100);
  const ctx = new OfflineAudioContext(1, Math.ceil(total * sampleRate), sampleRate);

  const prog = mode === "major" ? MAJOR_PROG : MINOR_PROG;
  const quality = mode === "major" ? MAJOR_QUALITY : MINOR_QUALITY;
  const rootBase = 48 + tonic; // C3-ish register

  for (let bar = 0; bar < bars; bar++) {
    const barAt = bar * barLen;
    const step = bar % prog.length;
    const root = rootBase + prog[step]!;
    const chord = chordMidis(root, quality[step]!);

    if (style !== "drums") {
      // bass on the downbeat + the 3
      tone(ctx, "triangle", midiToHz(root - 12), barAt, beat * 1.9, 0.28, 0.01);
      tone(ctx, "triangle", midiToHz(root - 12), barAt + beat * 2, beat * 1.9, 0.22, 0.01);

      if (style === "pads") {
        for (const m of chord) {
          tone(ctx, "sine", midiToHz(m), barAt, barLen * 0.95, 0.1, barLen * 0.25);
          tone(ctx, "triangle", midiToHz(m), barAt, barLen * 0.95, 0.05, barLen * 0.3);
        }
      } else {
        // "keys": plucked chord stabs on every beat
        for (let b = 0; b < 4; b++) {
          const at = barAt + b * beat;
          const gain = b % 2 === 0 ? 0.13 : 0.09;
          for (const m of chord) tone(ctx, "triangle", midiToHz(m), at, beat * 0.85, gain, 0.008);
        }
      }
    }

    // drums
    for (let b = 0; b < 4; b++) {
      const at = barAt + b * beat;
      if (b === 0 || b === 2) kick(ctx, at);
      if (b === 1 || b === 3) noiseHit(ctx, at, 0.18, 0.35, 1200);
      noiseHit(ctx, at, 0.05, 0.09, 6000);
      noiseHit(ctx, at + beat / 2, 0.04, 0.06, 6000);
    }
  }

  return ctx.startRendering();
}
