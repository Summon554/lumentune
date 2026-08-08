/// <reference lib="webworker" />
import type { Analysis } from "./analyze";
import { processVocal, type CorrectionSettings, type ProcessResult } from "./process";

type Request = {
  id: number;
  vocal: Float32Array;
  sampleRate: number;
  analysis: Analysis | null;
  settings: CorrectionSettings;
};

export type WorkerMessage =
  | { id: number; type: "progress"; label: string; pct: number }
  | { id: number; type: "done"; result: ProcessResult }
  | { id: number; type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<Request>) => {
  const { id, vocal, sampleRate, analysis, settings } = event.data;
  try {
    const result = await processVocal(vocal, sampleRate, analysis, settings, (label, pct) => {
      ctx.postMessage({ id, type: "progress", label, pct } satisfies WorkerMessage);
    });
    ctx.postMessage({ id, type: "done", result } satisfies WorkerMessage);
  } catch (err) {
    ctx.postMessage({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerMessage);
  }
};
