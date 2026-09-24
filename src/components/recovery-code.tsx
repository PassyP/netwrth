"use client";

import { useRef, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";

/**
 * Toont de herstelcode één keer, direct nadat hij is aangemaakt. Daarna is hij nergens meer op te vragen.
 * `onDone` wordt pas aangeroepen als de gebruiker bevestigt dat de code is opgeschreven.
 */
export function RecoveryCodeBox({ code, onDone, doneLabel = "Ik heb de code opgeschreven" }: { code: string; onDone: () => void; doneLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const codeRef = useRef<HTMLElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setManual(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // geen clipboard (http zonder https): selecteer de code, zodat kopiëren met het toetsenbord in één keer lukt
      const el = codeRef.current;
      const selection = window.getSelection();
      if (el && selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setManual(true);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-warn/40 bg-warn/10 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound size={16} className="text-warn" /> Je herstelcode — schrijf deze op
      </p>
      <p className="text-xs text-muted">Met deze code kun je een nieuw wachtwoord instellen als je het vergeet. Je ziet hem alleen nu; bewaar hem op een veilige plek (bijv. je wachtwoordmanager).</p>
      <p className="text-xs font-semibold text-down">Zonder wachtwoord én zonder deze code kom je nooit meer in de app en gaan al je gegevens verloren.</p>
      <div className="flex items-center gap-2">
        <code ref={codeRef} className="tnum flex-1 select-all rounded-xl bg-bg px-3 py-2.5 text-center font-mono text-base font-bold tracking-widest">
          {code}
        </code>
        <button type="button" onClick={() => void copy()} className="btn btn-ghost flex items-center gap-1 !py-2.5 text-xs" title="Kopiëren">
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Gekopieerd" : "Kopiëren"}
        </button>
      </div>
      {manual && (
        <p className="text-xs text-muted" aria-live="polite">
          Code geselecteerd; kopieer handmatig (Cmd/Ctrl+C).
        </p>
      )}
      <button type="button" onClick={onDone} className="btn w-full !py-2">
        {doneLabel}
      </button>
    </div>
  );
}
