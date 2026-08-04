type Props = {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  accent?: "primary" | "accent" | "vocal";
};

export function Fader({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  format,
  accent = "primary",
}: Props) {
  const pct = ((value - min) / (max - min)) * 100;
  const track =
    accent === "accent"
      ? "var(--accent)"
      : accent === "vocal"
        ? "var(--vocal)"
        : "var(--primary)";
  return (
    <label className="block select-none">
      <span className="mb-2 flex items-baseline justify-between gap-2">
        <span className="label-xs truncate">{label}</span>
        <span className="tabular text-xs font-semibold text-foreground">
          {format ? format(value) : Math.round(value * 100) + "%"}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-6 w-full cursor-pointer appearance-none rounded-full bg-transparent outline-none [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(0,0,0,0.35)]"
        style={
          {
            ["--fill" as string]: track,
            background: "transparent",
          } as React.CSSProperties
        }
        ref={(el) => {
          if (!el) return;
          el.style.setProperty(
            "--track",
            `linear-gradient(to right, ${track} ${pct}%, var(--muted) ${pct}%)`,
          );
        }}
      />
      <style>{`
        input[type="range"]::-webkit-slider-runnable-track { background: var(--track); }
        input[type="range"]::-moz-range-track { height: 6px; border-radius: 999px; background: var(--track); }
        input[type="range"]::-webkit-slider-thumb { background: var(--fill); }
        input[type="range"]::-moz-range-thumb { background: var(--fill); }
      `}</style>
    </label>
  );
}
