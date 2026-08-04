// Minimal iterative radix-2 FFT (in-place, complex).
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
      t = im[i]!;
      im[i] = im[j]!;
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function hann(size: number) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/** Magnitude spectrogram: returns frames of (fftSize/2) bins. */
export function spectrogram(signal: Float32Array, fftSize: number, hop: number) {
  const win = hann(fftSize);
  const frames: Float32Array[] = [];
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let pos = 0; pos + fftSize <= signal.length; pos += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = signal[pos + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mags = new Float32Array(fftSize / 2);
    for (let i = 0; i < fftSize / 2; i++) mags[i] = Math.hypot(re[i]!, im[i]!);
    frames.push(mags);
  }
  return frames;
}
