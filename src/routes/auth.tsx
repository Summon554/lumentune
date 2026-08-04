import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — VoxTune Vocal Studio" },
      {
        name: "description",
        content: "Sign in to VoxTune to save your takes, tuned vocals and mixes.",
      },
      { property: "og:title", content: "Sign in — VoxTune Vocal Studio" },
      {
        property: "og:description",
        content: "Sign in to VoxTune to save your takes, tuned vocals and mixes.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success("Check your inbox to confirm your email.");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      navigate({ to: "/" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      toast.error("Google sign-in failed");
      return;
    }
    if (result.redirected) return;
    navigate({ to: "/" });
  };

  return (
    <main className="glow-bg flex min-h-screen flex-col items-center justify-center px-5 py-12">
      <Link to="/" className="mb-8 font-display text-2xl font-bold tracking-tight">
        Vox<span className="text-primary">Tune</span>
      </Link>
      <div className="panel w-full max-w-sm p-6">
        <h1 className="text-xl font-semibold">
          {mode === "signin" ? "Welcome back" : "Create your studio"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Save takes, tuned vocals and mixes across sessions.
        </p>

        <button
          type="button"
          onClick={google}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm font-semibold transition-colors hover:bg-muted"
        >
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="label-xs">or email</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            className="w-full rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none focus:border-primary"
          />
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-opacity disabled:opacity-60"
          >
            {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          {mode === "signin" ? "No account yet? Sign up" : "Already have an account? Sign in"}
        </button>
      </div>
      <Link to="/" className="mt-6 text-xs text-muted-foreground hover:text-foreground">
        Continue without saving →
      </Link>
    </main>
  );
}
