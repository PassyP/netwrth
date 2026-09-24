"use client";

import { useState } from "react";
import { LogIn, Lock, Check, KeyRound, ArrowLeft } from "lucide-react";
import { RecoveryCodeBox } from "./recovery-code";

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? "Er ging iets mis");
  return j as T;
}

/** Wordt door de layout getoond in plaats van de app zolang er geen geldige login is. */
export function LoginScreen() {
  const [mode, setMode] = useState<"login" | "forgot">("login");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const login = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    void run(async () => {
      await post("/api/auth/login", { password, remember });
      window.location.reload();
    });
  };

  const recover = (e: React.FormEvent) => {
    e.preventDefault();
    if (next.length < 6) return setError("Nieuw wachtwoord moet minimaal 6 tekens hebben");
    if (next !== repeat) return setError("De wachtwoorden zijn niet gelijk");
    void run(async () => {
      const r = await post<{ recoveryCode: string }>("/api/auth/recover", { code, next });
      setRecoveryCode(r.recoveryCode); // nieuwe code tonen; pas daarna de app laden
      setBusy(false);
    });
  };

  const switchMode = (m: "login" | "forgot") => {
    setMode(m);
    setError(null);
  };

  const errorBox = error && (
    <p className="rounded-xl border border-down/30 bg-down-soft px-3 py-2 text-sm text-down" role="alert">
      {error}
    </p>
  );

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="card w-full max-w-sm p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">{mode === "login" ? <Lock size={26} /> : <KeyRound size={26} />}</div>
          <h1 className="text-xl font-extrabold tracking-tight">Netwrth</h1>
          <p className="mt-1 text-sm text-muted">{mode === "login" ? "Voer je wachtwoord in om verder te gaan." : "Stel met je herstelcode een nieuw wachtwoord in."}</p>
        </div>

        {recoveryCode ? (
          <RecoveryCodeBox code={recoveryCode} onDone={() => window.location.reload()} doneLabel="Opgeschreven, naar de app" />
        ) : mode === "login" ? (
          <form onSubmit={login} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Wachtwoord</span>
              <input className="input" type="password" autoFocus autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </label>

            <label className="flex cursor-pointer items-center gap-2.5 text-sm select-none">
              <input type="checkbox" className="peer sr-only" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
              <span className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-bg-elev text-white transition peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50">
                {remember && <Check size={14} strokeWidth={3} />}
              </span>
              <span>
                Ingelogd blijven <span className="text-muted">(90 dagen)</span>
              </span>
            </label>

            {errorBox}

            <button type="submit" className="btn flex w-full items-center justify-center gap-2 !py-2.5" disabled={!password || busy}>
              <LogIn size={16} /> {busy ? "Bezig…" : "Inloggen"}
            </button>

            <button type="button" onClick={() => switchMode("forgot")} className="block w-full text-center text-xs text-muted hover:text-text">
              Wachtwoord vergeten?
            </button>
          </form>
        ) : (
          <form onSubmit={recover} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Herstelcode</span>
              <input className="input font-mono uppercase tracking-widest" autoFocus autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Nieuw wachtwoord</span>
              <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Herhaal wachtwoord</span>
              <input className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} disabled={busy} />
            </label>

            {errorBox}

            <button type="submit" className="btn flex w-full items-center justify-center gap-2 !py-2.5" disabled={!code || !next || !repeat || busy}>
              <KeyRound size={16} /> {busy ? "Bezig…" : "Nieuw wachtwoord instellen"}
            </button>

            <button type="button" onClick={() => switchMode("login")} className="flex w-full items-center justify-center gap-1 text-xs text-muted hover:text-text">
              <ArrowLeft size={12} /> Terug naar inloggen
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
