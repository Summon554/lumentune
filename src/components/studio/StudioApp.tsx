import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { Waveform } from "./Waveform";
import { Fader } from "./Fader";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { analyzeInstrumental, toMono, waveformPeaks, type Analysis } from "@/lib/audio/analyze";
import {
  DEFAULT_MIX,
  connectVocalChain,
  downloadBlob,
  encodeWav,
  monoToBuffer,
  renderMix,
  type MixSettings,
} from "@/lib/audio/mix";
import type { CorrectionSettings } from "@/lib/audio/process";
import { runProcessVocal, terminateProcessWorker } from "@/lib/audio/process-client";
import { DEFAULT_DENOISE, estimateNoiseFloorDb, type DenoiseSettings } from "@/lib/audio/denoise";
import { listProjects, uploadAudio, downloadAudio, deleteProject, type ProjectRow } from "@/lib/projects";

type Take = {
  id: string;
  name: string;
  data: Float32Array;
  sampleRate: number;
  peaks: Float32Array;
  duration: number;
  cleaned: Float32Array | null;
  cleanedPeaks: Float32Array | null;
  corrected: Float32Array | null;
  correctedPeaks: Float32Array | null;
  noiseFloorDb: number;
  onsets: number[];
  alignedOnsets: number[];
};

const PEAK_BUCKETS = 900;
let ctxSingleton: AudioContext | null = null;
function audioCtx() {
  if (!ctxSingleton) ctxSingleton = new AudioContext();
  return ctxSingleton;
}

