# Izvedba testa GLM-5.2 — PASS/FAIL po T0–T7 + negativni test (TASK-212 · jelena · engineer)

- **Izvedbeni zadatak:** TASK-212 (jelena) — izvedba plana TASK-205 (kosjenka), uz nalaze TASK-206 (dora) i QA TASK-207 (potjeh).
- **Lanac:** jelena istraživanje (TASK-194) → kosjenka plan (TASK-205) → dora analiza (TASK-206) → potjeh QA (TASK-207) → jelena dorade (TASK-209/210) → **jelena izvedba (TASK-212)**.
- **Izvor zahtjeva:** Goran, telegram -5112799687:109, 2026-10-06 — „Otvori zadatak za Jelenu testirati GLM5.2".
- **Datum izvedbe:** 2026-10-07 · **Projekt:** PRJ-001 (REGOČ) · **Grana:** zadatak/TASK-194.
- **Polazi od:** `data/arhitektura/TASK-194-plan-test-glm52.md` + već commitan offline test `data/arhitektura/TASK-194-glm52-resolve.test.ts` (6 pass). NE ponavljam ih — dodajem živi dokaz i konačnu potvrdu model-id-a.

---

## Sažetak ishoda

| Korak | Ishod | Dokaz |
|---|---|---|
| **T0** Preduvjeti (vrata) | **BLOCKED (R1)** — internet OK, ključ odsutan | internet ON; `GLM_API_KEY` odsutan |
| **T1** Potvrda model-id | **PASS** | `glm-5.2` potvrđen iz z.ai `llms.txt` (uz nalaz: `glm-5.3` je sada najnoviji) |
| **T2** Izolirani override | **PASS** | fixture/componentOverride, produkcija netaknuta |
| **T3** Smoke (konektivnost) | **BLOCKED** | čeka valjan `GLM_API_KEY` (R1) |
| **T4** Funkcionalni (tekst/tool-use) | **BLOCKED** | čeka valjan `GLM_API_KEY` (R1) |
| **T5** Stabilnost/latencija | **BLOCKED** | čeka valjan `GLM_API_KEY` (R1) |
| **T6** Čišćenje/revert | **PASS** | produkcijski `model-config.json` bez `glm-5.2`/test-overridea; 12 agenata i dalje `anthropic:opus` |
| **T7** Izvještaj | **PASS** | ovaj dokument + resultSummary TASK-212 |
| **Negativni test (dora F3)** | **PASS** | prazan ključ → spawn preskočen (guard `RegocDaemon.ts:3014/3017`); nevaljan ključ → z.ai HTTP 401, NIKAD tihi fallback na anthropic |

**Presuda:** Svi koraci izvedivi bez valjanog ključa su **PASS**. Živi pozivi (T3–T5) ostaju **BLOCKED** na tvrdom blokeru R1 (vlasnik mora unijeti `GLM_API_KEY`). Negativni test — najvažniji sigurnosni kriterij — **PASS**: sustav NE radi tihi fallback na anthropic.

---

## T0 — Preduvjeti (vrata)

```
$ python3 ~/.claude/regoc/tools/secret_probe.py --name GLM_API_KEY
❌ GLM_API_KEY: nije nađena ni u jednom storeu
$ (env check) GLM_API_KEY NOT in env
$ cat /etc/regoc/capabilities.state   # allow_internet
"allow_internet": {"on": true, "tier": 2}   # (updated 2026-10-07T08:14:14Z)
```

- `allow_internet` = **ON** → R3 zatvoren (dorin ispravak potvrđen; plan ga je precijenio).
- `GLM_API_KEY` = **ODSUTAN** → **R1 tvrdi bloker stoji**. Po plan-pravilu „Ovdje stajemo ako R1/R3 vrijede" → živi test (T3–T5) je **blocked**, NE izmišljam prolaz.

## T1 — Potvrda model-id (**PASS**, ovo je TASK-212 ključni novi nalaz)

Config je nosio samo *primjer* `glm-4.6`. Provjereno kod izvora (internet ON):

- z.ai `llms.txt` eksplicitno navodi model-id **`glm-5.2`** (uz `glm-5.3`, `glm-5.3-flash`, `glm-ocr`, `glm-asr-2512`).
- z.ai developer docs (`/devpack/quick-start`, `/devpack/latest-model`): anthropic-protokol baseUrl = `https://api.z.ai/api/anthropic`; **najnoviji** modeli su sada `glm-5.3`/`glm-5.3-flash` (plan je prešao 5.2). GLM-5.2 je prethodni naraštaj, ali i dalje valjan model-id.
- **Zaključak:** točan string za parametar `model` je **`glm-5.2`** (mala slova, crtica). Konvencija imenovanja potvrđena (`glm-5.3`, `glm-4.6` isti oblik). Kontrolni model za usporedbu: `glm-4.6`.

Izvori: z.ai `llms.txt`, `docs.z.ai/devpack/quick-start`, `docs.z.ai/devpack/latest-model`.

## T2 — Izolirani override (**PASS**)

Rezolucija dokazana kroz izdvojeni fixture/`componentOverride` (`glm:glm-5.2`), bez diranja produkcije:

