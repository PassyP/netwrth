"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell, BellOff, Plus, Trash2, RotateCcw } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Card, Empty, Skeleton, Modal, Field, useFormat } from "./ui";
import { AssetSearch, type SelectedAsset } from "./asset-search";
import { formatDate } from "@/lib/format";
import { describeInterval } from "@/lib/schedule";

interface AlertRow {
  id: number;
  assetId: number;
  asset: { symbol: string; name: string } | null;
  condition: string;
  threshold: string;
  currency: string;
  status: string;
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: string | null;
}

interface Notification {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export function AlertsPage() {
  const { bump, toast } = useApp();
  const fmt = useFormat();
  const { data: alerts } = useApi<AlertRow[]>("/api/alerts");
  const { data: notifications, reload } = useApi<Notification[]>("/api/notifications");
  const { data: settings } = useApi<{ settings: { priceRefreshMinutes: number } }>("/api/settings");
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    if (notifications?.some((n) => !n.readAt)) {
      void api("/api/notifications", { method: "POST" }).then(() => {
        reload();
        bump();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications?.length]);

  const setStatus = async (id: number, status: "active" | "off") => {
    await api(`/api/alerts/${id}`, { method: "PATCH", json: { status } });
    bump();
  };
  // het koersinterval zoals ingesteld ("elk uur", "elke 15 min"), zodat de uitleg klopt met de planning
  const refreshLabel = settings ? lowerFirst(describeInterval(settings.settings.priceRefreshMinutes).label) : null;

  const del = async (id: number) => {
    if (!confirm("Alert verwijderen?")) return;
    await api(`/api/alerts/${id}`, { method: "DELETE" });
    toast("Alert verwijderd");
    bump();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-extrabold">Alerts</h1>
        <button className="btn flex items-center gap-1 !py-1.5 text-xs" onClick={() => setShowNew(true)}>
          <Plus size={14} /> Nieuwe alert
        </button>
      </div>

      {!alerts ? (
        <Skeleton className="h-32" />
      ) : alerts.length === 0 ? (
        <Empty title="Nog geen alerts">
          <p>
            Stel een koersdrempel in per asset. Je krijgt een melding bij elke koersronde ({refreshLabel ? `${refreshLabel}, ` : ""}instelbaar onder{" "}
            <Link href="/settings/koersen#planning" className="text-accent hover:underline">
              Instellingen → Koersen en planning
            </Link>
            ) of na een klik op Verversen.
          </p>
          <button className="btn mt-3 inline-flex items-center gap-1 !py-1.5 text-xs" onClick={() => setShowNew(true)}>
            <Plus size={14} /> Eerste alert instellen
          </button>
        </Empty>
      ) : (
        <Card flush>
          <ul>
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
                <span className={`rounded-full p-2 ${a.status === "active" ? "bg-accent-soft text-accent" : a.status === "triggered" ? "bg-up-soft text-up" : "bg-bg-elev text-muted"}`}>{a.status === "off" ? <BellOff size={16} /> : <Bell size={16} />}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    <Link href={`/assets/${a.assetId}`} className="hover:text-accent">
                      {a.asset?.symbol ?? "?"}
                    </Link>{" "}
                    <span className="font-normal text-muted">{a.condition === "above" ? "stijgt boven" : "daalt onder"}</span> {fmt.price(a.threshold, a.currency)}
                  </div>
                  <div className="text-xs text-muted">
                    {a.status === "triggered" && a.triggeredAt ? `Afgegaan op ${formatDate(a.triggeredAt, true)} bij ${fmt.price(a.triggeredPrice ?? "0", a.currency)}` : a.status === "off" ? "Uitgeschakeld" : `Actief sinds ${formatDate(a.createdAt)}`}
                  </div>
                </div>
                {a.status === "active" ? (
                  <button className="btn btn-ghost flex items-center gap-1 !py-1 text-xs" onClick={() => void setStatus(a.id, "off")}>
                    <BellOff size={12} /> Pauzeren
                  </button>
                ) : (
                  <button className="btn btn-ghost flex items-center gap-1 !py-1 text-xs" onClick={() => void setStatus(a.id, "active")}>
                    <RotateCcw size={12} /> {a.status === "triggered" ? "Opnieuw" : "Activeren"}
                  </button>
                )}
                <button className="tap rounded-lg p-1.5 text-muted hover:bg-down-soft hover:text-down" onClick={() => void del(a.id)} aria-label="Verwijderen" title="Verwijderen">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Ontvangen meldingen">
        {!notifications ? (
          <Skeleton className="h-20" />
        ) : notifications.length === 0 ? (
          <p className="text-sm text-muted">Nog geen meldingen.</p>
        ) : (
          <ul className="space-y-2">
            {notifications.slice(0, 30).map((n) => (
              <li key={n.id} className="rounded-xl bg-bg-elev px-3 py-2 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="font-semibold">{n.title}</span>
                  <span className="shrink-0 text-xs text-muted">{formatDate(n.createdAt, true)}</span>
                </div>
                {/* de titel blijft (bij koersalerts staat de drempel erin); de tekst kan aantallen noemen, bijv. bij een afstemmingsverschil */}
                <div className="text-muted">{fmt.text(n.body)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <NewAlertModal open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function NewAlertModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bump, toast } = useApp();
  const [asset, setAsset] = useState<SelectedAsset | null>(null);
  const [condition, setCondition] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState("");
  const [ccy, setCcy] = useState("USD");
  const save = async () => {
    if (!asset) return;
    try {
      await api("/api/alerts", { method: "POST", json: { assetId: asset.id, condition, threshold, currency: ccy } });
      toast("Alert ingesteld");
      bump();
      onClose();
      setAsset(null);
      setThreshold("");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Nieuwe alert">
      <div className="space-y-3">
        <Field label="Asset">
          <AssetSearch initial={asset} onSelect={(a) => { setAsset(a); setCcy(a.currency === "EUR" ? "EUR" : "USD"); }} />
        </Field>
        <div>
          <span className="label">Melding als de koers</span>
          <div className="flex gap-1">
            <button className="pill" data-active={condition === "above"} onClick={() => setCondition("above")}>
              Stijgt boven
            </button>
            <button className="pill" data-active={condition === "below"} onClick={() => setCondition("below")}>
              Daalt onder
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Drempel">
            <input className="input" inputMode="decimal" placeholder="bijv. 100000" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label="Valuta">
            <select className="input" value={ccy} onChange={(e) => setCcy(e.target.value)}>
              <option>EUR</option>
              <option>USD</option>
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" disabled={!asset || !threshold} onClick={() => void save()}>
            Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}
