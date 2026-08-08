# VoxTune — stability pass, efficiency pass, new app icon

Three parts: fix the real bugs found in the studio code, make the heavy audio work stop freezing the UI, and ship a proper mic + waveform app icon.

## 1. Bugs to fix

**Count-in schedules the clicks twice.** Starting a recording plays a 4-count, then immediately re-schedules another 4-count and restarts the transport a fraction of a second later. Result: doubled/flammed clicks and a count-in that doesn't line up with bar 1. Fix by scheduling the count-in and the delayed instrumental once, in a single pass.

**Recorded vocals can drift out of time.** The take is trimmed by a fixed "4 beats" amount, assuming the recorder started at the exact instant the audio clock did. It doesn't — mic startup latency varies by device, which is why a take can sit slightly early or late. Fix by timestamping the actual recorder start against the audio clock and trimming by the measured offset instead of the assumed one.

**Stopping a recording can clip the last moment.** The mic tracks are stopped before the recorder has handed over its final chunk. Fix by stopping tracks only after the recorder finishes.

**Export and Save follow the A/B switch.** If you're auditioning the raw take and hit "Export vocal" or "Save", you silently get the untuned version. Fix so export/save always use the corrected take when one exists (with the A/B toggle staying a listening control only).

**Nothing is cleaned up when you leave the page.** The mic stream, recorder, animation loop and audio engine keep running. Fix with proper teardown on unmount, and release the mic as soon as a take is captured.

**The playback clock runs nonstop.** The position animation loop runs every frame even when nothing is playing — wasted battery on phones. Fix by running it only during playback.

**Take list hygiene.** Deleting a take, or recording many, should free its audio buffers rather than holding every version of every take in memory for the session.

## 2. Efficiency

- Move denoise, pitch tracking, correction and timing alignment into a background worker so the UI, waveforms and progress bar stay responsive on long takes instead of locking up mid-process.
- Reuse a single audio engine and cache waveform peak data instead of recomputing on each toggle.
- Skip re-processing when nothing changed since the last run.
- Guard against processing/recording being triggered twice at once.

## 3. App icon

Generate a mic + waveform mark in the app's dark palette, install it as the favicon and app icon, and remove the default placeholder icon.

## Technical notes

- `StudioApp.tsx`: single-pass count-in scheduler, recorder-start timestamp from `AudioContext.currentTime`, `onstop`-ordered track teardown, unmount cleanup effect, RAF gated on `playing`, export/save read the corrected buffer directly.
- New `src/lib/audio/process.worker.ts` wrapping `processVocal`, with progress posted back via `postMessage`; component talks to it through a small hook and terminates it on unmount.
- Icon generated to `public/favicon.png` (square, padded), referenced from `__root.tsx` `head().links`; delete `public/favicon.ico`.
