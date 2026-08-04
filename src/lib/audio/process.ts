import type { Analysis } from "./analyze";
import { detectOnsets, scalePitchClasses } from "./analyze";
import { psolaCorrect, targetContour, yinTrack, type PitchTrack } from "./pitch";
import { buildTimingAnchors, warpSignal } from "./timing";
import { cleanVocal, type DenoiseSettings } from "./denoise";

export type CorrectionSettings = {
  pitchStrength: number; // 0..1
  timingStrength: number; // 0..1
  subdivision: number; // 1,2,4
  denoise: DenoiseSettings;
};

export type ProcessResult = {
  cleaned: Float32Array;
  corrected: Float32Array;
  track: PitchTrack;
  target: Float32Array;
  onsets: number[];
  correctedOnsets: number[];
};

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export async function processVocal(
  vocal: Float32Array,
  sampleRate: number,
  analysis: Analysis | null,
  settings: CorrectionSettings,
  onProgress?: (label: string, pct: number) => void,
): Promise<ProcessResult> {
  onProgress?.("Cleaning up noise", 0.03);
  await yieldToUi();
  const cleaned = cleanVocal(vocal, sampleRate, settings.denoise);

  onProgress?.("Tracking pitch", 0.2);
  await yieldToUi();
  const track = yinTrack(cleaned, sampleRate);

  onProgress?.("Snapping to key", 0.45);
  await yieldToUi();
  const pcs = analysis
    ? scalePitchClasses(analysis.tonic, analysis.mode)
    : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const target = targetContour(track, pcs, settings.pitchStrength);

  onProgress?.("Correcting pitch", 0.55);
  await yieldToUi();
  let corrected =
    settings.pitchStrength > 0.001 ? psolaCorrect(cleaned, track, target) : cleaned.slice();

  onProgress?.("Finding syllables", 0.75);
  await yieldToUi();
  const onsets = detectOnsets(cleaned, sampleRate);

  let correctedOnsets = onsets;
  if (analysis && settings.timingStrength > 0.001 && analysis.beats.length > 1) {
    onProgress?.("Aligning to the grid", 0.85);
    await yieldToUi();
    const anchors = buildTimingAnchors(
      onsets,
      analysis.beats,
      settings.subdivision,
      settings.timingStrength,
      cleaned.length / sampleRate,
    );
    corrected = warpSignal(corrected, sampleRate, anchors);
    correctedOnsets = anchors.slice(1, -1).map((a) => a.to);
  }

  onProgress?.("Done", 1);
  return { cleaned, corrected, track, target, onsets, correctedOnsets };
}
