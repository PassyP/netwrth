"use client";

/**
 * Bouwstenen van de instellingen, samengesteld uit de bestaande tokens en klassen (.card, .pill, .btn, .input): geen
 * nieuwe visuele stijl. Eén opslaanpatroon: directe keuzes slaan op bij wijzigen, vrije invoer bij blur of Enter (en
 * alleen bij een echte wijziging), met inline "Opgeslagen" of een foutmelding bij het veld zelf.
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronRight, CircleCheck, CircleX, Download, Info, KeyRound, LoaderCircle, XCircle } from "lucide-react";
import { Modal } from "../ui";
import { describeInterval, formatNextRun, INTERVAL_PRESETS, intervalCron, nextRun, presetLabel } from "@/lib/schedule";
import { getDisplayTimeZone } from "@/lib/format";

// ---------------------------------------------------------------------------------------------------------------------
// Rijen en opslaanstatus

export type SaveStatus = { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string } | null;

/** Onder de control: "Opgeslagen" (2 s), "Opslaan…" of de foutmelding van het veld. */
export function SaveState({ status, className = "" }: { status: SaveStatus; className?: string }) {
  return (
    <span aria-live="polite" className={`min-h-0 text-xs ${className}`}>
      {status?.kind === "saved" && (
        <span className="inline-flex items-center gap-1 text-up">
          <Check size={13} /> Opgeslagen
        </span>
      )}
      {status?.kind === "saving" && <span className="text-muted">Opslaan…</span>}
      {status?.kind === "error" && <span className="text-down">{status.message}</span>}
    </span>
  );
}

/** Rijen in een kaart, met een lijn ertussen. */
export function SettingRows({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`divide-y divide-border ${className}`}>{children}</div>;
}

/**
 * Eén instelling: label en beschrijving van één regel links, de control rechts in een vaste kolom (zodat alle controls
 * op één lijn staan). Op smalle schermen onder elkaar; een schakelaar (`inline`) blijft naast het label staan.
 */
export function SettingRow({ label, description, badge, children, inline = false, id }: { label: React.ReactNode; description?: React.ReactNode; badge?: React.ReactNode; children: React.ReactNode; inline?: boolean; id?: string }) {
  return (
    <div id={id} className={`grid gap-2 py-3 first:pt-1 last:pb-1 ${id ? "scroll-mt-20 lg:scroll-mt-8" : ""} ${inline ? "grid-cols-[minmax(0,1fr)_auto] items-center gap-3" : "items-start sm:grid-cols-[minmax(0,1fr)_18rem] sm:gap-4"}`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
          {label}
          {badge}
        </div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      <div className={`flex min-w-0 flex-col gap-1.5 ${inline ? "items-end" : ""}`}>{children}</div>
    </div>
  );
}

/** Alleen-lezen feit in een kaart ("Portfolio: Mijn portfolio"). */
export function FactRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2.5 text-sm first:pt-1 last:pb-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Controls

export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full border transition-colors before:absolute before:-inset-[6px] before:content-[''] disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "border-accent bg-accent" : "border-border bg-bg-elev"}`}
    >
      <span className={`absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-text transition-transform motion-reduce:transition-none ${checked ? "translate-x-4" : ""}`} />
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

/** Twee of drie korte opties als .pill-rij in een rail (zoals de valuta-toggle); op mobiel over de volle breedte. */
export function Segmented<T extends string>({ value, options, onChange, label, full = true }: { value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; label: string; full?: boolean }) {
  return (
    <div role="group" aria-label={label} className={`flex gap-0.5 rounded-full border border-border bg-bg-elev p-0.5 ${full ? "w-full" : "w-fit"}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`pill min-w-0 flex-1 truncate !px-2.5 text-center disabled:cursor-not-allowed disabled:opacity-40 ${full ? "" : "flex-none"}`}
          data-active={value === o.value}
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => value !== o.value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Vrije invoer die opslaat bij blur of Enter, alleen als de waarde verschilt van de opgeslagen waarde. `validate`
 * geeft een foutmelding of null; Esc zet de opgeslagen waarde terug. `onCommit` geeft null (gelukt) of een melding.
 */