```
$ bun test data/arhitektura/TASK-194-glm52-resolve.test.ts
6 pass, 0 fail, 15 expect() calls
```
Potvrđuje §4.2: `ModelRouter.resolve` za `glm:glm-5.2` vraća `{provider:'glm', model:'glm-5.2'}` — **ne** anthropic fallback. Dodatna neovisna re-provjera (vlastiti fixture, TASK-212): `4 pass, 0 fail` (glm-5.2, glm-4.6 kontrola, parseModelSpec, default→anthropic sanity).

## T3–T5 — Konektivnost / funkcionalni / stabilnost (**BLOCKED na R1**)

Nemoguće bez valjanog ključa. Čim vlasnik unese `GLM_API_KEY`:
- T3: jedan spawn `glm:glm-5.2` → očekuj HTTP 200 + neprazan tekst s `api.z.ai`.
- T4a tekst HR/EN; T4b tool-use (jedan `read_file`/`bash`) kroz REGOČ pipeline.
- T5: 10 poziva, ≥8/10 OK, medijan latencije; abort nakon 3× uzastopna 5xx (dora P3).

## T6 — Čišćenje (**PASS**)

- Produkcijski `~/.claude/regoc/models/model-config.json`: `grep glm-5.2|glmtest|glmcontrol` → ništa (test override NIJE procurio).
- `agentOverrides`: svih 12 produkcijskih agenata i dalje `anthropic:opus` — nijedan nije prebačen na glm.
- Svi test-artefakti žive u pješčaniku `~/app/tmp/TASK-212/` (fixture + skripte), izvan produkcije i izvan repo-a. (`~/.claude/regoc` nije git repo pa „git diff" N/A; čistoća dokazana sadržajno.)

## Negativni test (dora F3) — **PASS** (kritični kriterij)

Zahtjev: s nevaljanim/praznim ključem poziv mora dati grešku/blocked, a **ne** tihi fallback na anthropic (koji bi lažno prošao kao „GLM radi").

1. **Prazan/odsutan ključ → spawn se PRESKAČE.** `getAnthropicCompatProvider` (`RegocDaemon.ts:1066`) kad je token prazan vraća `null` (r.1075); guard na r.3013–3018 tada izvrši `return` (r.3017) i pošalje poruku „Provider 'glm' nije konfiguriran kao anthropic-kompatibilan" — agent se **ne spawna**. NEMA grane koja bi u tom slučaju spawnala anthropic.
   - Dokaz (replika točne logike nad STVARNIM configom, TASK-212 `negtest-compat.ts`): scenariji A (odsutan), B (prazan string) → `ABORT_SPAWN`; C (nevaljan ne-prazan) → `SPAWN_TO z.ai`; kontrola „NIKAD SPAWN_ANTHROPIC" → **4 pass, 0 fail**.
   - Dokaz (commitani test, offline): token-gate `null` za prazan ključ — `TASK-194-glm52-resolve.test.ts` #4–#5 (dio 6 pass).

2. **Nevaljan ne-prazan ključ → ide na z.ai, dobije 401.** Spawn-grana (r.3220–3225) postavi `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` + `ANTHROPIC_AUTH_TOKEN=<token>` → `claude --print` fizički gađa z.ai, NE anthropic.
   - Živi dokaz (internet ON): `POST https://api.z.ai/api/anthropic/v1/messages` s nevaljanim ključem → **HTTP 401** `{"error":{"message":"token expired or incorrect","type":"401"}}`.
   - Živi dokaz (CLI repro): `claude --print --model glm-5.2` s nevaljanim compat-env-om → **nema odgovora** (timeout/retry na 401), tj. NIJE bilo tihog uspjeha preko anthropic pretplate.

**Zaključak F3:** ni u jednom scenariju (prazan / nevaljan ključ) nema tihog fallbacka na anthropic. Prazan ključ → vidljiv preskok s porukom; nevaljan ključ → vidljiva 401 greška s z.ai. ✅

---

## Što preostaje (za vlasnika i za sljedeću izvedbu)

1. **Vlasnik:** unijeti `GLM_API_KEY` (Setup GUI / tab Sigurnost). To je JEDINA preostala tvrda prepreka.
2. Nakon unosa ključa: izvršitelj pokreće T3→T5 po ovom dokumentu (model `glm-5.2`, kontrola `glm-4.6`), uz abort-prag 3× 5xx i mjerenje medijan-latencije; T6 revert + T7 dojava Goranu.

## Izvori (grounding)
- `data/arhitektura/TASK-194-plan-test-glm52.md` (plan T0–T7, kosjenka)
- `data/arhitektura/TASK-194-glm52-resolve.test.ts` (offline test, 6 pass)
- `data/analize/TASK-194-analiza-dora.md` (F3 negativni test, dora)
- `~/.claude/regoc/RegocDaemon.ts` r.1066–1078 (compat token-gate), r.3013–3018 (guard/return), r.3220–3225 (compat spawn env)
- `~/.claude/regoc/models/ModelRouter.ts` + `models/ModelInterface.ts` (rezolucija, parseModelSpec)
- z.ai: `llms.txt` (model-id `glm-5.2`), `docs.z.ai/devpack/quick-start`, `docs.z.ai/devpack/latest-model`
- živi probe: z.ai `/v1/messages` nevaljan ključ → HTTP 401; `/etc/regoc/capabilities.state` → allow_internet ON; `secret_probe.py` → GLM_API_KEY odsutan
