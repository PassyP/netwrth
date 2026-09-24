# Netwrth

Persoonlijke portfolio-tracker in Delta-stijl: crypto, aandelen, ETF's, grondstoffen en fysiek vastgoed in meerdere portfolios, met koersen via de eToro Public API, Kraken en Yahoo Finance, ECB-wisselkoersen, winst/verlies per aankoop, allocatie, alerts en import van Swissquote/eToro-exports. Alles draait lokaal in één Docker-container; de data blijft op je eigen server (Umbrel Home).

Gebouwd volgens het spec-doc *Portfolio Manager – Spec* (v1).

## Functies (v1)

- Meerdere portfolios en een totaalbeeld; filteren op categorie en platform (eToro, Swissquote, wallet, Fysiek, …)
- Transacties: aankoop, verkoop, dividend, rente, staking, kosten, storting, opname — handmatig of via import
- Winst/verlies per aankoop (lot), per positie en totaal; gerealiseerd en ongerealiseerd; gemiddelde kostprijs of FIFO
- Weergave schakelbaar tussen € en $ met ECB-referentiekoersen (kostprijs tegen de koers van de aankoopdatum, zoals Delta en Swissquote)
- Koersen: eToro (crypto, aandelen, ETF's, grondstoffen), Kraken (crypto, publieke marktdata, geen key nodig), Yahoo Finance als gratis feed (bijv. VUSA.L, VWRL.L, EQQQ.L), of handmatig
- Verversen: automatisch elk uur (Instellingen → Koersen en planning → *Planning*: van elke 5 minuten tot dagelijks, of alleen de dagelijkse ronde) en met de knop Verversen; daarnaast een dagelijkse ronde (standaard 23:45) die eerst de koppelingen synct, dan de koersen ververst en de koershistorie aanvult; dagsnapshot om 23:59
- Grafiek waarde vs. inleg (1D/1W/1M/3M/1J/Alles; bij hover in €/$-weergave ook de waarde van die dag in BTC, tegen de BTC-EUR-koers die de app voor die dag heeft opgeslagen, bitcoin zelf 1:1), allocatie per categorie/platform/valuta/asset. Dagen zonder opgeslagen koers tellen tegen kostprijs; daarom vult de app de koershistorie van elk asset eenmalig aan tot de eerste transactie via Yahoo Finance (crypto als `BTC-EUR`, `ETH-USD`; Yahoo-assets met hun eigen ticker), omdat Kraken hoogstens 720 dagcandles geeft en de backfill bij aanmaken een jaar. Dat gebeurt bij het opstarten, na elke verversing en bij het laden van de grafiek (hoogstens 8 s wachten, de rest loopt door op de achtergrond); de rijen staan daarna in de database en de eigen koersbron blijft leidend (alleen dagen vóór de eerste rij van de feed worden geschreven; handmatige koersen blijven staan). De koersen worden per periode opgevraagd, niet met `range=max`, omdat Yahoo dan stilzwijgend week- of maandcandles geeft; een eerder te grof gevulde reeks wordt herkend en met dagkoersen overschreven. Aandelen en ETF's via eToro of Kraken worden niet aangevuld: hun symbool is zonder beurssuffix geen betrouwbare Yahoo-ticker.
- Stofposities (minder dan € 1 / $ 1 waard) verbergen — aan of uit bij Instellingen → Weergave en berekening. Het verbergt alleen de weergave: de posities en hun allocatie-aandeel tellen gewoon mee in de totalen, en op het overzicht staat hoeveel er verborgen zijn met een knop om ze alsnog te tonen.
- Bedragen verbergen: het oogje in de zijbalk (mobiel: bovenbalk) maakt van elk bedrag en aantal `€••••`, zodat niemand kan meekijken. Percentages en koersen blijven zichtbaar, behalve bij vastgoed (daar is de koers je eigen waardering). De stand wordt per apparaat onthouden (cookie). Invoervelden bij bewerken en pushmeldingen op het vergrendelscherm blijven zoals ze zijn.
- Koersalerts en meldingen: altijd in de app, en naar keuze ook via Web Push of ntfy (Instellingen → Meldingen, met een testmelding)
- Import: Swissquote-positie-export (`Positions_….xlsx`, herkend aan de kolommen Symbol/Quantity/Unit cost/CCY — de ISIN-kolom mag ontbreken; de datum komt uit de bestandsnaam, de categorie uit de sectiekop (Shares → aandelen, ETFs → ETF, Crypto → crypto) en sectie-, subtotaal- en totaalregels worden overgeslagen) en elk CSV/XLSX met kolommapping; dubbele regels worden overgeslagen
- Fysiek vastgoed met handmatige waardering en schuld (netto vermogen telt mee)
- PWA (installeerbaar op je telefoon), donker thema, back-up van de database met één klik
- eToro-keys voer je in bij Instellingen → Koersen en planning → *Koersbronnen*; ze staan versleuteld in de database
- **API-koppelingen (v2)**: eToro en Kraken koppelen met een leesbare API-key; posities, kas en transacties worden automatisch ingeladen (zie hieronder)

## Instellingen

`/settings` opent met een statusoverzicht: bovenaan de aandachtspunten (geen wachtwoord of herstelcode, een mislukte sync of afstemmingsverschil, een ontbrekende of publieke Bitcoin-node, mislukte koersrondes, geen recente back-up), elk met een knop naar de plek waar je het oplost; minder dringende punten verberg je tot er iets verandert. Daaronder zes pagina's:

- **Weergave en berekening**: valuta, stofposities, bedragen verbergen, kostprijsmethode en valuta-effect
- **Portfolios**: aanmaken, hernoemen en archiveren
- **Platforms en koppelingen**: platforms en API-koppelingen (elk platform een eigen pagina) en de *Bitcoin-node*
- **Koersen en planning**: *Koersbronnen* (eToro-keys), *Planning* (koersinterval, wallet-sync, dagelijkse ronde, snapshot, tijdzone) en *Recente taken*
- **Meldingen**: het kanaal (in de app, push of ntfy), de aangemelde apparaten en een testmelding
- **Beveiliging en back-up**: wachtwoord, herstelcode, back-up en CSV-export

Oude links naar de enkele instellingenpagina, zoals `/settings#bitcoin` of `/settings#backup`, worden doorgestuurd naar de nieuwe plek.

## API-koppelingen: eToro, Kraken en Bitcoin-wallet

Instellingen → Platforms en koppelingen → *Koppeling toevoegen*. De wizard test de keys (of zoekt bij een Bitcoin-wallet de accounts van je xpub), laat je kiezen of bestaande handmatige transacties van dat platform worden vervangen, en draait de eerste sync. Daarna synct de app elke dag (als eerste stap van de dagelijkse ronde; het uurlijkse koersinterval synct geen koppelingen) en met *Sync nu*; een Bitcoin-wallet daarnaast bij *Verversen* en elke paar minuten (zie hieronder).

| Platform | Key aanmaken | Rechten | Wat wordt ingeladen |
| --- | --- | --- | --- |
| Kraken | kraken.com → Security → API | Query funds · Query closed orders & trades · Query ledger entries (géén orders/withdraw) | Alle trades (buy/sell), stortingen en opnames, crypto-overboekingen (transfer in/out), staking/earn-rewards, instant buy/sell uit de app, delisting-omzettingen, airdrops en correcties, saldi per asset |
| eToro | [API-portal](https://api-portal.etoro.com/) (Read, Real) | Read | Open posities als aankopen (openRate, openDateTime), kas (credit); gesloten posities worden bij de volgende sync een verkoop tegen de laatst bekende koers |
| Bitcoin-wallet | Ledger Live: account → moersleutel → *Advanced* → xpub (ook Sparrow, Trezor Suite, BlueWallet) | Geen: watch-only, alleen de xpub | Ontvangsten als transfer in (kostprijs = Kraken BTC/EUR op bloktijd), verzendingen als transfer out inclusief minerfee (apart als kosten), saldo per account, onbevestigd apart; alles van je eigen node |

Details:

- API-transacties zijn alleen-lezen (slotje); een afwijking boek je als correctie of via de knop *Correctie boeken* bij een afstemmingsverschil (transfer in/out zonder winst/verlies).
- Overboekingen tussen eigen platforms (Kraken-opname → wallet-ontvangst, of andersom) worden herkend en nemen de kostprijs mee; zie *Bitcoin-wallet* hieronder.
- Afstemming: na elke sync vergelijkt de app het berekende aantal per asset met het saldo van het platform; verschillen staan bij de koppeling en op het overzicht.
- Kraken-aantallen komen uit het grootboek, niet uit `vol`/`cost` van de trade: Kraken rekent de kosten soms in de basismunt af (dan komt er bij een koop `vol` − kosten binnen) terwijl het veld `fee` altijd in de quote-munt staat, en het grootboek noemt ook de assetcodes van paren die Kraken inmiddels heeft geschrapt. De koers per stuk volgt uit dezelfde bedragen, zodat kostprijs en opbrengst precies uitkomen op wat er van de tegenmunt af ging of bij kwam. Zonder grootboekregels (zeldzaam) valt de app terug op de trade zelf en meldt dat als waarschuwing.
- Elke grootboekregel die geen trade is, wordt geboekt — ook `transfer` (delisting-omzetting, spot ↔ staking, airdrop), `adjustment` en onbekende types. Interne verplaatsingen tussen assetcodes van dezelfde munt (`XETH` ↔ `XETH.S`) vallen tegen elkaar weg; wat overblijft is precies de saldomutatie die Kraken rapporteert.
- Kraken crypto-naar-crypto trades (bijv. ETH/BTC) worden twee transacties tegen de EUR-koers van Kraken op dat moment; crypto-stortingen krijgen die koers als kostprijs. Voor transacties van vóór het OHLC-venster (Kraken geeft maar ~720 dagcandles terug, ongeacht `since`) komt die koers uit de publieke tradelijst rond dat tijdstip.
- Valuta's die Kraken wel verhandelt maar de app niet kent (CAD, JPY, AUD) worden niet geboekt maar gemeld; ze zouden anders als cryptopositie verschijnen.
- Keys staan versleuteld in de database (AES-256-GCM); de rate limits van Kraken (teller 15/20, verval 0,33/s) en eToro (120/min) worden gerespecteerd.
- Kraken-signing is geverifieerd tegen de officiële testvector uit de Kraken-documentatie (`src/lib/connections/kraken.test.ts`).
- eToro: de exacte veldnamen van `/api/v1/trading/info/portfolio` staan niet in de openbare documentatie; de parser is tolerant (positionId/positionID, instrumentId/instrumentID, openRate, units, openDateTime). Controleer na de eerste sync of de posities kloppen en meld afwijkingen.

## Bitcoin-wallet (xpub, watch-only)

Een Bitcoin-wallet koppel je zonder private key: plak de **xpub/ypub/zpub** van elk account. De app leidt zelf de ontvangst- (`m/0/i`) en wisseladressen (`m/1/i`) af (gap limit 20, zoals Ledger Live) en vraagt saldo en transacties op bij je **eigen node**.

- **Accounts kiezen (Ledger Live-model).** Eén xpub is één account; zuster-accounts (`m/84'/0'/1'`) zijn niet uit een xpub af te leiden, dus plak per account een key. Ledger Live exporteert álle accounts met het prefix `xpub`, ook SegWit en Native SegWit; de wizard scant zo'n key daarom onder alle vier adrestypes (Legacy, SegWit, Native SegWit, Taproot) en toont per type saldo en activiteit. Vink aan welke accounts in het portfolio komen; bij de koppeling (Instellingen → Platforms en koppelingen) zet je accounts later aan of uit of voeg je keys toe.
- **Node.** Instellingen → Platforms en koppelingen → *Bitcoin-node*: de mempool-app op je Umbrel (`http://10.21.21.26:3006`; vanaf een Mac in je netwerk `http://umbrel.local:3006`). Die app heeft de Electrs-app nodig voor adreslookups. Optioneel: terugval op een publieke node (standaard `https://mempool.space`, standaard **uit**) als de eigen node onbereikbaar of niet ingesteld is; een publieke node ziet dan de adressen van je wallet, en elke sync die de terugval gebruikt meldt dat in het syncrapport. Beide URL's hebben een testknop. De Umbrel-compose zet `BITCOIN_API_URL` als standaard. Publieke nodes remmen hard af: mempool.space vertraagt antwoorden tot tientallen seconden en blockstream.info blokkeert een IP na een paar honderd verzoeken ruim een half uur (HTTP 429). De app houdt daar rekening mee (2 verzoeken/s, herhalen met wachttijd), maar een wallet met veel gebruikte adressen kost al snel honderden verzoeken per sync; de terugval is bedoeld voor kleine wallets en noodgevallen, niet als vaste bron.
- **Boeking.** Netto per koppeling en per transactie: een ontvangst wordt *transfer in* tegen de Kraken BTC/EUR-koers op bloktijd (kostprijs, zoals bij Kraken-stortingen); een verzending wordt *transfer out* van het hele uitgaande bedrag inclusief minerfee (tegen boekwaarde, geen resultaat) plus een aparte *fee*-transactie in EUR. Een overboeking tussen twee eigen accounts is daardoor alleen de fee en laat de kostprijs staan. Pas bij **6 bevestigingen** wordt geboekt; daaronder telt de transactie als "in afwachting" op de koppeling. Gedeelde transacties (coinjoin) worden netto geboekt zonder fee.
- **Overboekingen tussen eigen platforms.** Een ontvangst op de wallet die bij een opname op een ander platform hoort (zelfde asset, opname hoogstens 2 uur na of 72 uur vóór de ontvangst, hoeveelheid gelijk op de opname-/minerfee na) krijgt de kostprijs van de zender mee in plaats van de dagkoers, en telt niet als nieuwe inleg. Dat geldt in beide richtingen (Kraken → wallet, wallet → Kraken) en ook voor handmatige *transfer in/out*-paren; de opgeslagen transacties veranderen niet, alleen de berekening. Een ontvangst zonder zichtbare tegenpartij (bijv. uit een wallet die niet in de app zit) krijgt de dagkoers als kostprijs, óf geen kostprijs (0, telt niet als inleg) als je dat per koppeling instelt (*Kostprijs van ontvangsten zonder herkende tegenpartij*); kies "geen" als al je coins met geld uit de app zijn gekocht en alleen via andere adressen of exchanges zijn rondgegaan.
- **Live.** Wallet-koppelingen syncen bij *Verversen* en elke *N* minuten (Instellingen → Koersen en planning → *Planning*, standaard elke 10 minuten; uit = alleen bij Verversen en de dagelijkse ronde); Kraken en eToro blijven bij de dagelijkse ronde. Elke wallet krijgt een eigen platform (type wallet) met de naam van de koppeling, zodat afstemming en allocatie per wallet apart blijven.
- **Privacy.** xpubs staan versleuteld in de database (`wallet:<id>:xpub`); adressen worden niet opgeslagen en komen niet in logs, meldingen of notities (alleen txid's en accountlabels). Het app-wachtwoord (Instellingen → Beveiliging en back-up) beschermt de saldi: de Umbrel-compose zet `PROXY_AUTH_ADD: "false"`, dus zonder wachtwoord ziet iedereen op je netwerk ze.
- Beperkingen: koersen van vóór de Kraken-historie (≈2014) geven kostprijs 0 met een waarschuwing; een geboekte transactie die door een reorg verdwijnt (bij 6 bevestigingen praktisch uitgesloten) blijft staan en toont een afstemmingsverschil.

## Lokaal draaien (ontwikkeling)

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # rekenkern + import (Vitest)
```

De database (`data/portfolio.db`) en het versleutelgeheim (`data/secret.key`) worden bij de eerste start aangemaakt.

## Docker

```bash
docker compose up -d --build
# → http://<server>:3000 ; data in ./data
```

## Installeren op Umbrel Home

De map `umbrel/` is een [community app store](https://github.com/getumbrel/umbrel-community-app-store) met de app `netwrth-app`.

1. Bouw en publiceer de image (amd64) naar een registry die je Umbrel kan bereiken, bijvoorbeeld GitHub Container Registry:
   ```bash
   docker build --platform linux/amd64 -t ghcr.io/passyp/netwrth:1.0.0 .
   docker push ghcr.io/passyp/netwrth:1.0.0
   ```
   Een nieuw package op ghcr.io is privé, en dan kan de Umbrel de image niet ophalen. Zet het op GitHub op *Public* (Packages → netwrth → Package settings → Change visibility) en controleer zonder login:
   ```bash
   docker logout ghcr.io && docker manifest inspect ghcr.io/passyp/netwrth:1.0.0
   ```
   Pas de `image:` in `umbrel/netwrth-app/docker-compose.yml` aan als je een andere naam gebruikt.
2. Zet de inhoud van de map `umbrel/` in de root van een eigen (publieke) GitHub-repository, bijvoorbeeld `netwrth-umbrel-apps`. Neem `netwrth-app/data/.gitkeep` mee: daardoor maakt umbrelOS de datamap aan als gebruiker 1000. Zonder die map maakt Docker hem als root aan en kan de app haar database niet openen.
3. Op je Umbrel: App Store → Community App Stores → voeg de URL van die repository toe → installeer *Netwrth*.
4. Open de app (poort 3380 op je Umbrel) en stel onder Instellingen → Beveiliging en back-up een wachtwoord in. Vul bij Koersen en planning → *Koersbronnen* je eToro-keys in. Voor een Bitcoin-wallet: controleer onder Platforms en koppelingen → *Bitcoin-node* de URL van de mempool-app (via `BITCOIN_API_URL` standaard ingevuld) met *Testen*.

Remote toegang en HTTPS (nodig voor PWA-installatie en push-meldingen): installeer de Tailscale-app op umbrelOS. Zonder HTTPS werkt de app gewoon als website; gebruik dan ntfy voor meldingen (Instellingen → Meldingen).

## eToro API

Maak in het [eToro API-portal](https://api-portal.etoro.com/) een key aan (geverifieerd account, rechten *Read*). De app gebruikt:

- `GET /api/v2/market-data/instruments/search` — asset zoeken
- `GET /api/v2/market-data/rates?instrumentIds=…` — bid/ask van alle assets in één call
- `GET /api/v1/market-data/instruments/history/closing-price` — dagslot (verandering vandaag)
- `GET /api/v1/market-data/instruments/{id}/history/candles/desc/OneDay/{n}` — historie voor grafieken

Limiet marktdata: 120 requests per 60 s; bij een 429 wacht de app met exponentiële backoff.

## Kraken marktdata

Kraken is naast API-koppeling ook koersbron voor crypto. Daarvoor is geen key nodig; de app gebruikt de publieke endpoints (basis `KRAKEN_BASE_URL`, standaard `https://api.kraken.com`):

- `GET /0/public/AssetPairs` — alle handelsparen (1 uur gecachet; daarna komt de oude lijst meteen terug en wordt die op de achtergrond ververst, na een mislukte verversing volgt pas na een minuut een nieuwe poging; alleen echte crypto (`aclass_base` `currency`), dark-pool-paren met een punt in de sleutel en tokenized assets zoals `AAPLxEUR` worden overgeslagen — ook bij de koershint van een Kraken-sync, die daarmee dezelfde paren kiest als de verversronde)
- `GET /0/public/Ticker?pair=…` — laatste koers en open van vandaag, in batches van 50 paren
- `GET /0/public/OHLC?pair=…&interval=1440` — dagcandles voor grafieken (Kraken geeft hoogstens ~720 candles terug, ongeacht `since`; oudere dagen tot de eerste transactie komen eenmalig van Yahoo Finance, zie *Functies*)
- `GET /0/public/Trades?pair=…&since=…` — historische koers bij een sync van vóór dat OHLC-venster (laatste trade op of vlak vóór het tijdstip, gecachet per paar en dag)

Conventies:

- `sourceId` van een Kraken-asset is de canonieke paarsleutel, bijv. `XXBTZEUR` of `SOLEUR`; `providerIds.kraken` is de basiscode (`XXBT`). Bij het zoeken kiest de app per munt één paar met voorkeursvaluta EUR > USD > GBP > CHF.
- Alleen paren met een app-valuta als quote (EUR, USD, GBP, CHF) zijn bruikbaar als koersbron; paren in USDT, BTC, CAD … (bijv. `XBTUSDT`, `ETHXBT`) worden geweigerd bij het toevoegen of bewerken van een asset en overgeslagen bij de verversronde, omdat de waardering zo'n koers niet kan omrekenen. Valutaparen (EUR/USD, GBP/USD) verschijnen niet in de zoekresultaten.
- Bij het toevoegen of bewerken van een asset moet het Kraken-paar bestaan (sleutel, altname of wsname, bijv. `XXBTZEUR`, `XBTEUR`, `XBT/EUR`) en bij het symbool van het asset horen: een onbekend paar (zoals een achtergebleven eToro-id na een bronwissel) of `SOLEUR` op het BTC-asset wordt geweigerd, zodat een asset nooit tegen de koers van een andere munt wordt gewaardeerd en een sync geen trades van een andere munt op dat asset boekt.
- Eén crypto-asset per symbool, ongeacht valuta en bron: bestaat er al een crypto-asset met dat symbool, dan krijgt dat asset de gekozen koersfeed (Kraken, eToro of Yahoo; de zoekresultaten tonen dan *bestaand asset · koers via … volgen* en de knop heet *Koersbron instellen*); er wordt geen tweede asset aangemaakt en naam, categorie en valuta van het asset blijven ongewijzigd. Een handmatig asset met een bestaand crypto-symbool wordt geweigerd. Nieuwe crypto-assets worden overal (toevoegen, CSV-import, koppelingen) in USD genoteerd (de koers bepaalt de waarderingsvaluta), en een CSV-import in een andere valuta koppelt aan het bestaande crypto-asset met dat symbool.
- Yahoo noteert crypto als munt-valuta (`BTC-USD`, `ETH-EUR`): het symbool in de app is de munt (`BTC`), de ticker blijft het bron-id en de naam verliest de valuta (*Bitcoin USD* → *Bitcoin*). Alleen tickers in een app-valuta zijn bruikbaar (`ETH-BTC` wordt geweigerd) en de munt moet bij het symbool horen (`SOL-EUR` op het BTC-asset ook). Oudere assets die zo'n ticker als symbool hebben (`BTC-USD` naast `BTC`) worden bij het opstarten samengevoegd met het crypto-asset van die munt — transacties, alerts en de koersdagen die dat asset nog mist gaan mee, het asset houdt zijn koersbron — of, zonder tweeling, hernoemd naar de munt.
- De zoekresultaten tonen altijd álle koersbronnen (lokaal, eToro, Yahoo, Kraken) naast elkaar, ook de bron die het asset al volgt (*bestaand asset · huidige koersbron*), zodat je per asset kiest welke koers je volgt. Zoek je op de naam (*bitcoin*) terwijl het asset alleen als `BTC` bekend is, dan staat het asset er toch als lokale rij bij.
- Een koersbron die je zelf instelt (Kraken, Yahoo of eToro) wordt door een sync niet meer overschreven: een koppeling vult alleen een ontbrekende bron in (*handmatig* → provider) en laat een bestaande feed en zijn paar staan.
- Een gepauzeerd pair (`cancel_only`, `post_only`, onderhoud) blijft bruikbaar als koersbron: Kraken blijft er koersen voor geven, en zou de status wél meetellen dan kreeg elk asset dat tijdens zo'n pauze voor het eerst binnenkomt blijvend een Yahoo-feed — voor munten die Yahoo niet onder `<SYM>-EUR` kent betekent dat helemaal geen koers.
- Verandering vandaag: Kraken kent geen dagslot in een 24/7-markt; de app gebruikt de open van vandaag (00:00 UTC, veld `o` van de Ticker) als vorige slotkoers. Wordt dezelfde dag daarna een koers van een andere bron opgeslagen zonder eigen vorige slot, dan wordt die vorige slot gewist (geen dagverandering in plaats van een vergelijking tussen valuta's).
- Rate limit: circa 1 request per seconde per IP; de app respecteert dat bij de verversronde.

## Structuur

```
src/lib/calc/engine.ts      rekenkern (lots, gemiddeld/FIFO, gerealiseerd, inkomsten) + tests
src/lib/portfolio.ts        posities, totalen, allocatie, kas
src/lib/history.ts          waarde vs. inleg per dag, dagsnapshots
src/lib/prices/             eToro, Kraken, Yahoo Finance, ECB/Frankfurter FX, verversronde
src/lib/importers/          Swissquote-profiel + generieke kolommapping
src/lib/connections/        API-koppelingen: kraken.ts, etoro.ts, bitcoin.ts (wallet), wallet-accounts.ts, sync.ts (orchestrator, afstemming) + tests
src/lib/bitcoin/            xpub-parsing en adresafleiding, Esplora-client (eigen node), accountontdekking, nodekeuze met terugval
src/lib/worker.ts           koersverversing per interval (standaard elk uur), dagelijkse ronde en snapshot, wallet-interval (node-cron)
src/lib/secrets.ts          versleutelde opslag van API-keys (AES-256-GCM)
src/app/api/                REST-routes
src/components/             UI (Delta-stijl)
drizzle/                    SQL-migraties (draaien automatisch bij start)
umbrel/                     Umbrel community app store
```

## Wachtwoord

Instellingen → *Beveiliging en back-up* stelt een wachtwoord in; daarna vraagt de app om in te loggen (ook alle API-routes, behalve `/api/status` voor de healthcheck). Met *Ingelogd blijven* onthoudt een browser de login 90 dagen, zonder vinkje tot je de browser sluit. Wijzigen logt de andere apparaten uit (deze browser blijft ingelogd); verwijderen (onder *Gevarenzone*) maakt de app weer open voor iedereen op je netwerk.

Bij het instellen of wijzigen krijg je eenmalig een **herstelcode** (`XXXX-XXXX-XXXX-XXXX`) te zien; bewaar die goed. Wachtwoord vergeten? Kies op het inlogscherm *Wachtwoord vergeten?*, voer de herstelcode en een nieuw wachtwoord in; je krijgt dan een nieuwe herstelcode. Een nieuwe code aanvragen kan ook via Instellingen → *Beveiliging en back-up* → *Nieuwe herstelcode* (met je huidige wachtwoord).

Ook de herstelcode kwijt? Dan kom je niet meer via de app binnen; met toegang tot de server verwijder je het wachtwoord uit de database en is de app weer open:

```bash
sqlite3 data/portfolio.db "DELETE FROM secrets WHERE name IN ('loginPassword','loginRecovery');"
```

## Back-up en herstel

Instellingen → Beveiliging en back-up → *Back-up downloaden (.db)* downloadt een consistente kopie van de database (alle transacties, instellingen en versleutelde keys). De pagina toont wanneer je de laatste back-up downloadde; het statusoverzicht meldt het als er nog geen is of als hij oud is. **Bewaar `secret.key` uit de datamap (of je `APP_SECRET`) bij de back-up**: zonder die sleutel zijn de opgeslagen API-keys en xpubs na herstel niet meer te ontsleutelen.

Herstellen: stop de app, zet het bestand terug als `portfolio.db` in de datamap (`/data` in de container), zet `secret.key` ernaast (of gebruik dezelfde `APP_SECRET`) en start de app. Een CSV van alle transacties download je op dezelfde pagina of op de pagina Transacties.
