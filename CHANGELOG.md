## 2026-10-04 — nadogradnja instalacije sa bazom izvan zadane putanje (TASK-5218)

- `docs/INSTALL.md` §10: instalacija čija baza nije na `$HOME/.taskmanager/data/tasks.db` mora
  prije restarta upisati `TM_DB` u `config/postavke.env` — od TASK-5011 ploča staru putanju ne
  pogađa i nad praznom bazom pada (`no such table: tasks`). `messages.db` ide uz `TM_DB`
  (poveznica ako leži drugdje), varijable za registar agenata, modele, module i tajne, zašto
  `TM_HOME` mijenja ponašanje, i provjera otvorene baze kroz `/proc/<pid>/fd`. Nalaz s prve
  nadogradnje dviju postojećih instalacija na ovaj HEAD.

## 2026-10-04 — dokumentacija: Config stranica, prekidači, tijekovi i razlika prema izvornom sustavu (TASK-5172)

- Novo: `docs/CONFIG.md` — Config stranica (pet skupina, 21 kartica, ruta svake kartice),
  uređivač rasporeda (gumbi, miš, dodir, tipkovnica, tri pravila: vrijednosti zaključane, jedan
  raspored za sustav, `409` za zastarjeli), prekidači paketa (`workflow-gate` s
  `materijalizacija`, `ingest-gate`, vratari zatvaranja) i oni koji postoje samo u izvornom
  sustavu (`popis-obnova`, memorija, `tijekPosla`, `zatvaranjeKrozDaemon`, `rad-bez-zadatka`,
  `revizijaBlokiranih`), tijekovi, ulazna vrata i dojava pri završetku.
- Novo: `docs/POGON_I_PAKET.md` — što je od novosti 02.–04.10. ušlo u paket (uređivač rasporeda,
  pet skupina, pragovi autonomije, katalog tijekova 1.3.0, vrata tijeka I1–I7, ploča na
  mobitelu, traka „Čeka odluku") i što nije (puni kontekst zadatka i `POST /api/nalozi`,
  „🧭 Tijek posla" u dojavi, ulazna vrata v2, nesukladnosti B/C/D, obnova popisa, memorija,
  revizija blokiranih) — svaka stavka s naredbom za provjeru u paketu.
- Novo: `config/workflow-gate.example.json` (paket ga dosad nije imao; bez datoteke vrijedi
  `shadow`). Napomena da `dorada-isporuke` i `izrada-dokumenta` imaju korake (`agent: "izvorni"`,
  `mehanizam: "report-back"`) koje razrješava samo izvorni sustav, pa uz njih
  `materijalizacija` ostaje `shadow`.
- `docs/AGENTI.md`: tablica tijekova s 5 na 11 (s prioritetom i `trazi_u`), pravilo odabira s
  korakom lanca (`u-lancu`) i `iskljucuje`, tri razine prekidača. Katalog 1.3.0 (`f9feb69`) i
  vrata I1–I7 (`90744cb`) dosad nisu imali unos u ovom dnevniku.
- `README.md`/`README.hr.md`: značajke (vrata autonomije, traka „Čeka odluku", tijekovi, ulazna
  vrata, Config i uređivač rasporeda, ploča na mobitelu), opis kartice Config, tablica
  dokumenata. `docs/INSTALL.md`: §5.2 dobiva `workflow-gate.json` i `ingest-gate.json`, novi
  §5.4 Config stranica.

## 2026-10-04 — uređivač rasporeda Config stranice (TASK-5170, dizajn TASK-5169)