export function StudioApp() {
  const { user, loading: authLoading } = useAuth();

  const [instrBuffer, setInstrBuffer] = useState<AudioBuffer | null>(null);
  const [instrPeaks, setInstrPeaks] = useState<Float32Array | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [instrName, setInstrName] = useState<string>("");
  const [analyzing, setAnalyzing] = useState(false);

  const [takes, setTakes] = useState<Take[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [metronome, setMetronome] = useState(true);
  const [offsetMs, setOffsetMs] = useState(0);

  const [denoise, setDenoise] = useState<DenoiseSettings>(DEFAULT_DENOISE);
  const [settings, setSettings] = useState<Omit<CorrectionSettings, "denoise">>({
    pitchStrength: 0.7,
    timingStrength: 0.4,
    subdivision: 2,
  });
  const [mix, setMix] = useState<MixSettings>(DEFAULT_MIX);
  const [ab, setAb] = useState<"original" | "cleaned" | "corrected">("corrected");

  const [processing, setProcessing] = useState<{ label: string; pct: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectName, setProjectName] = useState("Untitled session");

  const nodesRef = useRef<AudioNode[]>([]);
  const startRef = useRef<{ ctxTime: number; from: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startingRef = useRef(false);
  const processingRef = useRef(false);
  const lastRunRef = useRef<string | null>(null);
  const countdownIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const takeCounterRef = useRef(1);

  const active = takes.find((t) => t.id === activeId) ?? null;
  const beatPeriod = analysis && analysis.bpm > 0 ? 60 / analysis.bpm : 0.6;
  const duration = Math.max(instrBuffer?.duration ?? 0, active?.duration ?? 0);

  // what you hear (follows the A/B switch)
  const vocalForPlayback = useMemo(() => {
    if (!active) return null;
    if (ab === "corrected" && active.corrected) return active.corrected;
    if (ab === "cleaned" && active.cleaned) return active.cleaned;
    return active.data;
  }, [active, ab]);

  // what gets exported/saved: always the best rendition available
  const bestVocal = useMemo(() => {
    if (!active) return null;
    return active.corrected ?? active.cleaned ?? active.data;
  }, [active]);

  const vocalPeaks = useMemo(() => {
    if (!active) return null;
    if (ab === "corrected" && active.correctedPeaks) return active.correctedPeaks;
    if (ab === "cleaned" && active.cleanedPeaks) return active.cleanedPeaks;
    return active.peaks;
  }, [active, ab]);

  /* ---------------------------------------------------------------- transport */

  const stopNodes = useCallback(() => {
    for (const n of nodesRef.current) {
      try {
        (n as AudioBufferSourceNode).stop?.();
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* noop */
      }
    }
    nodesRef.current = [];
  }, []);

  const stop = useCallback(() => {
    stopNodes();
    startRef.current = null;
    setPlaying(false);
  }, [stopNodes]);

  const play = useCallback(
    (from = 0, opts?: { withVocal?: boolean; clickBeats?: number }) => {
      const ctx = audioCtx();
      void ctx.resume();
      stopNodes();
      const t0 = ctx.currentTime + 0.12;
      const withVocal = opts?.withVocal ?? true;

      if (instrBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = instrBuffer;
        const g = ctx.createGain();
        g.gain.value = mix.instrumentalGain;
        src.connect(g);
        g.connect(ctx.destination);
        src.start(t0, Math.min(from, instrBuffer.duration));
        nodesRef.current.push(src, g);
      }

      if (withVocal && vocalForPlayback && vocalForPlayback.length > 0 && active) {
        const off = offsetMs / 1000;
        const src = ctx.createBufferSource();
        src.buffer = monoToBuffer(ctx, vocalForPlayback, active.sampleRate);
        const g = connectVocalChain(ctx, src, ctx.destination, mix);
        const vocalStart = from - off;
        if (vocalStart >= 0) src.start(t0, Math.min(vocalStart, active.duration));
        else src.start(t0 - vocalStart, 0);
        nodesRef.current.push(src, g);
      }

      if (metronome && opts?.clickBeats && analysis) {
        for (let i = 0; i < opts.clickBeats; i++) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.frequency.value = i === 0 ? 1600 : 1100;
          const at = t0 + i * beatPeriod;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.35, at + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.09);
          nodesRef.current.push(osc, g);
        }
      }

      startRef.current = { ctxTime: t0, from };
      setPlaying(true);
    },
    [instrBuffer, mix, vocalForPlayback, active, offsetMs, metronome, analysis, beatPeriod, stopNodes],
  );

  // position clock only runs while something is actually playing
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const tick = () => {
      const s = startRef.current;
      if (s) {
        const p = audioCtx().currentTime - s.ctxTime + s.from;
        setPosition(Math.max(0, p));
        if (duration > 0 && p > duration + 0.4) stop();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, duration, stop]);

  // teardown: mic, recorder, transport, timers and the audio worker
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (countdownIvRef.current) clearInterval(countdownIvRef.current);
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.onstop = null;
          recorderRef.current.stop();
        }
      } catch {
        /* noop */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      stopNodes();
      terminateProcessWorker();
      void ctxSingleton?.close();
      ctxSingleton = null;
    };
  }, [stopNodes]);

  /* ------------------------------------------------------------- instrumental */

  const loadInstrumental = useCallback(
    async (file: File | Blob, name: string) => {
      if (loadingInstrRef.current) return;
      loadingInstrRef.current = true;
      stop();
      setAnalyzing(true);
      setInstrPeaks(null);
      setAnalysis(null);
      try {
        const ctx = audioCtx();
        const buf = await ctx.decodeAudioData(await file.arrayBuffer());
        const mono = toMono(buf);
        setInstrBuffer(buf);
        setInstrName(name);
        setInstrPeaks(waveformPeaks(mono, PEAK_BUCKETS));
        await new Promise((r) => setTimeout(r, 0));
        const a = analyzeInstrumental(mono, buf.sampleRate);
        setAnalysis(a);
        setGenerated(false);
        toast.success(`Detected ${a.bpm} BPM · ${a.key}`);
      } catch (err) {
        console.error(err);
        setInstrBuffer(null);
        setInstrName("");
        toast.error("Couldn't read that audio file");
      } finally {
        setAnalyzing(false);
        loadingInstrRef.current = false;
      }
    },
    [stop],
  );

  /* ----------------------------------------------------------------- takes in */

  const addTake = useCallback((mono: Float32Array, sampleRate: number, name: string) => {
    const take: Take = {
      id: crypto.randomUUID(),
      name,
      data: mono,
      sampleRate,
      peaks: waveformPeaks(mono, PEAK_BUCKETS),
      duration: mono.length / sampleRate,
      cleaned: null,
      cleanedPeaks: null,
      corrected: null,
      correctedPeaks: null,
      noiseFloorDb: estimateNoiseFloorDb(mono, sampleRate),
      onsets: [],
      alignedOnsets: [],
    };
    setDenoise((d) => ({ ...d, thresholdDb: Math.round(Math.min(-24, take.noiseFloorDb + 10)) }));
    setTakes((prev) => [...prev, take]);
    setActiveId(take.id);
    setAb("original");
    return take;
  }, []);

  const uploadVocal = useCallback(
    async (file: File) => {
      if (busy) return;
      setBusy("Loading vocal…");
      stop();
      try {
        const buf = await audioCtx().decodeAudioData(await file.arrayBuffer());
        const mono = toMono(buf);
        const take = addTake(mono, buf.sampleRate, file.name.replace(/\.[^.]+$/, "") || "Vocal");
        toast.success(`Loaded “${take.name}” — ${take.duration.toFixed(1)}s`);
      } catch (err) {
        console.error(err);
        toast.error("Couldn't read that vocal file");
      } finally {
        setBusy(null);
      }
    },
    [addTake, busy, stop],
  );

  /* --------------------------------------------------------- backing generator */

  const generateBacking = useCallback(
    async (override?: Partial<{ bpm: number; tonic: number; mode: "major" | "minor"; style: BackingStyle }>) => {
      if (!active) {
        toast.error("Record or upload a vocal first");
        return;
      }
      if (busy) return;
      if (instrBuffer && !generated) {
        const ok = window.confirm("Replace the uploaded instrumental with a generated one?");
        if (!ok) return;
      }
      setBusy("Writing a backing track…");
      stop();
      try {
        const guess =
          backing ?? analyzeVocalForBacking(active.data, active.sampleRate);
        if (!backing) setBacking(guess);

        const bpm = override?.bpm ?? backing?.bpm ?? guess.bpm;
        const tonic = override?.tonic ?? backing?.tonic ?? guess.tonic;
        const mode = override?.mode ?? backing?.mode ?? guess.mode;
        const style = override?.style ?? backingStyle;
        setBacking({ bpm, tonic, mode, key: `${NOTE_NAMES[tonic]} ${mode}` });
        setBackingStyle(style);

        const barLen = (60 / bpm) * 4;
        const bars = Math.max(2, Math.ceil(active.duration / barLen));
        const buf = await renderBacking({
          bpm,
          tonic,
          mode,
          bars,
          style,
          sampleRate: active.sampleRate,
        });
        const mono = toMono(buf);
        setInstrBuffer(buf);
        setInstrName(`Generated · ${NOTE_NAMES[tonic]} ${mode} · ${bpm} BPM`);
        setInstrPeaks(waveformPeaks(mono, PEAK_BUCKETS));
        setGenerated(true);

        const beats: number[] = [];
        const beatLen = 60 / bpm;
        for (let t = 0; t < buf.duration; t += beatLen) beats.push(t);
        setAnalysis({
          bpm,
          key: `${NOTE_NAMES[tonic]} ${mode}`,
          tonic,
          mode,
          beats,
          downbeats: beats.filter((_, i) => i % 4 === 0),
          duration: buf.duration,
          confidence: 1,
        });
        toast.success(`Backing track in ${NOTE_NAMES[tonic]} ${mode} at ${bpm} BPM`);
      } catch (err) {
        console.error(err);
        toast.error("Couldn't generate a backing track");
      } finally {
        setBusy(null);
      }
    },
    [active, backing, backingStyle, busy, generated, instrBuffer, stop],
  );


  /* ----------------------------------------------------------------- recording */

  /** Schedules the count-in clicks and the instrumental (delayed by the lead) in one pass. */
  const scheduleCountIn = useCallback(
    (leadBeats: number) => {
      const ctx = audioCtx();
      void ctx.resume();
      stopNodes();
      const t0 = ctx.currentTime + 0.15;
      const lead = leadBeats * beatPeriod;

      if (metronome) {
        for (let i = 0; i < leadBeats; i++) {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.frequency.value = i === 0 ? 1600 : 1100;
          const at = t0 + i * beatPeriod;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.35, at + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.09);
          nodesRef.current.push(osc, g);
        }
      }

      if (instrBuffer) {
        const src = ctx.createBufferSource();
        src.buffer = instrBuffer;
        const g = ctx.createGain();
        g.gain.value = mix.instrumentalGain;
        src.connect(g);
        g.connect(ctx.destination);
        src.start(t0 + lead, 0);
        nodesRef.current.push(src, g);
      }

      startRef.current = { ctxTime: t0 + lead, from: 0 };
      setPlaying(true);
      return { t0, lead };
    },
    [beatPeriod, instrBuffer, metronome, mix.instrumentalGain, stopNodes],
  );

  const startRecording = useCallback(async () => {
    if (recording || startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };

      const leadBeats = 4;
      // measured at rec.start(): how much audio precedes bar 1 in the capture
      let trimSeconds = leadBeats * beatPeriod;

      rec.onstop = async () => {
        // release the mic only once the recorder has handed over its last chunk
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setCountdown(null);
        stop();
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
          const mono = toMono(buf);
          const skip = Math.max(
            0,
            Math.min(mono.length, Math.floor(trimSeconds * buf.sampleRate)),
          );
          const trimmed = mono.slice(skip);
          const take: Take = {
            id: crypto.randomUUID(),
            name: `Take ${takeCounterRef.current++}`,
            data: trimmed,
            sampleRate: buf.sampleRate,
            peaks: waveformPeaks(trimmed, PEAK_BUCKETS),
            duration: trimmed.length / buf.sampleRate,
            cleaned: null,
            cleanedPeaks: null,
            corrected: null,
            correctedPeaks: null,
            noiseFloorDb: estimateNoiseFloorDb(trimmed, buf.sampleRate),
            onsets: [],
            alignedOnsets: [],
          };
          setDenoise((d) => ({
            ...d,
            thresholdDb: Math.round(Math.min(-24, take.noiseFloorDb + 10)),
          }));
          setTakes((prev) => [...prev, take]);
          setActiveId(take.id);
          toast.success("Take captured — tune it below");
        } catch (err) {
          console.error(err);
          toast.error("Couldn't decode that recording");
        }
      };

      // schedule audio first, then roll tape and measure the real offset
      const { t0, lead } = scheduleCountIn(leadBeats);
      rec.start();
      const recStart = audioCtx().currentTime;
      trimSeconds = Math.max(0, t0 + lead - recStart);
      setRecording(true);
      setCountdown(leadBeats);

      if (countdownIvRef.current) clearInterval(countdownIvRef.current);
      let remaining = leadBeats;
      countdownIvRef.current = setInterval(() => {
        remaining -= 1;
        setCountdown(remaining > 0 ? remaining : null);
        if (remaining <= 0 && countdownIvRef.current) {
          clearInterval(countdownIvRef.current);
          countdownIvRef.current = null;
        }
      }, beatPeriod * 1000);
    } catch (err) {
      console.error(err);
      toast.error("Microphone access denied");
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
      setCountdown(null);
    } finally {
      startingRef.current = false;
    }
  }, [recording, beatPeriod, scheduleCountIn, stop]);

  const stopRecording = useCallback(() => {
    // tracks are stopped inside rec.onstop so the final chunk isn't lost
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
    }
  }, []);

  /* ---------------------------------------------------------------- processing */

  const runCorrection = useCallback(async () => {
    if (!active || processingRef.current) return;
    const signature = JSON.stringify({
      id: active.id,
      settings,
      denoise,
      key: analysis?.key ?? null,
      bpm: analysis?.bpm ?? null,
    });
    if (active.corrected && lastRunRef.current === signature) {
      setAb("corrected");
      toast.info("Already tuned with these settings");
      return;
    }
    processingRef.current = true;
    stop();
    setProcessing({ label: "Starting", pct: 0 });
    try {
      const res = await runProcessVocal(
        active.data,
        active.sampleRate,
        analysis,
        { ...settings, denoise },
        (label: string, pct: number) => setProcessing({ label, pct }),
      );
      setTakes((prev) =>
        prev.map((t) =>
          t.id === active.id
            ? {
                ...t,
                cleaned: res.cleaned,
                cleanedPeaks: waveformPeaks(res.cleaned, PEAK_BUCKETS),
                corrected: res.corrected,
                correctedPeaks: waveformPeaks(res.corrected, PEAK_BUCKETS),
                onsets: res.onsets,
                alignedOnsets: res.correctedOnsets,
              }
            : t,
        ),
      );
      lastRunRef.current = signature;
      setAb("corrected");
      toast.success("Vocal tuned and aligned");
    } catch (err) {
      console.error(err);
      toast.error("Processing failed");
    } finally {
      processingRef.current = false;
      setProcessing(null);
    }
  }, [active, analysis, settings, denoise, stop]);

  /* -------------------------------------------------------------------- export */

  const exportAudio = useCallback(
    async (kind: "mix" | "vocal" | "instrumental") => {
      const sampleRate = active?.sampleRate ?? instrBuffer?.sampleRate ?? 44100;
      const vocal = bestVocal;
      if (kind === "vocal" && !vocal) {
        toast.error("No vocal to export");
        return;
      }
      if (kind === "instrumental" && !instrBuffer) {
        toast.error("No instrumental loaded");
        return;
      }
      setBusy("Rendering…");
      try {
        const rendered = await renderMix({
          vocal: kind === "instrumental" ? null : vocal,
          instrumental: kind === "vocal" ? null : instrBuffer,
          sampleRate,
          settings: mix,
          includeVocal: kind !== "instrumental",
          includeInstrumental: kind !== "vocal",
        });
        downloadBlob(encodeWav(rendered), `voxtune-${kind}.wav`);
      } catch (err) {
        console.error(err);
        toast.error("Export failed");
      } finally {
        setBusy(null);
      }
    },
    [active, instrBuffer, mix, bestVocal],
  );

  /* ------------------------------------------------------------------ projects */

  const refreshProjects = useCallback(async () => {
    if (!user) return;
    try {
      setProjects(await listProjects());
    } catch (err) {
      console.error(err);
    }
  }, [user]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  const saveProject = useCallback(async () => {
    if (!user) {
      toast.error("Sign in to save projects");
      return;
    }
    if (!instrBuffer && !active) {
      toast.error("Nothing to save yet");
      return;
    }
    setBusy("Saving…");
    try {
      const id = crypto.randomUUID();
      const sampleRate = active?.sampleRate ?? instrBuffer?.sampleRate ?? 44100;
      let instrumentalPath: string | null = null;
      let vocalPath: string | null = null;
      let mixPath: string | null = null;

      if (instrBuffer) {
        instrumentalPath = await uploadAudio(
          user.id,
          `${id}/instrumental.wav`,
          encodeWav(instrBuffer),
        );
      }
      if (bestVocal && active) {
        const ctx = new OfflineAudioContext(1, bestVocal.length, sampleRate);
        vocalPath = await uploadAudio(
          user.id,
          `${id}/vocal.wav`,
          encodeWav(monoToBuffer(ctx, bestVocal, sampleRate)),
        );
      }
      if (instrBuffer || bestVocal) {
        const rendered = await renderMix({
          vocal: bestVocal,
          instrumental: instrBuffer,
          sampleRate,
          settings: mix,
        });
        mixPath = await uploadAudio(user.id, `${id}/mix.wav`, encodeWav(rendered));
      }

      const { error } = await supabase.from("projects").insert({
        id,
        user_id: user.id,
        name: projectName || "Untitled session",
        bpm: analysis?.bpm ?? null,
        musical_key: analysis?.key ?? null,
        instrumental_path: instrumentalPath,
        vocal_path: vocalPath,
        mix_path: mixPath,
        settings: { ...settings, denoise, mix, offsetMs },
      });
      if (error) throw error;
      toast.success("Project saved");
      void refreshProjects();
    } catch (err) {
      console.error(err);
      toast.error("Couldn't save the project");
    } finally {
      setBusy(null);
    }
  }, [
    user,
    instrBuffer,
    active,
    bestVocal,
    mix,
    analysis,
    projectName,
    settings,
    denoise,
    offsetMs,
    refreshProjects,
  ]);

  const openProject = useCallback(
    async (p: ProjectRow) => {
      setBusy("Loading…");
      try {
        setProjectName(p.name);
        if (p.instrumental_path) {
          const blob = await downloadAudio(p.instrumental_path);
          await loadInstrumental(blob, p.name);
        }
        if (p.vocal_path) {
          const blob = await downloadAudio(p.vocal_path);
          const buf = await audioCtx().decodeAudioData(await blob.arrayBuffer());
          const mono = toMono(buf);
          const take: Take = {
            id: crypto.randomUUID(),
            name: "Saved vocal",
            data: mono,
            sampleRate: buf.sampleRate,
            peaks: waveformPeaks(mono, PEAK_BUCKETS),
            duration: buf.duration,
            cleaned: null,
            cleanedPeaks: null,
            corrected: null,
            correctedPeaks: null,
            noiseFloorDb: estimateNoiseFloorDb(mono, buf.sampleRate),
            onsets: [],
            alignedOnsets: [],
          };
          setTakes([take]);
          setActiveId(take.id);
          setAb("original");
        }
        toast.success(`Loaded “${p.name}”`);
      } catch (err) {
        console.error(err);
        toast.error("Couldn't load that project");
      } finally {
        setBusy(null);
      }
    },
    [loadInstrumental],
  );

  /* ---------------------------------------------------------------------- view */

  return (
    <main className="glow-bg min-h-screen pb-28">
      <div className="mx-auto w-full max-w-2xl px-4 pt-5">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-display text-2xl font-bold">
              Vox<span className="text-primary">Tune</span>
            </h1>
            <p className="truncate text-xs text-muted-foreground">
              Record · tune · align · mix — right in the browser
            </p>
          </div>
          {authLoading ? null : user ? (
            <button
              onClick={() => supabase.auth.signOut()}
              className="shrink-0 rounded-full border border-border px-3 py-2 text-xs font-semibold text-muted-foreground"
            >
              Sign out
            </button>
          ) : (
            <Link
              to="/auth"
              className="shrink-0 rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground"
            >
              Sign in
            </Link>
          )}
        </header>

        {/* 1 — instrumental */}
        <section className="panel mt-5 p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <p className="label-xs">01 · Instrumental</p>
              <p className="truncate text-sm font-semibold">
                {instrName || "No track loaded yet"}
              </p>
            </div>
            <label className="shrink-0 cursor-pointer rounded-full bg-secondary px-4 py-2 text-xs font-bold text-secondary-foreground">
              {instrBuffer ? "Replace" : "Upload"}
              <input
                type="file"
                accept="audio/mpeg,audio/wav,audio/*,.mp3,.wav"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadInstrumental(f, f.name);
                }}
              />
            </label>
          </div>

          <div className="mt-3">
            <Waveform
              peaks={instrPeaks}
              duration={instrBuffer?.duration ?? 0}
              position={position}
              beats={analysis?.beats ?? []}
              downbeats={analysis?.downbeats ?? []}
              onSeek={(t) => play(t)}
              height={80}
            />
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label="Tempo" value={analysis ? `${analysis.bpm}` : "—"} unit="BPM" />
            <Stat label="Key" value={analysis?.key ?? "—"} />
            <Stat
              label="Beats"
              value={analysis ? String(analysis.beats.length) : "—"}
              unit="grid"
            />
          </div>
          {analyzing && (
            <p className="mt-3 text-xs text-accent">Analysing tempo, key and beat grid…</p>
          )}
        </section>

        {/* 2 — record */}
        <section className="panel mt-4 p-4">
          <p className="label-xs">02 · Vocal takes</p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => (recording ? stopRecording() : void startRecording())}
              className={`grid h-16 w-16 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                recording ? "border-record bg-record/20" : "border-border bg-surface-raised"
              }`}
              aria-label={recording ? "Stop recording" : "Record vocal"}
            >
              <span
                className={`block rounded-full bg-record ${
                  recording ? "rec-dot h-5 w-5 rounded-sm" : "h-7 w-7"
                }`}
              />
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {countdown ? `Count-in ${countdown}…` : recording ? "Recording" : "Record vocal"}
              </p>
              <p className="text-xs text-muted-foreground">
                Use headphones. A 4-beat count-in rolls before bar 1.
              </p>
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={metronome}
                  onChange={(e) => setMetronome(e.target.checked)}
                  className="accent-primary"
                />
                Metronome click
              </label>
            </div>
          </div>

          {takes.length > 0 && (
            <div className="mt-4 space-y-2">
              {takes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3 py-2 text-left ${
                    t.id === activeId ? "border-primary bg-primary/10" : "border-border bg-background/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{t.name}</span>
                    <span className="tabular text-xs text-muted-foreground">
                      {t.duration.toFixed(1)}s {t.corrected ? "· tuned" : ""}
                    </span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTakes((prev) => prev.filter((x) => x.id !== t.id));
                      if (activeId === t.id) setActiveId(null);
                    }}
                    onKeyDown={() => {}}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    Delete
                  </span>
                </button>
              ))}
            </div>
          )}

          {active && (
            <div className="mt-3">
              <Waveform
                peaks={vocalPeaks}
                duration={active.duration}
                position={position - offsetMs / 1000}
                markers={ab === "corrected" ? active.alignedOnsets : active.onsets}
                color="vocal"
                height={64}
              />
              <div className="mt-3">
                <Fader
                  label="Sync offset"
                  value={offsetMs}
                  min={-200}
                  max={200}
                  step={5}
                  onChange={setOffsetMs}
                  format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)} ms`}
                  accent="accent"
                />
              </div>
            </div>
          )}
        </section>

        {/* 3 — noise cleanup */}
        <section className="panel mt-4 p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <p className="label-xs">03 · Noise cleanup</p>
              <p className="truncate text-sm font-semibold">Denoise &amp; gate</p>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={denoise.enabled}
                onChange={(e) => setDenoise((d) => ({ ...d, enabled: e.target.checked }))}
                className="accent-primary"
              />
              Denoise
            </label>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Runs before pitch and timing correction, so hiss and room tone don't confuse the
            tuner.
            {active ? ` Noise floor ≈ ${Math.round(active.noiseFloorDb)} dBFS.` : ""}
          </p>

          <div className="mt-4 space-y-4">
            <Fader
              label="Noise reduction"
              value={denoise.amount}
              onChange={(v) => setDenoise((d) => ({ ...d, amount: v }))}
              accent="accent"
            />

            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background/40 px-3 py-2">
              <span className="label-xs">Noise gate</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={denoise.gateEnabled}
                  onChange={(e) => setDenoise((d) => ({ ...d, gateEnabled: e.target.checked }))}
                  className="accent-primary"
                />
                {denoise.gateEnabled ? "On" : "Off"}
              </label>
            </div>

            {denoise.gateEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Fader
                  label="Gate threshold"
                  value={denoise.thresholdDb}
                  min={-80}
                  max={-10}
                  step={1}
                  onChange={(v) => setDenoise((d) => ({ ...d, thresholdDb: v }))}
                  format={(v) => `${Math.round(v)} dB`}
                  accent="vocal"
                />
                <Fader
                  label="Gate depth"
                  value={denoise.floorDb}
                  min={-60}
                  max={0}
                  step={1}
                  onChange={(v) => setDenoise((d) => ({ ...d, floorDb: v }))}
                  format={(v) => `${Math.round(v)} dB`}
                  accent="vocal"
                />
                <Fader
                  label="Attack"
                  value={denoise.attackMs}
                  min={1}
                  max={50}
                  step={1}
                  onChange={(v) => setDenoise((d) => ({ ...d, attackMs: v }))}
                  format={(v) => `${Math.round(v)} ms`}
                />
                <Fader
                  label="Release"
                  value={denoise.releaseMs}
                  min={20}
                  max={600}
                  step={10}
                  onChange={(v) => setDenoise((d) => ({ ...d, releaseMs: v }))}
                  format={(v) => `${Math.round(v)} ms`}
                />
              </div>
            )}
          </div>
        </section>

        {/* 4 — correction */}
        <section className="panel mt-4 p-4">
          <p className="label-xs">04 · Pitch &amp; timing</p>
          <div className="mt-3 space-y-4">
            <Fader
              label="Pitch correction strength"
              value={settings.pitchStrength}
              onChange={(v) => setSettings((s) => ({ ...s, pitchStrength: v }))}
            />
            <Fader
              label="Timing alignment strength"
              value={settings.timingStrength}
              onChange={(v) => setSettings((s) => ({ ...s, timingStrength: v }))}
              accent="accent"
            />
            <div>
              <p className="label-xs mb-2">Quantize grid</p>
              <div className="flex gap-2">
                {[1, 2, 4].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSettings((prev) => ({ ...prev, subdivision: s }))}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-bold ${
                      settings.subdivision === s
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    1/{s * 4}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={() => void runCorrection()}
            disabled={!active || !!processing}
            className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-40"
          >
            {processing ? `${processing.label}…` : "Tune this take"}
          </button>
          {processing && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.round(processing.pct * 100)}%` }}
              />
            </div>
          )}
          {active?.corrected && (
            <div className="mt-3 flex rounded-xl border border-border p-1">
              {(["original", "cleaned", "corrected"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setAb(k)}
                  className={`flex-1 rounded-lg px-2 py-2 text-xs font-bold ${
                    ab === k ? "bg-surface-raised text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {k === "original" ? "A · raw" : k === "cleaned" ? "B · clean" : "C · tuned"}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 5 — mix */}
        <section className="panel mt-4 p-4">
          <p className="label-xs">05 · Mix</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <Fader
              label="Vocal level"
              value={mix.vocalGain}
              max={1.5}
              onChange={(v) => setMix((m) => ({ ...m, vocalGain: v }))}
              format={(v) => `${Math.round(v * 100)}%`}
              accent="vocal"
            />
            <Fader
              label="Instrumental level"
              value={mix.instrumentalGain}
              max={1.5}
              onChange={(v) => setMix((m) => ({ ...m, instrumentalGain: v }))}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Fader
              label="Reverb"
              value={mix.reverb}
              onChange={(v) => setMix((m) => ({ ...m, reverb: v }))}
              accent="accent"
            />
            <Fader
              label="Air (high shelf)"
              value={mix.eqHigh}
              min={-8}
              max={8}
              step={0.5}
              onChange={(v) => setMix((m) => ({ ...m, eqHigh: v }))}
              format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
            />
            <Fader
              label="Body (low shelf)"
              value={mix.eqLow}
              min={-8}
              max={8}
              step={0.5}
              onChange={(v) => setMix((m) => ({ ...m, eqLow: v }))}
              format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
            />
            <Fader
              label="Presence (1.2k)"
              value={mix.eqMid}
              min={-8}
              max={8}
              step={0.5}
              onChange={(v) => setMix((m) => ({ ...m, eqMid: v }))}
              format={(v) => `${v > 0 ? "+" : ""}${v} dB`}
            />
          </div>
        </section>

        {/* 6 — export & projects */}
        <section className="panel mt-4 p-4">
          <p className="label-xs">06 · Export</p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <ExportButton onClick={() => void exportAudio("mix")} label="Full mix" primary />
            <ExportButton onClick={() => void exportAudio("vocal")} label="Vocal stem" />
            <ExportButton onClick={() => void exportAudio("instrumental")} label="Instr. stem" />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Exports render as 16-bit WAV at the session sample rate.
          </p>

          <div className="mt-5 border-t border-border pt-4">
            <p className="label-xs">Saved projects</p>
            {user ? (
              <>
                <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="min-w-0 rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => void saveProject()}
                    className="shrink-0 rounded-xl bg-secondary px-4 py-2 text-xs font-bold text-secondary-foreground"
                  >
                    Save
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-border bg-background/40 px-3 py-2"
                    >
                      <button onClick={() => void openProject(p)} className="min-w-0 text-left">
                        <span className="block truncate text-sm font-semibold">{p.name}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          {p.bpm ? `${p.bpm} BPM` : "—"} · {p.musical_key ?? "—"}
                        </span>
                      </button>
                      <button
                        onClick={async () => {
                          await deleteProject(p.id);
                          void refreshProjects();
                        }}
                        className="shrink-0 text-xs text-muted-foreground"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                  {projects.length === 0 && (
                    <p className="text-xs text-muted-foreground">Nothing saved yet.</p>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                <Link to="/auth" className="text-primary underline-offset-4 hover:underline">
                  Sign in
                </Link>{" "}
                to keep takes and mixes between sessions.
              </p>
            )}
          </div>
        </section>
      </div>

      {/* transport bar */}
      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto grid w-full max-w-2xl grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
          <button
            onClick={() => (playing ? stop() : play(0))}
            disabled={!instrBuffer && !active}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
            aria-label={playing ? "Stop" : "Play"}
          >
            {playing ? (
              <span className="h-3.5 w-3.5 rounded-[2px] bg-primary-foreground" />
            ) : (
              <span className="ml-0.5 h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-current" />
            )}
          </button>
          <div className="min-w-0">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: duration ? `${Math.min(100, (position / duration) * 100)}%` : "0%" }}
              />
            </div>
            <p className="tabular mt-1 text-[11px] text-muted-foreground">
              {fmt(position)} / {fmt(duration)}
              {busy ? ` · ${busy}` : ""}
            </p>
          </div>
          <span className="tabular shrink-0 text-xs font-bold text-primary">
            {analysis ? `${analysis.bpm} BPM` : "—"}
          </span>
        </div>
      </div>
    </main>
  );
}

function fmt(t: number) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 px-3 py-2">
      <p className="label-xs">{label}</p>
      <p className="tabular truncate text-base font-bold">
        {value}
        {unit ? <span className="ml-1 text-[10px] text-muted-foreground">{unit}</span> : null}
      </p>
    </div>
  );
}

function ExportButton({
  label,
  onClick,
  primary,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl px-3 py-3 text-xs font-bold ${
        primary
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-background/40 text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