export function CommitInput({
  value,
  onCommit,
  validate,
  label,
  type = "text",
  placeholder,
  inputMode,
  className = "",
  after,
  autoFocus,
}: {
  value: string;
  onCommit: (v: string) => Promise<string | null>;
  validate?: (v: string) => string | null;
  label: string;
  type?: string;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  className?: string;
  after?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<SaveStatus>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committing = useRef(false);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const commit = async () => {
    const v = type === "text" || type === "url" ? draft.trim() : draft;
    if (committing.current || v === value) {
      if (status?.kind === "error" && v === value) setStatus(null);
      return;
    }
    const err = validate?.(v) ?? null;
    if (err) {
      setStatus({ kind: "error", message: err });
      return;
    }
    committing.current = true;
    setStatus({ kind: "saving" });
    const serverErr = await onCommit(v);
    committing.current = false;
    if (serverErr) {
      setStatus({ kind: "error", message: serverErr });
      return;
    }
    setStatus({ kind: "saved" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2000);
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <input
          className={`input min-w-0 flex-1 ${status?.kind === "error" ? "!border-down" : ""} ${className}`}
          aria-label={label}
          aria-invalid={status?.kind === "error"}
          type={type}
          inputMode={inputMode}
          placeholder={placeholder}
          spellCheck={false}
          autoFocus={autoFocus}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (status?.kind === "error") setStatus(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              setDraft(value);
              setStatus(null);
            }
          }}
        />
        {after}
      </div>
      <SaveState status={status} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Status en meldingen

export type Tone = "ok" | "warn" | "down" | "neutral";

const BADGE_TONES: Record<Tone, string> = {
  ok: "bg-up-soft text-up",
  warn: "bg-warn/10 text-warn",
  down: "bg-down-soft text-down",
  neutral: "border border-border text-muted",
};

/** Statuslabel in de stijl van de bestaande providerbadge: IN ORDE, LET OP, FOUT, HANDMATIG, DIT APPARAAT. */
export function StatusBadge({ tone, children, dot = false, className = "" }: { tone: Tone; children: React.ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase leading-4 tracking-wide ${BADGE_TONES[tone]} ${className}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Stip in de navigatie: amber bij "let op", rood bij kritiek. */
export function StatusDot({ level, className = "" }: { level: "warn" | "critical" | null | undefined; className?: string }) {
  if (!level) return null;
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${level === "critical" ? "bg-down" : "bg-warn"} ${className}`} aria-label={level === "critical" ? "actie nodig" : "let op"} role="img" />;
}

const CALLOUT_TONES = {
  warn: { box: "border-warn/40 bg-warn/10", icon: <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" /> },
  down: { box: "border-down/30 bg-down-soft", icon: <XCircle size={14} className="mt-0.5 shrink-0 text-down" /> },
  ok: { box: "border-up/40 bg-up-soft", icon: <CircleCheck size={14} className="mt-0.5 shrink-0 text-up" /> },
  info: { box: "border-border bg-bg-elev", icon: <Info size={14} className="mt-0.5 shrink-0 text-muted" /> },
  key: { box: "border-warn/40 bg-warn/10", icon: <KeyRound size={14} className="mt-0.5 shrink-0 text-warn" /> },
} as const;

/** Kader voor een actuele waarschuwing, fout of bevestiging (niet voor vaste uitleg: die hoort in een Disclosure). */
export function Callout({ tone, children, className = "" }: { tone: keyof typeof CALLOUT_TONES; children: React.ReactNode; className?: string }) {
  const t = CALLOUT_TONES[tone];
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed ${t.box} ${className}`}>
      {t.icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export type TestResult = { ok: boolean; message: string } | { busy: true; message: string } | null;

/** Resultaat van een test (keys, node, testmelding) direct onder de knop. */
export function InlineResult({ result }: { result: TestResult }) {
  if (!result) return null;
  if ("busy" in result)
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
        <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" /> {result.message}
      </p>
    );
  return (
    <p className={`flex items-start gap-1.5 text-xs ${result.ok ? "text-up" : "text-down"}`} aria-live="polite">
      {result.ok ? <CircleCheck size={13} className="mt-0.5 shrink-0" /> : <CircleX size={13} className="mt-0.5 shrink-0" />}
      <span className="min-w-0">{result.message}</span>
    </p>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Disclosure, gevarenzone en lijstrijen

/** Uitleg of geavanceerde opties op verzoek (native details). */
export function Disclosure({ summary, children, defaultOpen = false, className = "" }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; className?: string }) {
  // alleen de beginstand: een later herladen mag een disclosure die de gebruiker open- of dichtklapte niet omgooien
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) ref.current.open = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <details ref={ref} className={`group ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 py-1 text-xs font-semibold text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="space-y-2 pb-1 pl-[18px] pt-1 text-xs leading-relaxed text-muted [&_b]:text-text">{children}</div>
    </details>
  );
}

/** Onomkeerbare acties, ingeklapt onderaan een pagina. Rood (btn-danger) komt alleen hier en in dialogen voor. */
export function DangerZone({ children, summary = "Gevarenzone" }: { children: React.ReactNode; summary?: string }) {
  return (
    <details className="group rounded-2xl border border-down/30 px-4 sm:px-5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-sm font-semibold text-down [&::-webkit-details-marker]:hidden">
        <ChevronRight size={15} className="transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="divide-y divide-border pb-2">{children}</div>
    </details>
  );
}

/**
 * Rij in een lijst die naar een detail leidt: de naam is de link en beslaat de hele rij (stretched link); `trailing`
 * (hooguit één secundaire knop) ligt erboven. Nooit rode knoppen in een lijst.
 */
export function ListRow({ href, title, meta, extra, leading, trailing, badges }: { href: string; title: React.ReactNode; meta?: React.ReactNode; extra?: React.ReactNode; leading?: React.ReactNode; trailing?: React.ReactNode; badges?: React.ReactNode }) {
  return (
    <li className="relative flex min-h-14 items-center gap-3 rounded-xl bg-bg-elev px-3 py-2.5 transition-colors hover:bg-card-hover">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={href} className="font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">
            {title}
          </Link>
          {badges}
        </div>
        {meta && <div className="text-xs text-muted">{meta}</div>}
        {extra}
      </div>
      {trailing && <div className="relative z-10 flex shrink-0 items-center gap-1">{trailing}</div>}
      <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bevestiging

/** Knop die direct de database-back-up downloadt, met de herinnering aan secret.key. */
export function BackupHint({ secretHint = "Bewaar ook secret.key uit de datamap (of je APP_SECRET); zonder die sleutel zijn keys en xpubs na herstel onleesbaar." }: { secretHint?: string }) {
  return (
    <Callout tone="key">
      <p>{secretHint}</p>
      <a href="/api/backup" className="mt-1 inline-flex items-center gap-1 font-semibold text-accent" download>
        <Download size={12} /> Eerst back-up downloaden
      </a>
    </Callout>
  );
}

/**
 * Bevestiging op de bestaande Modal (vervangt window.confirm): de titel is de actie, de gevolgen staan in de body, en
 * Annuleren annuleert altijd. Op mobiel een bottom-sheet met de knoppen onder elkaar, de rode actie los van Annuleren.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  tone = "primary",
  onConfirm,
  onClose,
  confirmDisabled = false,
  backup = false,
}: {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  confirmDisabled?: boolean;
  backup?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title={title}>
      <div className="space-y-3 text-sm">
        {children}
        {backup && <BackupHint />}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Annuleren
          </button>
          <button type="button" className={`btn ${tone === "danger" ? "btn-danger mb-3 sm:mb-0" : ""}`} onClick={() => void run()} disabled={busy || confirmDisabled}>
            {busy ? "Bezig…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Interval

/**
 * Interval in minuten als keuzelijst met presets die precies op de worker aansluiten. Een andere opgeslagen waarde
 * (uit een oudere versie of de API) blijft staan als "Aangepast" met wat de worker ervan maakt; "Aangepast…" opent een
 * getalveld. Toont "Volgende: hh:mm" in de tijdzone van de planning.
 */
export function IntervalSelect({ value, onChange, label, timeZone }: { value: number; onChange: (minutes: number) => Promise<string | null>; label: string; timeZone?: string }) {
  const id = useId();
  const [custom, setCustom] = useState(false);
  const [status, setStatus] = useState<SaveStatus>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const presets = INTERVAL_PRESETS as readonly number[];
  const isPreset = presets.includes(value);
  const d = describeInterval(value);
  const cron = intervalCron(value);
  const tz = timeZone ?? getDisplayTimeZone();
  const now = new Date();
  const next = cron ? nextRun(cron, now, tz) : null;

  const save = async (m: number) => {
    if (m === value) return;
    setStatus({ kind: "saving" });
    const err = await onChange(m);
    if (err) return setStatus({ kind: "error", message: err });
    setStatus({ kind: "saved" });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), 2000);
  };

  return (
    <>
      <select
        id={id}
        className="input"
        aria-label={label}
        value={custom ? "custom" : isPreset ? String(value) : "current"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "custom") return setCustom(true);
          setCustom(false);
          if (v !== "current") void save(Number(v));
        }}
      >
        {presets.map((m) => (
          <option key={m} value={m}>
            {presetLabel(m)}
          </option>
        ))}
        {!isPreset && <option value="current">{d.label}</option>}
        <option value="custom">Aangepast…</option>
      </select>
      {custom && (
        <CommitInput
          label={`${label} in minuten`}
          type="number"
          inputMode="numeric"
          value={String(value)}
          autoFocus
          validate={(v) => (/^\d+$/.test(v) && Number(v) <= 1440 ? null : "Een geheel aantal minuten van 0 tot 1440")}
          onCommit={async (v) => {
            const err = await onChange(Number(v));
            if (!err) setCustom(false);
            return err;
          }}
        />
      )}
      <span className="text-xs text-muted">
        {d.note ? `${d.note[0].toUpperCase()}${d.note.slice(1)}. ` : ""}
        {next ? `Volgende: ${formatNextRun(next, now, tz)}` : "Alleen bij de dagelijkse ronde en de knop Verversen"}
      </span>
      <SaveState status={status} />
    </>
  );
}
