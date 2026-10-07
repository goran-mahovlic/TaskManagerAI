# Arhitektura i plan izvedbe — testiranje modela GLM-5.2 u REGOČ-u

- **Zadatak (dizajn):** TASK-205 (kosjenka · arhitekt)
- **Radni zadatak lanca:** TASK-194 (projekt PRJ-033 · težina 26)
- **Prethodni korak:** jelena — istraživanje sustava i memorije (`data/istrazivanja/TASK-194-istrazivanje.md`)
- **Izvor zahtjeva:** Goran, telegram grupa -5112799687, 2026-10-06 — *„Otvori zadatak za Jelenu testirati GLM5.2"*
- **Datum:** 2026-10-06

> **Što „GLM5.2" znači u ovom sustavu.** To nije nova komponenta nego **novi model** na već
> ugrađenom provideru `glm` (Zhipu / Z.ai). Provider je *anthropic-kompatibilan*: definiran u
> `~/.claude/regoc/models/model-config.json` (`providers.glm = { anthropicCompatible:true,
> baseUrl:"https://api.z.ai/api/anthropic", apiKey:"env:GLM_API_KEY" }`), danas prikvačen primjerom
> na `glm-4.6`. Zadatak je dokazati radi li **`glm-5.2`** kao drop-in model kroz postojeći put spawna.

---

## 1. Komponente (što sudjeluje i gdje je u kodu)

| # | Komponenta | Datoteka / lokacija | Uloga u testu |
|---|---|---|---|
| K1 | Konfiguracija modela | `~/.claude/regoc/models/model-config.json` | `providers.glm` + `agentOverrides.<agent>="glm:glm-5.2"` — jedina točka uključivanja |
| K2 | Rezolver modela | `~/.claude/regoc/models/ModelRouter.ts`, `models/ModelInterface.ts` | lanac `agentOverride → componentOverride → defaults[tier] → prvi enabled provider`; `parseModelSpec` cijepa `glm:glm-5.2` |
| K3 | Spawn-put za anthropic-kompatibilne | `~/.claude/regoc/RegocDaemon.ts` (~redak 1061–1072, 3222) | postavlja `ANTHROPIC_BASE_URL=baseUrl` + `ANTHROPIC_AUTH_TOKEN=GLM_API_KEY` i pokreće `claude --print` prema z.ai endpointu |
| K4 | Tajna | `GLM_API_KEY` u `credentials.env` (ili okolini) | **trenutno NIJE prisutna** (provjereno `secret_probe.py --name GLM_API_KEY → nije nađena`) — gating preduvjet |
| K5 | Daemon / orkestrator | `regoc-daemon` (systemd --user), `UnifiedSpawnPipeline.ts` | uzima `pending` zadatak, spawna test-agenta po K1–K3 |
| K6 | TaskManager + ploča/API | `:17781`, `~/.claude/regoc/data/regoc.db` | nosi test-zadatak, prima dokaz (REGOC-STATUS / resultSummary) |
| K7 | Verifikacija žive verzije | `~/.claude/regoc/StaleCodeCheck.ts`, `regoc-services.sh` | ako se dira daemon-kod, dokaz da pogon vrti novu verziju (ovdje se kod NE dira — v. §6) |
| K8 | Izvršitelj testa | agent **jelena** (inženjer, TDD/DiagnosingBugs) | izvodi mjerni plan iz §5 |

Capguard sklopka **`allow_internet`** mora biti uključena — z.ai je vanjski endpoint; nakon reboota je internet fail-closed (vidi CLAUDE.md §Sklopke). To je K4-ov par na razini mreže.

## 2. Tok podataka (jedan test-spawn, happy path)

