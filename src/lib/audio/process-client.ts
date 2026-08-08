import type { Analysis } from "./analyze";
import { processVocal, type CorrectionSettings, type ProcessResult } from "./process";
import type { WorkerMessage } from "./process.worker";

/**
 * Runs the correction pipeline off the main thread so long takes don't freeze
 * the UI. Falls back to in-thread processing where workers aren't available.
 */

let worker: Worker | null = null;
let seq = 0;

function ensureWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./process.worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
  }
  return worker;
}

export function terminateProcessWorker() {
  worker?.terminate();
  worker = null;
}

export function runProcessVocal(
  vocal: Float32Array,
  sampleRate: number,
  analysis: Analysis | null,
  settings: CorrectionSettings,
  onProgress?: (label: string, pct: number) => void,
): Promise<ProcessResult> {
  const w = ensureWorker();
  if (!w) return processVocal(vocal, sampleRate, analysis, settings, onProgress);

  const id = ++seq;
  return new Promise<ProcessResult>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerMessage>) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.(msg.label, msg.pct);
        return;
      }
      cleanup();
      if (msg.type === "done") resolve(msg.result);
      else reject(new Error(msg.message));
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Audio worker failed"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage as EventListener);
      w.removeEventListener("error", onError as EventListener);
    };

    w.addEventListener("message", onMessage as EventListener);
    w.addEventListener("error", onError as EventListener);
    // copy: the caller keeps ownership of the raw take
    w.postMessage({ id, vocal: vocal.slice(), sampleRate, analysis, settings });
  });
}
