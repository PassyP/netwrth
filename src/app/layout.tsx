import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { AppStateProvider } from "@/components/app-state";
import { Shell } from "@/components/shell";
import { LoginScreen } from "@/components/login-screen";
import { getSettings } from "@/lib/settings";
import { SESSION_COOKIE, isAuthorized, isPasswordSet } from "@/lib/auth";
import { criticalCount } from "@/lib/settings-overview";
import { HIDE_AMOUNTS_COOKIE } from "@/lib/format";

export const metadata: Metadata = {
  title: "Netwrth",
  description: "Persoonlijke portfolio-tracker: crypto, aandelen, ETF's, grondstoffen en vastgoed.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Netwrth" },
  icons: { icon: "/icon.svg", apple: "/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#0b0e14",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Met een ingesteld wachtwoord en zonder geldige sessie-cookie: alleen het inlogscherm (geen app, geen API-calls).
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  if (!isAuthorized(session)) {
    return (
      <html lang="nl">
        <body>
          <LoginScreen />
        </body>
      </html>
    );
  }

  const settings = getSettings();
  return (
    <html lang="nl">
      <body>
        {/* "Bedragen verbergen" al bij de eerste render, zodat na herladen niets even oplicht */}
        <AppStateProvider initialCurrency={settings.displayCurrency} initialHideAmounts={jar.get(HIDE_AMOUNTS_COOKIE)?.value === "1"} timeZone={settings.timezone}>
          <Shell authEnabled={isPasswordSet()} settingsCritical={criticalCount()}>
            {children}
          </Shell>
        </AppStateProvider>
      </body>
    </html>
  );
}
