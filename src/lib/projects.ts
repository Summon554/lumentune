import { supabase } from "@/integrations/supabase/client";

export type ProjectRow = {
  id: string;
  name: string;
  bpm: number | null;
  musical_key: string | null;
  instrumental_path: string | null;
  vocal_path: string | null;
  mix_path: string | null;
  settings: unknown;
  created_at: string;
};

export async function listProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProjectRow[];
}

export async function uploadAudio(userId: string, path: string, blob: Blob) {
  const full = `${userId}/${path}`;
  const { error } = await supabase.storage
    .from("audio")
    .upload(full, blob, { upsert: true, contentType: "audio/wav" });
  if (error) throw error;
  return full;
}

export async function downloadAudio(path: string) {
  const { data, error } = await supabase.storage.from("audio").download(path);
  if (error) throw error;
  return data;
}

export async function deleteProject(id: string) {
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw error;
}
