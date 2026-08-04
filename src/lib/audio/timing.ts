/** WSOLA-style variable-rate time warping used for beat/timing alignment. */

export type WarpAnchor = { from: number; to: number }; // seconds

/**
 * Snap vocal onsets toward the nearest beat subdivision.
 * Returns warp anchors mapping original time -> aligned time.
 */
export function buildTimingAnchors(
  onsets: number[],
  beats: number[],
  subdivision: number,
  strength: number,
  duration: number,
): WarpAnchor[] {
  if (!beats.length || !onsets.length || strength <= 0) {
    return [
      { from: 0, to: 0 },
      { from: duration, to: duration },
    ];
  }
  const grid: number[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const a = beats[i]!;
    const b = beats[i + 1]!;
    for (let s = 0; s < subdivision; s++) grid.push(a + ((b - a) * s) / subdivision);
  }
  grid.push(beats[beats.length - 1]!);

  const anchors: WarpAnchor[] = [{ from: 0, to: 0 }];
  const maxShift = 0.12;
  for (const onset of onsets) {
    let nearest = grid[0]!;
    let dist = Infinity;
    for (const g of grid) {
      const d = Math.abs(g - onset);
      if (d < dist) {
        dist = d;
        nearest = g;
      }
    }
    if (dist > maxShift) continue;
    const to = onset + (nearest - onset) * strength;
    const prev = anchors[anchors.length - 1]!;
    if (onset - prev.from < 0.05 || to - prev.to < 0.05) continue;
    anchors.push({ from: onset, to });
  }
  anchors.push({ from: duration, to: duration + (anchors[anchors.length - 1]!.to - anchors[anchors.length - 1]!.from) });
  return anchors;
}

function sourceTimeFor(outTime: number, anchors: WarpAnchor[]) {
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (outTime >= a.to && outTime <= b.to) {
      const span = b.to - a.to;
      const t = span > 0 ? (outTime - a.to) / span : 0;
      return a.from + t * (b.from - a.from);
    }
  }
  return outTime;
}

/** Pitch-preserving overlap-add resynthesis along the warp map. */
export function warpSignal(
  signal: Float32Array,
  sampleRate: number,
  anchors: WarpAnchor[],
): Float32Array {
  const outLen = Math.max(
    signal.length,
    Math.ceil(anchors[anchors.length - 1]!.to * sampleRate) + sampleRate,
  );
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const frame = 1024;
  const hop = frame / 2;
  const search = 220;

  let prevSrc = 0;
  for (let outPos = 0; outPos + frame < outLen; outPos += hop) {
    const desired = Math.round(sourceTimeFor(outPos / sampleRate, anchors) * sampleRate);
    let bestOffset = 0;
    if (outPos > 0) {
      // correlate against what was already written to avoid phase clicks
      let bestScore = -Infinity;
      for (let off = -search; off <= search; off += 4) {
        const src = desired + off;
        if (src < 0 || src + hop >= signal.length) continue;
        let score = 0;
        for (let i = 0; i < hop; i += 4) score += out[outPos + i]! * signal[src + i]!;
        if (score > bestScore) {
          bestScore = score;
          bestOffset = off;
        }
      }
    }
    const src = Math.max(0, Math.min(signal.length - frame - 1, desired + bestOffset));
    prevSrc = src;
    for (let i = 0; i < frame; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
      const s = signal[src + i];
      if (s === undefined) break;
      out[outPos + i] = out[outPos + i]! + s * w;
      norm[outPos + i] = norm[outPos + i]! + w;
    }
  }
  void prevSrc;
  for (let i = 0; i < outLen; i++) if (norm[i]! > 0.1) out[i] = out[i]! / norm[i]!;
  return out;
}
