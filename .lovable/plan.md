# Vocal upload + auto-generated backing track, bug pass, security check

## 1. Upload a vocal (no mic needed)

Add an "Upload vocal" control next to "Record vocal". Accepts .mp3/.wav (any browser-decodable audio), decodes it, and adds it as a normal take so it flows through cleanup, pitch and timing correction, mixing and export exactly like a recorded take.

## 2. Auto instrumental from the raw vocal

When a take exists and there is no instrumental loaded, offer "Generate backing track". It:

- Analyses the vocal for tempo (onset envelope → BPM) and key (chroma → tonic/mode), reusing the existing analysis code rather than the instrumental-only path.
- Builds a backing track in that key and tempo, rendered offline to an audio buffer the same length as the vocal:
  - chord bed from a simple diatonic progression (I–V–vi–IV in major, i–VI–III–VII in minor) with soft synth pads plus a bass note per bar,
  - drums: kick on beats 1/3, snare on 2/4, closed hat on eighths,
  - light swing-free straight grid so the beat markers line up with the vocal's detected grid.
- Loads the result as the instrumental, so BPM/key/beat grid, waveform, mixing, A/B, and stem export all work unchanged.
- A small panel lets the user tweak BPM, key and style (pads / piano-ish / drums-only), and re-generate. A manually uploaded instrumental always wins; generation never overwrites one without confirmation.

No external AI service is used — the backing track is synthesised in-app, so it's instant, free, and offline.

## 3. Bug pass

Fixes for issues visible in the current studio code:

- Decoding an instrumental mutates the shared audio context while a take is playing; stop the transport before load and guard against overlapping loads.
- Analysis of a long file blocks the main thread — move instrumental/vocal analysis into the existing background worker alongside the correction pipeline, with a progress state.
- `duration` and the position clock use whichever source is longer, so the playhead can run past the shorter of the two; clamp seeking and the progress bar to the real timeline.
- Replacing the instrumental leaves stale beat markers and peaks on screen until analysis finishes; clear them on load.
- Failed decode leaves the "Analyzing" state consistent but keeps the previous instrumental name; reset name/peaks on failure.
- Guard generate/record/process so only one heavy job can run at a time (shared busy state), and disable the buttons while busy.
- Free the generated backing buffer when a new one replaces it.

## 4. Security

The backend scan currently reports no findings. As part of this change I'll re-run the security scan after the code changes and report anything new; storage/DB access stays user-scoped through the existing per-user policies, and generated audio is created in the browser (no new endpoints, no new secrets).

## Technical notes

- New `src/lib/audio/backing.ts`: `analyzeVocalForBacking(signal, sampleRate)` (tempo + key from `analyze.ts`) and `renderBacking({ bpm, tonic, mode, bars, style, sampleRate })` using `OfflineAudioContext` with oscillator/noise voices and envelope gains; returns an `AudioBuffer`.
- `StudioApp.tsx`: new `uploadVocal` handler (decode → `toMono` → push take), a "Backing track" panel wired to `loadInstrumental`-equivalent state setters, shared `busy` ref covering record/process/generate, transport stop on instrumental load, clamped `duration`/seek.
- Analysis moves behind `process-client.ts` style messaging so the worker handles `analyzeInstrumental` too.
