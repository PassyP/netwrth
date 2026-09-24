/**
 * Register van de instellingen: één bron voor de navigatie (index en pill-rij), de redirects van oude ankers
 * (/settings#bitcoin uit bladwijzers en de README) en het zoekveld. Het label van een categorie is ook de h1 van zijn
 * pagina, zodat de navigatie belooft wat je vindt. Een categorie heeft hooguit drie inhoudelijke kaarten; groeit hij
 * daarboven (of boven twee mobiele schermen), dan wordt hij hier gesplitst.
 */

export type SettingsCategoryId = "weergave" | "portfolios" | "platforms" | "koersen" | "meldingen" | "beveiliging";

export interface SettingsEntry {
  label: string;
  /** anker op de pagina van de categorie (id van een kaart), of null voor de pagina zelf */
  anchor: string | null;
  keywords: string[];
}

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  href: string;
  description: string;
  entries: SettingsEntry[];
}

export const SETTINGS_ROOT = "/settings";

export const SETTINGS_NAV: SettingsCategory[] = [
  {
    id: "weergave",
    label: "Weergave en berekening",
    href: "/settings/weergave",
    description: "Hoe bedragen eruitzien en hoe winst en verlies worden berekend.",
    entries: [
      { label: "Valuta", anchor: "weergave", keywords: ["valuta", "weergavevaluta", "euro", "dollar", "eur", "usd", "btc", "bitcoin"] },
      { label: "Stofposities verbergen", anchor: "weergave", keywords: ["stof", "stofposities", "restjes", "kleine posities", "dust"] },
      { label: "Bedragen verbergen", anchor: "weergave", keywords: ["bedragen", "verbergen", "privacy", "meekijken", "oog"] },
      { label: "Kostprijsmethode", anchor: "berekening", keywords: ["kostprijs", "fifo", "gemiddeld", "lot", "winst", "verlies"] },
      { label: "Valuta-effect in winst/verlies", anchor: "berekening", keywords: ["valuta-effect", "wisselkoers", "fx", "w/v"] },
    ],
  },
  {
    id: "portfolios",
    label: "Portfolios",
    href: "/settings/portfolios",
    description: "De groepen waarin je vermogen is ingedeeld; dezelfde lijst als de portfoliokiezer in de navigatie.",
    entries: [{ label: "Portfolios", anchor: "portfolios", keywords: ["portfolio", "nieuw portfolio", "archiveren", "hernoemen", "pensioen"] }],
  },
  {
    id: "platforms",
    label: "Platforms en koppelingen",
    href: "/settings/platforms",
    description: "Waar je vermogen staat, hoe de gegevens binnenkomen, en de Bitcoin-node van je wallets.",
    entries: [
      { label: "Platforms", anchor: "platforms", keywords: ["platform", "broker", "exchange", "wallet", "hernoemen", "handmatig platform"] },
      { label: "Koppeling toevoegen", anchor: "platforms", keywords: ["koppeling", "api", "kraken", "etoro", "xpub", "ledger", "sync", "synchroniseren"] },
      { label: "Bitcoin-node", anchor: "bitcoin-node", keywords: ["bitcoin", "node", "umbrel", "mempool", "esplora", "electrs", "terugval", "publieke node"] },
    ],
  },
  {
    id: "koersen",
    label: "Koersen en planning",
    href: "/settings/koersen",
    description: "Waar koersen vandaan komen, wanneer de app bijwerkt en hoe dat ging.",
    entries: [
      { label: "Koersbronnen en eToro-keys", anchor: "koersbronnen", keywords: ["koers", "koersbron", "etoro", "api-key", "user key", "yahoo", "kraken", "wisselkoers", "ecb"] },
      { label: "Planning", anchor: "planning", keywords: ["verversen", "interval", "elk uur", "dagelijkse ronde", "snapshot", "wallet-sync", "tijdzone", "planning"] },
      { label: "Recente taken", anchor: "taken", keywords: ["taken", "log", "mislukt", "fouten", "historie", "activiteit"] },
    ],
  },
  {
    id: "meldingen",
    label: "Meldingen",
    href: "/settings/meldingen",
    description: "Hoe de app je bereikt bij een koersalert, een afstemmingsverschil of een mislukte sync.",
    entries: [{ label: "Meldingskanaal", anchor: "kanaal", keywords: ["melding", "meldingen", "push", "ntfy", "notificatie", "testmelding", "apparaat"] }],
  },
  {
    id: "beveiliging",
    label: "Beveiliging en back-up",
    href: "/settings/beveiliging",
    description: "Je gegevens beschermen tegen meekijkers en tegen verlies.",
    entries: [
      { label: "Wachtwoord en herstelcode", anchor: "toegang", keywords: ["wachtwoord", "herstelcode", "inloggen", "uitloggen", "beveiliging", "toegang"] },
      { label: "Back-up en export", anchor: "backup", keywords: ["back-up", "backup", "herstellen", "secret.key", "export", "csv", "database"] },
    ],
  },
];

export function categoryById(id: SettingsCategoryId): SettingsCategory {
  return SETTINGS_NAV.find((c) => c.id === id)!;
}

/** Ankers van de oude instellingenpagina (één lange pagina) → nieuwe plek. */
export const LEGACY_ANCHORS: Record<string, string> = {
  weergave: "/settings/weergave",
  portfolios: "/settings/portfolios",
  platforms: "/settings/platforms",
  koppelingen: "/settings/platforms",
  bitcoin: "/settings/platforms#bitcoin-node",
  meldingen: "/settings/meldingen",
  beveiliging: "/settings/beveiliging",
  backup: "/settings/beveiliging#backup",
  taken: "/settings/koersen#taken",
};

/** Doel voor een hash van de oude pagina ("#bitcoin" of "bitcoin"), of null. */
export function legacyTarget(hash: string): string | null {
  const key = hash.replace(/^#/, "").trim().toLowerCase();
  // alleen eigen sleutels: "#constructor" of "#__proto__" mag niet op Object.prototype uitkomen
  return key && Object.hasOwn(LEGACY_ANCHORS, key) ? LEGACY_ANCHORS[key] : null;
}

export interface SettingsSearchHit {
  label: string;
  category: string;
  href: string;
}

/** Zoekt in labels en trefwoorden (zonder onderscheid in hoofdletters); elk woord van de zoekterm moet ergens passen. */
export function searchSettings(query: string): SettingsSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: SettingsSearchHit[] = [];
  for (const c of SETTINGS_NAV) {
    for (const e of c.entries) {
      const hay = [e.label, c.label, ...e.keywords].join(" ").toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push({ label: e.label, category: c.label, href: e.anchor ? `${c.href}#${e.anchor}` : c.href });
    }
  }
  return hits;
}
