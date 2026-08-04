/** Mixdown, effects and WAV export. */

export type MixSettings = {
  vocalGain: number; // 0..1.5
  instrumentalGain: number;
  reverb: number; // 0..1 wet
  eqLow: number; // dB
  eqMid: number;
  eqHigh: number;
};

export const DEFAULT_MIX: MixSettings = {
  vocalGain: 0.9,
  instrumentalGain: 0.8,
  reverb: 0.18,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 2,
};

export function monoToBuffer(ctx: BaseAudioContext, data: Float32Array, sampleRate: number) {
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

function makeImpulse(ctx: BaseAudioContext, seconds = 2.2, decay = 3) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const ch = impulse.getChannelData(c);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}

/** Builds the vocal processing chain (EQ -> reverb send) into a destination node. */
export function connectVocalChain(
  ctx: BaseAudioContext,
  source: AudioNode,
  destination: AudioNode,
  settings: MixSettings,
) {
  const low = ctx.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;
  low.gain.value = settings.eqLow;

  const mid = ctx.createBiquadFilter();
  mid.type = "peaking";
  mid.frequency.value = 1200;
  mid.Q.value = 0.9;
  mid.gain.value = settings.eqMid;

  const high = ctx.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 5000;
  high.gain.value = settings.eqHigh;

  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 90;

  const gain = ctx.createGain();
  gain.gain.value = settings.vocalGain;

  source.connect(hp);
  hp.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(gain);

  const dry = ctx.createGain();
  dry.gain.value = 1 - settings.reverb * 0.5;
  gain.connect(dry);
  dry.connect(destination);

  if (settings.reverb > 0.001) {
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = settings.reverb;
    gain.connect(convolver);
    convolver.connect(wet);
    wet.connect(destination);
  }
  return gain;
}

export async function renderMix(opts: {
  vocal: Float32Array | null;
  instrumental: AudioBuffer | null;
  sampleRate: number;
  settings: MixSettings;
  includeVocal?: boolean;
  includeInstrumental?: boolean;
}): Promise<AudioBuffer> {
  const {
    vocal,
    instrumental,
    sampleRate,
    settings,
    includeVocal = true,
    includeInstrumental = true,
  } = opts;
  const lengthSec = Math.max(
    instrumental && includeInstrumental ? instrumental.duration : 0,
    vocal && includeVocal ? vocal.length / sampleRate : 0,
    0.5,
  );
  const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * sampleRate) + sampleRate, sampleRate);

  if (instrumental && includeInstrumental) {
    const src = ctx.createBufferSource();
    src.buffer = instrumental;
    const g = ctx.createGain();
    g.gain.value = settings.instrumentalGain;
    src.connect(g);
    g.connect(ctx.destination);
    src.start(0);
  }
  if (vocal && includeVocal) {
    const src = ctx.createBufferSource();
    src.buffer = monoToBuffer(ctx, vocal, sampleRate);
    connectVocalChain(ctx, src, ctx.destination, settings);
    src.start(0);
  }
  return ctx.startRendering();
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const bytes = 44 + length * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, bytes - 8, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, length * channels * 2, true);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      let s = Math.max(-1, Math.min(1, data[c]![i]!));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
