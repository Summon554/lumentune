# Vocal Studio Mobile

Build a mobile-responsive web app called "VoxTune" (or any name) for independent musicians to record vocals, correct pitch/timing, and mix with an instrumental — for personal music production and release.



1. INSTRUMENTAL INPUT

   - "Upload Instrumental" button (accept .mp3, .wav)

   - Auto-detect and display: tempo (BPM), musical key, and beat grid/downbeats of the uploaded instrumental

   - Waveform visualization of the instrumental track



2. VOCAL RECORDING

   - "Record Vocal" button using MediaRecorder API (browser mic access)

   - Play the instrumental in the user's headphones/earbuds WHILE recording (metronome click optional) so they can sing along in real time

   - Show a countdown (3-2-1) before recording starts, synced to the beat

   - Allow multiple takes, keep best one or layer harmonies



3. PITCH CORRECTION

   - Analyze the recorded vocal's pitch contour (fundamental frequency detection, e.g. using YIN or CREPE algorithm)

   - Detect the key/scale from the instrumental (from step 1) and snap the vocal's pitch to the nearest correct note in that key

   - Add an adjustable "Correction Strength" slider (0-100%): low = natural/subtle correction, high = strong/robotic "auto-tune" effect

   - Real-time or near-real-time preview of corrected vocal



4. BEAT/TIMING ALIGNMENT

   - Detect the beat grid of the instrumental (using beat tracking, e.g. librosa.beat or essentia)

   - Analyze the vocal's onset timing (where syllables/notes start)

   - Time-stretch/quantize vocal onsets to align closer to the nearest beat subdivision (adjustable strength slider similar to pitch correction, so it doesn't sound robotic if not wanted)



5. MIXING & PREVIEW

   - Playback of corrected vocal + instrumental together, synced

   - Volume balance sliders for vocal vs instrumental

   - Basic EQ/reverb controls for the vocal (optional, nice-to-have)

   - A/B toggle to compare original vs corrected vocal



6. EXPORT

   - Download final mixed track as high-quality .wav or .mp3 (44.1kHz/16-bit minimum)

   - Option to export vocal-only (corrected) and instrumental-only stems separately



7. TECH STACK

   - Frontend: React + Tailwind, Web Audio API for recording/playback/waveform display

   - Backend: Python (FastAPI or Flask) for audio processing — use librosa for tempo/key/beat detection, and a pitch correction library or custom PSOLA/WORLD vocoder implementation for pitch shifting

   - Audio processing can run server-side (upload recorded vocal, process, return corrected file) since phone browsers have limited real-time DSP capability

   - Storage: Supabase Storage for temporary audio files during processing



Design: clean, modern, dark-themed UI like a mobile music production app. Mobile-first layout since primary use case is on phone. Show waveforms and beat markers visually so the user can see where corrections are being applied.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://lumentune.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/a3fd8996-9eaf-4a4b-b3cc-7e1ffcf95f89).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