- Config stranica ima JEDAN gumb **✎ Uredi raspored ↔ 💾 Spremi raspored**: kartice se premještaju
  povlačenjem ručke ⠿ (samo unutar svoje skupine), mijenjaju veličinu kutom ◢ (širina 1–4 stupca,
  visina 160–1200 px po 40), tipkovnicom (strelice, Shift+strelice, A), uz ✕ Odustani (Esc, s
  „Vrati"), ↺ Zadano i ▤ Sažmi (na mobitelu uključeno samo). Vrijednosti postavki su za vrijeme
  uređivanja `inert` — raspored ne može promijeniti postavku.
- `src/core/ConfigRaspored.ts`: validacija, poredak, spajanje i brojanje izmjena (logika iz
  prototipa); `GET/PUT /api/config/raspored` — ključ `config.raspored` u `settings`, audit u
  `settings_history` u istoj transakciji, `409` za zastarjelu `osnova`, `{zadano:true}`, stroga
  validacija (400/413), `x-regoc-proba: 1` bez upisa; WS `raspored_changed`. Pregledniku ide ISTI kod
  logike kroz `/config-raspored.js` (uz `src/ConfigRasporedUredivac.js`), izvan predloška HTML-a.
- Testovi: `tests/config-raspored-logika.test.ts` (22), `tests/config-raspored-postavka.test.ts` (17),
  `tests/config-raspored-api.test.ts` (2, prava ploča: nepromjenjivost ruta vrijednosti, proba ne
  puni ploču); e2e `tests/e2e/config_raspored_e2e.py` — Chromium + Firefox, desktop + mobitel, samo
  povjerljivi događaji (CDP dodir u Chromiumu), 56/0.

## 2026-10-04 — traka „Čeka odluku": tri skupine, isti filtar kao odlučitelj, jezik (TASK-5173)

- Kvar: traka je pisala „3 zadataka u redu odlučitelja — odlučuje model, ne čekaju tebe", a
  odlučitelj u istom trenutku „nema zadataka koji čekaju odluku" (pregledano 0). Ploča je
  brojila sve zadatke s ljudskom oznakom, a `tools/odlucitelj.py` (`cekaju()`) je preskakao
  strojne okidače i ovisnosti — dva filtra. Jedan od tri zadatka (`waiting-for-human`, reboot
  traži sudo) stvarno je čekao vlasnika, pa je „ne čeka tebe" bilo netočno.
- `src/core/OdlukeRazvrstaj.ts`: JEDAN filtar. `GET /api/odluke` svakom zadatku dodaje
  `skupina` (`model` | `strojni` | `covjek`), `cekaSto` (što ga drži, iz `blockedReason` bez
  vratareva prefiksa), `doKada` (prvi budući nadnevak iz razloga/opisa; prošli uz
  `prosao: true`) i `zaOdlucitelja`; odgovor dobiva `skupine` i `zaOdlucitelja` (broj).
  `odlucitelj.py` više ne filtrira sam nego čita `zaOdlucitelja` (stari filtar samo za ploču
  koja polje ne šalje). Ljudske oznake (`waiting-for-human`, `interactive`, `no-autonomy`)
  pobjeđuju `okidac-strojni` i više ne ulaze u red modela; sklopka `pusta_strojni_okidac`
  čita se iz iste `odlucitelj.json`.
- Traka: naslov „Čeka odluku: N odlučuje model · N čeka strojni okidač · N čeka tebe" i po
  redak za svaki zadatak koji čeka okidač ili tebe (što i do kada; istekao rok iz opisa se
  ističe). Statični „stroj ih namjerno ne dira dok ne odlučiš" uklonjen — nije bio istinit.
- Jezik: ključevi `odl_naslov_model_*`/`odl_naslov_covjek_*` nisu postojali ni u `hr.json`
  ni u `en.json` (ključ biran ternarom, `_Tv(n === 1 ? 'a' : 'b', …)`), pa je u engleskom
  sučelju naslov ostajao hrvatski usred engleskih natpisa. Novi ključevi `odl_sk_*`,
  `odl_rok_*`, `odl_u_prolazu`, `odl_prolaz_prazno`, `odl_prolaz_pao` u oba rječnika.
- Testovi: `tests/odluke-razvrstaj.test.ts` (17), `tests/odlucitelj-isti-filtar.test.ts` (4).

## 2026-10-03 — ploča nakon tihog pada mreže: svaki GET ima rok (TASK-5198)

- Kvar (QA TASK-5185, `--nacin crna_rupa`): nakon pada mreže bez FIN/RST svaki `/api/tasks` je
  60 s visio i padao (`ERR_ABORTED`) do kraja mjerenja, a zaglavlje je bilo zeleno „Spojeno".
  Uzrok: dohvati bez roka (`fetchUnverified`, `fetchUputeStanje`, ostali GET-ovi) sjede na mrtvim
  keep-alive utičnicama zauvijek i zauzmu Chromeov bazen (6 HTTP/1.1 veza po hostu); novi zahtjev
  čeka slobodno mjesto do svog roka. WebSocket ima zaseban bazen, pa se on spoji, a ploča ne.
- Ploča: `window.fetch` je omotan (`napraviFetchSRokom`) — GET bez vlastitog signala dobiva rok
  20 s (poslužitelj ionako prekida nakon 10 s mirovanja); kad se WS ponovo spoji nakon pada,
  dohvati u letu stariji od 5 s se prekidaju i ploča se odmah traži ponovo; rok dohvata ploče
  60 → 20 s, nakon isteka novi pokušaj za 1,5 s (ne 30 s); `fetchUnverified`/`fetchUputeStanje`
  imaju rok 15 s; zaglavlje „Spojeno – ploča stara N min" kad ploča > 2 min nije dobila podatke.
- Mjereno (Playwright, Pixel 5, Slow 3G, crna rupa 90 s od 120. s): prije — nijedan uspješan
  `/api/tasks` u 210 s nakon povratka mreže; poslije — prvi `ok` 13,7 s nakon povratka.
- Testovi: `tests/ploca-fetch-rok.test.ts` (10).

## 2026-10-03 — ploča na mobitelu: promet i pouzdana živa veza (TASK-5184)

- Kvar: na mobitelu ploča stoji na „Connecting…", TOTAL je „-". `GET /api/tasks` je slao sve
  zadatke sa svim poljima (9,4 MB) bez kompresije — pri učitavanju tri puta, svakih 30 s i na svaki
  WS događaj; WS `initial` je na svako spajanje slao još jednom isti popis; `primijeniJezik()` je
  preko `data-i18n` prepisivao „Connected" natrag u „Connecting…".
- `src/PlocaPromet.ts`: `GET /api/tasks?view=board` (polja kartice, otvoreni + zadnjih N zatvorenih,
  brojači nad svim zadacima, `since=`, `offset`/`limit`), br/gzip za sve tekstualne odgovore,
  dashboard bez specifikacija projekata (239 KB → 7 KB gzip). Bez `view` API je nepromijenjen.
- Ploča: jedan dohvat u letu, inkrementalno osvježavanje, WS ponovno spajanje 1→30 s s
  odbrojavanjem („Offline – pokušavam ponovo za N s…"), ping 25 s, odbacivanje mrtve veze,
  odmah na `visibilitychange`/`online`; intervali stoje dok je stranica skrivena.
- Mjereno (Playwright, Pixel 5, Slow 3G, 150 s, kopija baze s 2678 zadataka): prvi prikaz
  106 s → 13 s; promet 6,5 MB/min → 0,12 MB/min.
- Testovi: `tests/ploca-promet.test.ts` (20); alat `tests/e2e/mobilni_promet.py`.

## 2026-10-03 — dizajn uređivača rasporeda Config stranice (TASK-5169)

- `docs/DIZAJN-config-uredivac-rasporeda.md`: jedan gumb ✎ Uredi raspored ↔ 💾 Spremi raspored,
  drag & drop unutar skupine, promjena veličine (mreža 4 stupca, visina 160–1200 px u koracima 40),
  Esc/Odustani s „Vrati", ↺ Zadano, sažeti prikaz za mobitel; raspored je globalan, ključ
  `config.raspored` u `settings` + audit u `settings_history`; vrijednosti postavki zaključane (inert)
  i odvojene rutom i strogom validacijom. Ugradnja u TaskWebUI je sljedeći zadatak.
- `docs/skice/config-raspored/`: Excalidraw skica (+PNG), radni prototip (Pointer Events, bez
  biblioteka), E2E Chromium + Firefox, miš + dodir — 54 pass, 0 fail.
- `tests/config-raspored-logika.test.ts`: 22 testa pravila (validacija, poredak, spajanje).

## 2026-10-02 — pragovi vrata autonomije su postavka, promjenjiva uživo

- Modul `src/core/AutonomyThresholdSetting.ts` (ista datoteka kao u REGOČ pogonu): ključevi
  `autonomy.session_autonomy|session_caution|session_block|weekly_block` u tablici `settings`,
  zadano 70/85/95/90, audit po ključu u `settings_history`, čitač s kešom ≤5 s.
- `GET/PUT /api/config/autonomy`: validacija 10–100 i redoslijed autonomija < oprez < blokada,
  djelomičan PUT, odgovor s trenutačnom potrošnjom (`usage`) i zonom za klizač (`zone`),
  WebSocket `autonomy_changed`.
- Nevaljan ili nečitljiv zapis → zadnji dobar skup, pa zadano (nikad „bez praga”).
- Testovi: `tests/autonomy-threshold-setting.test.ts` (6, uključujući HTTP na pravoj ploči).

## 2026-10-02 — README: odjeljak „Značajke” (TASK-5110)

- `README.md` (**Features**) i `README.hr.md` (**Značajke**): jedna rečenica po značajki s
  poveznicom na dokument — ručna kočnica (globalna i po zadatku), strop usporednih agenata
  (`PUT /api/config/concurrency`), uputa agentu u radu (`POST /api/tasks/<ID>/uputa`),
  odluka o pokretanju, zatvaranje kroz orkestrator, straža jeke i pretinac, nezavisni kritičar
  (`CriticGate`), completion-guard i `REGOC-IZLAZ`, parsirani rezultat, prijelazi stanja,
  RAG s dva pozadinska sustava, procjena energije, postavke modela, konzola, provjerena
  prazna instalacija (J1–J12 iz `docs/GAP_20260924.md`).
- Tablica dokumentacije dobila je `docs/UPUTE-AGENTU.md`, `docs/SUSTAV.md`, `docs/AGENTI.md`,
  `docs/INTEGRACIJE.md` i `docs/adr/`.
- Sam tekst README-a ušao je u commit 5da4841 (TASK-5109): dva zadatka radila su u istom
  radnom stablu, a taj je commit pokupio i ove izmjene. Ovaj zapis je trag TASK-5110.

## 2026-10-02 — bez zadane mape repozitorija sustava (TASK-5109)

- **Repozitorij sustava samo iz okoline.** Ploča, `TaskTelemetry`, `TjedniPregled`,
  `OdluciteljPogon` i memorijska konfiguracija više ne traže alate u zadanoj mapi našeg
  repozitorija pod `$HOME`: novi `sustavPutanja()` (src/core/paths.ts) čita `TM_SUSTAV_DIR`,
  a bez nje se alat traži samo uz paket. Skripta servisa iz `TM_SERVICES_SCRIPT`.
  Memorijski slug više nema rezervu sa slug-a naše razvojne mašine. **Prijelaz:** instalacija
  koja je alate držala u repozitoriju sustava postavlja `TM_SUSTAV_DIR`.
- Komentari i `agents/workflows.json` navode interne dokumente po imenu („repozitorij sustava,
  nije u paketu") umjesto po našoj putanji.
- Brana: novo pravilo „naš repozitorij sustava", osnovica 24 pojave / 14 datoteka → 0.
- **Commit hook bez naše adrese.** `.githooks/commit-msg` je našu adresu imao kao jedinog
  zadanog autora, a `scripts/install.sh` kuke uključuje u svakom klonu — svakom drugom
  korisniku git je odbijao svaki commit. Dopušteni autori sada dolaze samo iz
  `git config taskmanagerai.dopusteniAutori`; klon bez popisa ne provjerava identitet (trag
  alata u poruci se provjerava uvijek). **Prijelaz:** tko se oslanjao na provjeru identiteta,
  postavlja taj ključ. Brana: e-pošta 7/5 → 0 (uzorak hvata i `.eu` domenu).
- Navodi odluka u komentarima pišu „vlasnik, <datum>: …" umjesto imena, primjeri „Korisnik A";
  `notifyGoranTaskBurst` → `notifyOwnerTaskBurst`. Novo pravilo brane za imena ljudi:
  114 pojava / 40 datoteka → 4/4 — preostalo je autorstvo (LICENSE, package.json, „Credit" u
  README) i namjerno ostaje.

## 2026-10-02 — paket bez naših vrijednosti (TASK-5108, dug iz revizije TASK-5010 §D)

- **Adrese servisa samo iz okoline.** Alati u `tools/` više nemaju naš LAN kao zadanu
  vrijednost: Ollama iz `TM_OLLAMA_URL`, Chroma iz `TM_CHROMA_HOST`/`TM_CHROMA_PORT`, kroz
  novi `tools/tm_putanje.py` (Python zrcalo `src/core/paths.ts`). Bez varijable alat jasno
  odbija umjesto da gađa tuđu adresu.
- **Bez rasporeda mapa izvornog sustava.** Ploča, jezgra i alati čitaju konfiguraciju kroz
  `konfigPutanja()` (`model-config.json` → `TM_MODEL_CONFIG`, registar agenata
  `REGOC_AGENTS.json` → `TM_AGENTS_REGISTRY`, `module-config.json`, `odlucitelj.json`,
  `workflow-gate.json`, `memory-config.json`…), a stanje u `$TM_HOME/data`. **Prijelaz:**
  instalacija koja je te datoteke držala u naslijeđenoj mapi postavlja `TM_HOME` (i po potrebi
  pojedine varijable) ili ih kopira u `$TM_HOME/config/`.
- Dežurni: podizanje servisa iz `TM_SERVIS_RESTART` (`"skripta arg {s}; druga"`), slanje iz
  `TM_TELEGRAM_SEND` — bez zadanih putanja. `LiveDbGuard` dodatne žive baze dobiva iz
  `TM_LIVE_DB`. `install.sh` posuđuje ovisnosti iz `TM_POSUDI_IZ`.
- Uvoz Telegrama: pravila projekata, grupe i nadimci ljudi su konfiguracija
  (`config/uvoz-telegrama.example.json`). `tools/rag_audit.py`, `tools/razvrstaj_prijave.py`
  i `tools/razvrstaj_pretinac.py` izbačeni iz paketa (interni jednokratni alati).
- Primjeri i testovi: izmišljeni Telegram chat id `-1001234567890`, neutralan pošiljatelj.
- Brana `tests/bez-nasih-vrijednosti.test.ts`: uzorak rasporeda mapa hvata i rastavljeni oblik
  (putanja složena iz dijelova u `join()`), nova pravila za ime vlasnika kao podatak i za nazive
  internih projekata; osnovice IP, chat id, HOME i raspored mapa na 0.

## 2026-10-02 — svježa instalacija po INSTALL.md stvarno radi (QA svježeg klona)

QA svježeg klona s praznim `HOME`-om, korak po korak prema `docs/INSTALL.md`, našao je dva
kvara koja su postojala od prvog izdanja, a nijedan test ih nije vidio jer su svi e2e testovi
postavljali `TM_HOME`:

- **`bash scripts/install.sh` je padao sa `SQLITE_CANTOPEN`.** `init` je bazu stvarao u
  `$HOME/.taskmanager/data/tasks.db` (kako piše u dokumentaciji), a ploča, projekti i red
  poruka su bez `TM_HOME`/`TM_DB` otvarali naslijeđenu putanju izvornog sustava. Sada sva tri
  i čitanje troška idu kroz `src/core/paths.ts`. **Prijelaz:** instalacija koja je radila uz
  tu naslijeđenu putanju postavlja `TM_DB` na nju; `LiveDbGuard` sada čuva i zadanu bazu
  paketa od testova.
- **`bun run init` nad postojećom bazom** padao je s `table cost_log already exists`, iako ga
  §4 i §10 („Nadogradnja") opisuju kao bezopasan. Shema je sada idempotentna (tablice i
  kazala `IF NOT EXISTS`, okidači i pogledi se stvaraju iznova).
- Testovi u svježem klonu: `~/.tmp` se stvara ako ga nema; provjera internog alata prijenosa
  (namjerno izvan gita) se preskače umjesto da padne. Novi `tests/svjeza-instalacija.test.ts`
  ponavlja točno put novog korisnika (samo `HOME`): init ×2 → ploča → `POST` → P1 red.


Plan i odluke po značajki: [`docs/GAP_20260924.md`](docs/GAP_20260924.md). Prijenos je išao
**po značajkama, ne po datotekama** — svaki hunk iz žive instalacije dobio je paketne obrasce
(`paths.ts`, `konfigPutanja()`, `TM_*`), jer bi slijepa kopija vratila tuđe adrese i naš tim.

**Zadatak i zatvaranje**
- ID projekta nikad ne zaostaje za tablicom (`MAX(sekvenca, max(id)+1)`); ponovno otvaranje
  `completed → pending` i `cancelled → pending`; konzola ne nudi spremanje lozinke.
- Strukturirani izlaz koraka `REGOC-IZLAZ` (W3b): `schema_invalid` uživo uz `nacin: on`,
  `schema_missing` samo uz `provodiNedostajuci` i izvan izuzeća (zaglavlje `X-REGOC-Zatvara`).
- Completion-guard za nepovjerljivog izvršitelja (`localExecutorStrict`, u sjeni).
- Kritičar za dokumente (L0 oblik, L1 traženi odsjeci); L2 traži suca koji nije dio paketa i
  bez njega javlja „sudac nije instaliran". Dojava „neprovjereno" imenuje prošlu razinu.
- `TaskCloser` + `SpawnFinalizer` + `spawnCloseGuard` (`409 SPAWN_ACTIVE`) iza prekidača u
  `config/features.json`, zadano isključeno. **Ispravak uz prijenos:** terminalan skup je
  „stanja iz kojih vodi samo povratak u red" — stari sud „nema prijelaza" nakon uvođenja
  ponovnog otvaranja davao je prazan skup i guard je tiho utihnuo (isti kvar u živom sustavu
  prijavljen je zasebno).

**Ploča**
- `GET /api/tasks/:id` nosi `resultParsed`; kartica crta bedž, sklopive sekcije i „prikaži
  sirovo" isključivo kroz `textContent` (bez `innerHTML`).
- Straža jeke: dojava raspoređivača i obavijesti o životnom ciklusu agenta ne postaju zadatak.
- Procjena struje, CO₂ i vode uz trošak projekta, s rasponom i metodom; koeficijenti u
  `config/energija.json`.
- `model-config.json` se mijenja atomno (`tmp` + `rename`) uz revizijski trag; `[1m]` u popisu.
- RAG s dva pozadinska sustava (ChromaDB / pgvector / dual) + kartica „RAG Backend"; `pg` je
  opcijska ovisnost; lozinka samo iz `TM_PGVECTOR_PASSWORD`, nikad u JSON-u ni odgovoru.

**Bez naših vrijednosti**
- Rod agenta (završio/završila) više nije popis u kodu nego polje `rod` u `config/agents.json`.
- `CostTracker`, `CriticGate`, `UnverifiedReport`, `FeatureFlags`, `TaskCloser`: putanje kroz
  `konfigPutanja`/`stanjePutanja` umjesto tuđeg kućnog direktorija.
- Nove konfiguracije isporučuju se kao `config/*.example.json`; žive su u `.gitignore`.
- Mjerilo potrošnje `tools/session_usage.py` piše dnevnik i keš u `$TM_HOME/data` (zadano
  `~/.taskmanager/data`), a ploča (`src/SessionUsage.ts`) čita isti keš i zove skriptu iz
  paketa. Pošiljatelj i mapa sesija zadaju se s `TM_TELEGRAM_SEND` / `TM_TELEGRAM_SESSIONS`;
  drugo mjerilo s `TM_SESSION_USAGE_SCRIPT`.

**Dokumentacija**
- `REGOC/` razdijeljen po temama, svaka na hrvatskom i engleskom (`X.md` + `X.en.md`), uz
  `REGOC/README.en.md`. Brana imena izuzima mapu `REGOC/` jednim pravilom.
- INSTALL §5.2 (vratari i prekidači), §5.3 (RAG); API: prijelazi stanja, zaglavlja zatvaranja,
  `resultParsed`, `/api/critic`, `/api/rag/backend/*`; DATABASE: `v_projects_summary` i datoteke
  stanja; TOOLS; oba READMEa.

**Nije preneseno u ovom krugu** (GAP §3.2–§3.3): sudac L2 i registar imenovanih agenata,
izbor tima u lancu, ostatak demona, tier-klasifikator; sve vezano za naš stroj.

**Provjera prazne instalacije** (`tests/prazna-instalacija.test.ts`, i ručno s `curl`):
`init-db` na praznom `TM_HOME` → poslužitelj → `/` 200 → `POST /api/tasks` (prioritet 1) →
`GET /api/tasks/TASK-001` 200 → `execution_queue` sadrži `TASK-001` (okidač
`auto_queue_p1_tasks`), zadatak prioriteta 3 ne; `/api/rag/backend/status` 200 bez adrese.
Testovi: s ovim prijenosom `bun test` broji 800+ prolaza i 0 padova.

## 2026-09-24 — strop usporednih agenata je postavka, promjenjiva uživo

- Nova tablica `settings` (+ `settings_history` za audit) i modul `src/core/ConcurrencySetting.ts`.
  Ključ `agents.max_concurrent`, zadano **3**, seed pri `scripts/init-db.ts`.
- `GET/PUT /api/config/concurrency` (validacija 1–10, zapis tko/kada/staro → novo) i kartica
  „Usporedni agenti (1–10)" na Config stranici, uz prikaz zauzetih mjesta (npr. 2/3).
- Orkestrator (`SpawnQueue`) čita strop **uživo** (keš ≤5 s) — promjena ne traži restart;
  smanjenje ne prekida poslove koji teku. `SpawnQueue` i dalje prima i obični broj.
- `spawn.maxConcurrent` u `orchestrator.json` i `TM_MAX_CONCURRENT` više ne određuju strop;
  `REGOC_MAX_AGENT_CONCURRENT` je samo jednokratna početna vrijednost i javlja se kao zastarjela.
- Testovi: `tests/concurrency-setting.test.ts` (15 — seed, validacija, audit, keš, fail-safe,
  E2E 1 → 3 bez restarta, init-db na praznom `TM_HOME`).

## 2026-09-10 — tvoj tim, ne naš: popis nositelja zadatka je postao podatak

**`TM_AGENTS` sada doista radi (nalaz N1, `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md`)**
- Popis dopuštenih nositelja više nije zatvoren `z.enum` s imenima naših jedanaest agenata.
  Razrješava ga `src/core/AgentIds.ts` iz dva izvora koja se **zbrajaju**: `id`-evi iz
  `config/agents.json` (putanja: `TM_AGENTS_CONFIG`) i `TM_AGENTS=ana,ivan,marko`. `user` i
  `scheduler` vrijede uvijek — njih upisuje sam sustav.
- **Bez ijednog od ta dva izvora popis nije zatvoren**: provjerava se samo oblik imena
  (`[a-z][a-z0-9_-]{0,31}`). Svježa instalacija radi s bilo čijim timom; čim popis izraziš,
  provjera se pooštri i tipfeler dobiva `400` s nabrojanim dopuštenim imenima.
- Registar se čita pri svakoj provjeri, pa agent dodan poslije pokretanja ploče vrijedi bez
  restarta. Zbrajanje izvora (umjesto prvenstva) uklanja najčešći kvar prve instalacije —
  agent iz `agents.json` koji nije prepisan u `TM_AGENTS`.
- Poruka o odbijenom nositelju odsad kaže i što je krivo i gdje se popis mijenja, umjesto
  `invalid_enum_value` s našim imenima u odgovoru.

**Jedno ime, jedno značenje**
- `scripts/install-agents.sh` i `docs/AGENTI.md` koriste `TM_AGENTS_REGISTRY` za PUTANJU do
  registra PAI agenata. Dotad su `TM_AGENTS` (popis nositelja iz INSTALL.md),
  `$TM_AGENTS` (putanja iz AGENTI.md) i `TM_AGENTS_CONFIG` (stvarni kod) bili tri značenja
  pod dva slična imena.
- Usklađeni `docs/INSTALL.md` §5.1/§6/§11, `docs/API.md`, oba READMEa, `env.example`,
  `config/agents.example.json` i `templates/koraci.json`.

**Brana**
- `tests/agent-ids.test.ts` (14 testova) drži lanac razrješavanja, sustavske nositelje,
  pooštravanje bez restarta i odbijanje neispravnog oblika.
- `tests/bez-nasih-vrijednosti.test.ts` dobio strukturno pravilo: pada na svakoj novoj
  datoteci koja nabraja tri ili više naših imena i na povratku doslovnog imena u shemu
  zadatka. Tekstualni uzorci ovakvo ugrađivanje tima nisu mogli vidjeti.
- `bun test`: 202 pass / 0 fail (bilo 185).

## 2026-09-05 — generički ulaz `POST /api/ingest`

**Ulaz koji ne zna ni za jedan kanal**
- `POST /api/ingest` prima `source`, `externalId`, `replyTo`, `text`, `senderName` (uz
  neobavezne `projectId`, `assignee`, `tags`) i vraća odluku: je li otvoren zadatak, s kojom
  težinom, u kojem projektu i zašto. Most za dopisivanje, pretinac e-pošte i konzola odsad su
  samo pozivatelji — ocjena, pragovi i izbor projekta više nisu u njima.
- Zadatak i dalje nastaje kroz `POST /api/tasks`, jedini ulaz ploče: odbijenice vratara
  (reciklirani izvještaj 422, prazan sadržaj 422, strop stvaranja 429) prolaze nepromijenjene.
- Ocjena je deterministična i besplatna (razred težine + bodovi po koracima, datotekama i
  ponovnom pokušaju) — nijedan model ne stoji na putu dolazne poruke.
- Svaki poziv se zapisuje u `$TM_HOME/data/ingest.jsonl`, i u položaju `shadow` i u `on`.

**Postavke i predlošci**
- `config/ingest-gate.json` — položaj po izvoru (`off`/`shadow`/`on`), zadani projekt po
  izvoru i pragovi A/B/C. Ključ se traži od najužeg prema najširem
  (`source:externalId` → `externalId` → `source` → `*`); stari nazivi `perGroup` /
  `projectByGroup` i dalje rade. Čita se pri svakom pozivu — bez ponovnog pokretanja.
- `templates/koraci.json` i `templates/prvi-zadatak.md` — deset koraka tijeka rada i skelet
  opisa postali su PODATCI. Instalacija mijenja izvršitelje, alate i kanal dojave bez diranja
  koda; pravilo skaliranja po težini ostaje u kodu.

**Paket radi bez REGOČ instalacije**
- `TM_DB` / `TM_HOME` sada premještaju bazu zadataka, projekata, troška i reda poruka izvan
  rasporeda mapa orkestratora. Bez tih varijabli je putanja nepromijenjena.
- Red poruka stvara svoju mapu ako je nema — dotad poslužitelj na praznom `$HOME` uopće nije
  mogao krenuti (`unable to open database file`, izvan `try/catch`).
- Provjereno: `HOME` bez mapa orkestratora, `bun src/TaskWebUI.ts`, `curl POST /api/ingest`
  → `TASK-001` u `$TM_HOME/data/tasks.db`.

## 2026-09-04 — potrošnja, vrijednost rada i RAG

**Potrošnja po projektu**
- `GET /api/projects/trosak` — ukupna potrošnja po projektu iz `cost_log` (SQL, bez pokretanja
  vanjskih alata), uz prozor od 30 dana te datume prvog i zadnjeg rada (iz zadataka, ne iz
  `projects.created_at` koji često nastane naknadno).
- Kartica projekta prikazuje UKUPNU potrošnju, ne prozor — projekt bez izvođenja u zadnjih
  30 dana više ne pokazuje „—".
- Automatsko osvježavanje: Potrošnja 120 s, Projects 60 s, samo dok je kartica otvorena i
  prozor preglednika vidljiv.
- Pregled uz brojku vraća `kontrola` — kontrolni zbroj iz `cost_log` za isto razdoblje; ploča
  ispisuje „✔ slaže se" ili razliku. Zadano razdoblje pregleda je „svo vrijeme".

**Vrijednost rada po cjeniku S1–S6**
- `tools/vrijednost_inputa.py` — segmentira transkripte (žive i arhivirane) po korisničkoj
  poruci, razvrstava upit u S1–S6 iz zabilježenog rada (koraci, broj i vrsta poziva alata) i
  zbraja po korisniku, projektu i razredu. Trošak modela NIJE mjerilo složenosti.
- `GET /api/vrijednost-inputa` (keš 10 min) i odjeljak u kartici Potrošnja: tablica po
  korisnicima i tablica po projektima s punim nazivom projekta.
- Kartica projekta ima drugi chip — vrijednost (zeleno) uz trošak (plavo); hover pokazuje tko
  je radio. Panel projekta ima odjeljak „Tko je radio" s udjelima po osobama.

**Popis projekata**
- Sortiranje po zadnjem radu, potrošnji, imenu, početku rada i broju zadataka, uz obrtanje smjera.

**RAG**
- `tools/rag_audit.py` (pregled + tagiranje `project_id`), `tools/rag_tipovi.py` (vrsta
  dokumenta `tip_regoc` + oznaka `zasticeno` za pravila, lekcije i pogreške),
  `tools/rag_archive.py` (izvoz/uklanjanje/vraćanje uz zaštitu), `tools/rag_izdvoji.py`
  (izdvajanje znanja iz naslijeđenih kolekcija).
- Filtar po vrsti dokumenta u kartici RAG (`?tip=`), uz postojeći filtar po projektu.
- Brisanje kolekcije odbija se ako sadrži zaštićene dokumente ili ako se kolekcija čita pri
  pokretanju sjednice.

**Uvoz i razvrstavanje**
- `tools/uvoz_telegram_zadataka.py` (zahtjevi iz transkripata u zadatke, segment kao jedinica),
  `tools/razvrstaj_prijave.py` (svaka prijava svoj projekt), `tools/razvrstaj_pretinac.py`
  (tema s tri ili više zadataka dobiva projekt).

**Održavanje paketa**
- `scripts/uskladi_s_regocem.sh` — prijenos izmjena iz žive instalacije uz prepisivanje putanja
  uvoza; dosad se radilo rukom, pa je paket zaostajao.
