import { SettingsProvider } from "@/components/settings/context";

/** Instellingen: een statusoverzicht (/settings) en een pagina per categorie; de provider blijft staan bij navigatie. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}
