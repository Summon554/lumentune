import { createFileRoute } from "@tanstack/react-router";
import { StudioApp } from "@/components/studio/StudioApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VoxTune — Record, Tune & Mix Vocals in Your Browser" },
      {
        name: "description",
        content:
          "VoxTune detects tempo and key from your instrumental, records vocals with a beat-synced count-in, tunes pitch, aligns timing and exports a finished WAV mix.",
      },
      { property: "og:title", content: "VoxTune — Record, Tune & Mix Vocals in Your Browser" },
      {
        property: "og:description",
        content:
          "A mobile-first vocal studio: instrumental analysis, takes, pitch correction, beat alignment, mixing and WAV export.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: StudioApp,
});
