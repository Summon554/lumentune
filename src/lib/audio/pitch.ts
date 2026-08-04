/** YIN fundamental frequency estimation + TD-PSOLA pitch correction. */

export type PitchTrack = {
  hop: number;
  sampleRate: number;
  f0: Float32Array; // 0 = unvoiced
  times: Float32Array;
};

const WINDOW = 2048;
const HOP = 256;

export function yinTrack(signal: Float32Array, sampleRate: number): PitchTrack {
  const minF = 65;
  const maxF = 1000;
  const tauMin = Math.floor(sampleRate / maxF);
  const tauMax = Math.min(WINDOW - 1, Math.floor(sampleRate / minF));
  const frames = Math.max(0, Math.floor((signal.length - WINDOW) / HOP) + 1);
  const f0 = new Float32Array(frames);
  const times = new Float32Array(frames);
  const diff = new Float32Array(tauMax + 1);
  const cmnd = new Float32Array(tauMax + 1);

  for (let fi = 0; fi < frames; fi++) {
    const off = fi * HOP;
    times[fi] = (off + WINDOW / 2) / sampleRate;

    let energy = 0;
    for (let i = 0; i < WINDOW; i++) energy += signal[off + i]! * signal[off + i]!;
    if (energy / WINDOW < 1e-6) {
      f0[fi] = 0;
      continue;
    }

    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = 0; i < WINDOW - tauMax; i++) {
        const d = signal[off + i]! - signal[off + i + tau]!;
        sum += d * d;
      }
      diff[tau] = sum;
    }
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += diff[tau]!;
      cmnd[tau] = running === 0 ? 1 : (diff[tau]! * tau) / running;
    }

    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau]! < 0.15) {
        while (tau + 1 <= tauMax && cmnd[tau + 1]! < cmnd[tau]!) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst < 0) {
      let best = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau]! < cmnd[best]!) best = tau;
      if (cmnd[best]! < 0.35) tauEst = best;
    }
    if (tauEst < 0) {
      f0[fi] = 0;
      continue;
    }
    // parabolic refinement
    const x0 = Math.max(1, tauEst - 1);
    const x2 = Math.min(tauMax, tauEst + 1);
    const s0 = cmnd[x0]!;
    const s1 = cmnd[tauEst]!;
    const s2 = cmnd[x2]!;
    const denom = 2 * (2 * s1 - s2 - s0);
    const shift = denom !== 0 ? (s2 - s0) / denom : 0;
    f0[fi] = sampleRate / (tauEst + shift);
  }
  return { hop: HOP, sampleRate, f0, times };
}

export function hzToMidi(hz: number) {
  return 69 + 12 * Math.log2(hz / 440);
}
export function midiToHz(m: number) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Nearest midi note that belongs to the given pitch-class set. */
export function snapToScale(midi: number, pitchClasses: number[]) {
  let best = midi;
  let bestDist = Infinity;
  const base = Math.round(midi);
  for (let cand = base - 2; cand <= base + 2; cand++) {
    const pc = ((cand % 12) + 12) % 12;
    if (!pitchClasses.includes(pc)) continue;
    const d = Math.abs(cand - midi);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

/** Build the target f0 curve for a pitch track given a key and correction strength. */
export function targetContour(track: PitchTrack, pitchClasses: number[], strength: number) {
  const out = new Float32Array(track.f0.length);
  for (let i = 0; i < track.f0.length; i++) {
    const f = track.f0[i]!;
    if (f <= 0) {
      out[i] = 0;
      continue;
    }
    const midi = hzToMidi(f);
    const snapped = snapToScale(midi, pitchClasses);
    out[i] = midiToHz(midi + (snapped - midi) * strength);
  }
  return out;
}

function f0At(track: PitchTrack, sample: number) {
  const idx = Math.round((sample - WINDOW / 2) / track.hop);
  if (idx < 0 || idx >= track.f0.length) return 0;
  return track.f0[idx]!;
}

/**
 * Time-domain PSOLA pitch shifting with a per-sample ratio derived from
 * the measured contour vs the target contour. Length is preserved.
 */
export function psolaCorrect(
  signal: Float32Array,
  track: PitchTrack,
  target: Float32Array,
): Float32Array {
  const sr = track.sampleRate;
  const out = new Float32Array(signal.length);
  const norm = new Float32Array(signal.length);

  // 1. Analysis pitch marks following the measured f0.
  const marks: number[] = [];
  let pos = 0;
  while (pos < signal.length) {
    marks.push(Math.round(pos));
    const f = f0At(track, pos);
    const period = f > 0 ? sr / f : sr / 200;
    // snap to the nearest local energy peak inside a small search window
    if (f > 0) {
      const search = Math.max(2, Math.round(period * 0.15));
      let bestIdx = Math.round(pos);
      let bestVal = -Infinity;
      for (let i = bestIdx - search; i <= bestIdx + search; i++) {
        if (i < 0 || i >= signal.length) continue;
        const v = Math.abs(signal[i]!);
        if (v > bestVal) {
          bestVal = v;
          bestIdx = i;
        }
      }
      marks[marks.length - 1] = bestIdx;
      pos = bestIdx + period;
    } else {
      pos += period;
    }
  }
  if (marks.length < 3) return signal.slice();

  // 2. Synthesis: walk output timeline, pick nearest analysis mark, copy grain.
  let outPos = marks[0]!;
  let mi = 0;
  while (outPos < signal.length) {
    // nearest analysis mark to the current output position
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1]! - outPos) < Math.abs(marks[mi]! - outPos))
      mi++;
    const center = marks[mi]!;
    const idx = Math.round((center - WINDOW / 2) / track.hop);
    const measured = idx >= 0 && idx < track.f0.length ? track.f0[idx]! : 0;
    const wanted = idx >= 0 && idx < target.length ? target[idx]! : 0;

    const analysisPeriod = measured > 0 ? sr / measured : sr / 200;
    const ratio = measured > 0 && wanted > 0 ? wanted / measured : 1;
    const synthPeriod = Math.max(8, analysisPeriod / ratio);

    const grain = Math.round(analysisPeriod);
    for (let k = -grain; k <= grain; k++) {
      const src = center + k;
      const dst = Math.round(outPos + k);
      if (src < 0 || src >= signal.length || dst < 0 || dst >= out.length) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / grain);
      out[dst] = out[dst]! + signal[src]! * w;
      norm[dst] = norm[dst]! + w;
    }
    outPos += synthPeriod;
  }

  for (let i = 0; i < out.length; i++) {
    const n = norm[i]!;
    out[i] = n > 0.15 ? out[i]! / n : signal[i]! * 0.0;
  }
  return out;
}
