import { useEffect, useRef } from "react";

type Props = {
  peaks: Float32Array | null;
  duration: number;
  position?: number;
  beats?: number[];
  downbeats?: number[];
  markers?: number[];
  color?: "primary" | "vocal" | "accent";
  height?: number;
  onSeek?: (time: number) => void;
};

const COLOR_VAR: Record<string, string> = {
  primary: "--primary",
  vocal: "--vocal",
  accent: "--accent",
};

export function Waveform({
  peaks,
  duration,
  position = 0,
  beats = [],
  downbeats = [],
  markers = [],
  color = "primary",
  height = 72,
  onSeek,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(document.documentElement);
    const main = styles.getPropertyValue(COLOR_VAR[color] ?? "--primary").trim();
    const beatColor = styles.getPropertyValue("--beat").trim();
    const muted = styles.getPropertyValue("--muted").trim();

    // grid
    if (duration > 0) {
      ctx.lineWidth = 1;
      for (const b of beats) {
        const x = (b / duration) * w;
        ctx.strokeStyle = `color-mix(in oklab, ${beatColor} 22%, transparent)`;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (const b of downbeats) {
        const x = (b / duration) * w;
        ctx.strokeStyle = `color-mix(in oklab, ${beatColor} 55%, transparent)`;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // waveform
    if (peaks && peaks.length) {
      const mid = h / 2;
      const barW = Math.max(1, w / peaks.length);
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / peaks.length) * w;
        const amp = Math.min(1, peaks[i]! * 1.35) * (h / 2 - 3);
        const played = duration > 0 && (i / peaks.length) * duration <= position;
        ctx.fillStyle = played ? main : `color-mix(in oklab, ${main} 42%, ${muted})`;
        ctx.fillRect(x, mid - amp, Math.max(1, barW - 0.6), amp * 2 || 1);
      }
    } else {
      ctx.strokeStyle = `color-mix(in oklab, ${muted} 90%, transparent)`;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    }

    // onset markers
    for (const m of markers) {
      if (duration <= 0) break;
      const x = (m / duration) * w;
      ctx.fillStyle = styles.getPropertyValue("--accent").trim();
      ctx.fillRect(x - 0.75, 0, 1.5, 6);
      ctx.fillRect(x - 0.75, h - 6, 1.5, 6);
    }

    // playhead
    if (duration > 0 && position > 0) {
      const x = (position / duration) * w;
      ctx.strokeStyle = styles.getPropertyValue("--foreground").trim();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [peaks, duration, position, beats, downbeats, markers, color, height]);

  return (
    <canvas
      ref={ref}
      onClick={(e) => {
        if (!onSeek || duration <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}
      style={{ height }}
      className="w-full cursor-pointer rounded-lg bg-background/40"
    />
  );
}
