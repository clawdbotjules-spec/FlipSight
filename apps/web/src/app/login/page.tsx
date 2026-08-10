"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth";
import { LogoMark } from "@/components/icons";

function LoginForm() {
  const { ready, token, login, register } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") ?? "/";

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ready && token) router.replace(next);
  }, [ready, token, router, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, orgName || undefined);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-xl border border-acc/30 bg-acc/10 text-acc shadow-[0_0_28px_rgba(34,211,238,0.25)]">
            <LogoMark width={24} height={24} />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">FlipSight</h1>
            <p className="mt-0.5 text-[11px] tracking-[0.25em] text-faint uppercase">mission control</p>
          </div>
        </div>

        <form onSubmit={submit} className="glass space-y-4 p-6">
          <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-raise/60 p-1 text-center text-xs font-medium">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`cursor-pointer rounded px-2 py-1.5 transition-colors ${
                  mode === m ? "bg-acc/15 text-acc" : "text-muted hover:text-ink"
                }`}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@flipsight.dev"
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
            />
          </div>
          {mode === "register" && (
            <div>
              <label className="label" htmlFor="org">
                Org name <span className="normal-case opacity-60">(optional)</span>
              </label>
              <input
                id="org"
                className="field"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="My Flip Crew"
              />
            </div>
          )}

          {error && <p className="text-xs text-loss">{error}</p>}

          <button type="submit" disabled={busy} className="btn btn-acc w-full py-2">
            {busy ? "Authenticating…" : mode === "login" ? "Enter mission control" : "Create account"}
          </button>

          <p className="text-center text-[11px] text-faint">
            demo: <span className="num">demo@flipsight.dev</span> / <span className="num">flipsight-demo</span>
          </p>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