```
Goran(telegram) ─► TaskManager:17781 ─► regoc.db (pending)
                                             │
                         regoc-daemon (K5) uzme zadatak
                                             │
        ModelRouter (K2): agentOverride "glm:glm-5.2" ─► parseModelSpec
                                             │
        RegocDaemon compat-grana (K3): spawnEnv{
            ANTHROPIC_BASE_URL = https://api.z.ai/api/anthropic
            ANTHROPIC_AUTH_TOKEN = $GLM_API_KEY (K4)
        } ─► claude --print  ──HTTPS──►  Z.ai (glm-5.2)
                                             │  (odgovor)
        agent ─► REGOC-STATUS + resultSummary ─► TaskManager ─► regoc.db
                                             │
                        report-back (klaudio) ─► telegram -5112799687
```
Granična točka povjerenja: `GLM_API_KEY` ulazi u okolinu djeteta i izlazi prema vanjskom hostu
`api.z.ai`. Ključ se **nikad ne ispisuje** u log, zadatak ni transkript (pravilo 1 + SecurityValidator hook).

## 3. Rizici i mitigacije

| R | Rizik | Vjer. | Učinak | Mitigacija |
|---|---|---|---|---|
| R1 | `GLM_API_KEY` nedostaje (K4 potvrđeno prazno) | **visoka** | živi test nemoguć | **Preduvjet-vrata:** zatraži od vlasnika unos ključa (Setup GUI / tab Sigurnost); do tada test `blocked`, ne izmišljati prolaz |
| R2 | Netočan model-id — Z.ai možda ne zove model baš `glm-5.2` (config primjer je `glm-4.6`) | srednja | 404/400 od providera | Korak T1: potvrdi točan naziv kod Z.ai; parametriziraj (`glm-4.6-staro` kao kontrola) |
| R3 | `allow_internet` isključen (fail-closed nakon reboota) | srednja | spawn ne doseže z.ai | provjeri `capabilities.state` prije T3; ako off → zatraži od vlasnika, ne zaobilazi |
| R4 | anthropic-nekompatibilnost odgovora (tool-use/stop_reason/stream drukčiji) | srednja | agent radi, ali alati/parsiranje pucaju | test MORA pokriti i tool-use i običan tekst (T4b), ne samo „pozdrav" |
| R5 | Trajni override zagadi produkciju — netko ostavi `agentOverrides` na glm-5.2 | niska | svi spawnovi agenta idu na glm | testiraj preko **dediciranog test-agenta/komponente ili privremenog overridea**, vrati config na kraju (T6); ne diraj `kosjenka/jelena/regoc` retke |
| R6 | Trošak / rate-limit Coding Plana | niska | zakočen test | ograniči broj poziva (≤ ~10), mjeri latenciju a ne volumen |
| R7 | Restart daemona radi config-reloada obori žive agente | srednja | prekinut rad tima | **ne diramo kod daemona** (§6); ako reload konfiguracije traži restart → samo kad je 0 `in_progress` i uz najavu u grupi (CLAUDE.md) |
| R8 | Tajna procuri u log/transkript | niska | kompromitacija ključa | nikad ne `cat` credential store; koristi `secret_probe.py`; spawn prosljeđuje ključ env-om |

## 4. Kriteriji prihvaćanja testa (što „GLM-5.2 radi" znači)

1. **Konektivnost:** spawn s `glm:glm-5.2` dobije HTTP 200 i neprazan odgovor od `api.z.ai`.
2. **Rezolucija:** `ModelRouter` za zadani override vrati `provider=glm, model=glm-5.2` (nije fallback na anthropic).
3. **Tekst:** jednostavan upit → suvisao odgovor na hrvatskom i engleskom.
4. **Tool-use:** zadatak s alatom (npr. jedan `read_file`/`bash`) prođe end-to-end kroz REGOČ pipeline.
5. **Stabilnost:** ≥ 8/10 uzastopnih poziva uspješno; zabilježena medijan-latencija.
6. **Čistoća:** nakon testa config vraćen u polazno stanje; nijedan produkcijski agent trajno prebačen; ključ nije procurio.

## 5. Redoslijed koraka (plan izvedbe za Jelenu)

> Metodologija: TDD/DiagnosingBugs gdje ima mjerenja; svaki korak ostavlja **ponovljiv dokaz**.

- **T0 — Preduvjeti (vrata).**
  `secret_probe.py --name GLM_API_KEY` mora biti ✅ i `allow_internet=on` (`cat /etc/regoc/capabilities.state`).
  Ako nije → zadatak **`blocked` / `NEEDS_CONTEXT`**: „čeka GLM_API_KEY i/ili allow_internet od vlasnika". **Ovdje stajemo ako R1/R3 vrijede.**
- **T1 — Potvrdi model-id.** Utvrdi točan naziv modela kod Z.ai (`glm-5.2` vs varijanta). Zapiši izvor.
- **T2 — Izolirani override.** U `model-config.json` dodaj **test-cilj** (dedicirani test-agent ili privremeni override jednog ne-kritičnog agenta) na `"glm:glm-5.2"`. NE mijenjaj `kosjenka/jelena/regoc`. Snimi `git diff` kao dokaz.
- **T3 — Smoke (konektivnost).** Jedan spawn/poziv prema z.ai; očekuj 200 + tekst. Dokaz: http-status + prvih N znakova odgovora (bez ključa).
- **T4 — Funkcionalni testovi.**
  - T4a tekst (HR/EN) — kriterij §4.3
  - T4b tool-use (jedan alat kroz REGOČ pipeline) — kriterij §4.4
- **T5 — Stabilnost/latencija.** 10 poziva; zabilježi uspjeh/neuspjeh i medijan ms (kriterij §4.5).
- **T6 — Čišćenje.** Vrati `model-config.json` u polazno stanje; potvrdi `git status` čist; potvrdi da nijedan produkcijski agent nije ostao na glm. (kriterij §4.6)
- **T7 — Izvještaj.** Rezultat u `resultSummary` + REGOC-IZLAZ s dokazima; report-back agent javlja Goranu na telegram.

Ovisnosti: **T0 → (T1, T3)**; T3 → T4 → T5 → **T6 → T7**. T0 je tvrda prepreka; bez nje se ne ide dalje.

## 6. Odluka o opsegu (ADR-lite)

**Odluka:** Test ide **samo kroz konfiguraciju i spawn-put**, bez izmjene koda daemona.
**Razlog:** put za anthropic-kompatibilne providere već postoji (`RegocDaemon.ts` ~3222); GLM-5.2 je
*podatak* (naziv modela), ne nova grana koda. Time otpada VERIFICATION GATE/StaleCodeCheck i rizik
restarta živih agenata (R7). Ako T3/T4 otkriju nekompatibilnost odgovora (R4) koja traži zakrpu
koda — to je **novi** zadatak za inženjera (zaseban dizajn), ne dio ovog testa.

**Posljedica:** isporuka ovog koraka je *plan* (ovaj dokument). Izvođenje T0–T7 je zadatak za
jelenu; njezin živi test ovisi o preduvjetu R1 (ključ) koji drži vlasnik.

## 7. Izvori (grounding)

- `~/.claude/regoc/models/model-config.json` — `providers.glm`, `agentOverrides`, `defaults`
- `~/.claude/regoc/RegocDaemon.ts` — compat spawn (ANTHROPIC_BASE_URL/AUTH_TOKEN), ~1061–1072, 3222
- `~/.claude/regoc/models/ModelRouter.ts` + `models/ModelInterface.ts` — rezolucijski lanac
- `secret_probe.py --name GLM_API_KEY` → `nije nađena ni u jednom storeu` (2026-10-06)
- `/home/regoc/CLAUDE.md` — sklopke (allow_internet, fail-closed), pravila restarta i tajni
- `data/istrazivanja/TASK-194-istrazivanje.md` — kontekst sustava i memorije (jelena)
