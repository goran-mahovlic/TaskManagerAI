# TASK-5306 — QA: „prebaci sve na model" i rad uz potrošenu Anthropic sesiju

| | |
|---|---|
| **Datum** | 07.10.2026. |
| **QA** | Potjeh |
| **Predmet** | izvedba TASK-5305 (Jelena): `PrebaciSve.ts`, `GET/PUT /api/models/svi`, `ProviderVrata.ts`, kvota razgovora samo za Anthropic. Dizajn: ADR „vrata po provideru" (TASK-5304, nakon TASK-5311 preimenovan u ADR-0005) |
| **Sustavi** | glavni (dell-home: daemon PID 4005529, ploča `TaskManagerMD` PID 4005732) i node-A (daemon 768884, ploča 768883). StaleCodeCheck na sve četiri procesa: „kod na disku == kod u pogonu" |

## Metoda
- **Prebacivanje** ide istim `PUT /api/models/svi` koji zove gumb na Config stranici. **Povratak** je isti PUT s `{"model":"vrati"}`.
- **Simulirana potrošena sesija** (`sim_snimka.py`): petlja svake 2 s prepisuje `data/session_usage.cache.json` (`cached_at` = sada) koji čitaju daemon i CLI kuka. Na node-A je 99 % (prag `sessionBlock` 90). Na glavnom je 96 %, što je ≥ 95 (Config), a < 97 (`BLOCK_THRESHOLD` kuke), pa se Goranov Klaudio ne blokira i ne šalje poruku o blokadi. Na kraju slijedi `kill` i svježe stvarno mjerenje.
- **Spawn** je pravi auto-exec daemona (probni zadaci P1, `potjeh`). Odgovor nosi žeton `PONG-…` kao dokaz da je model stvarno radio. Model se čita iz `data/run_log.jsonl` (`provider`, `model`, `session_percent_prije`).
- **Razgovor:**
  - node-A (Šaban): `razgovor_proba.ts` vrti isporučeni `stvoriRazgovor` + `RazgovorPloca.modelPrebacen/modelIzKonfiguracije/ciljModelaRazgovora` nad pravim `model-config.json` i pravi `claude -p`. Kanal je lažan. Model se čita iz `message.model` u transkriptu sesije.
  - glavni (Klaudio): `klaudio_proba.ts` = `readModelConfig → resolveKlaudioTarget → planKlaudioSpawn → spawn plana`, isti put kao `telegram_agent.ts:810`.

## Rezultati — node-A (`e2e_nodea.out`)
| # | Korak | Očekivano | Izmjereno | |
|---|---|---|---|---|
| 1 | PUT svi → `openrouter:z-ai/glm-5.2` | 200, sve izvršne uloge | HTTP 200, 17 polja (defaults, svi agenti, `razgovor`); `embeddings` i `classifier` netaknuti | ✅ |
| 1b | PUT `nepostoji:xyz` | 400 | HTTP 400 `Unknown model spec` | ✅ |
| 2 | TASK-272 uz sesiju 99 % i prekidač na OpenRouter | spawn ide | `▶️ [vrata po provideru] 1 zadatak(a) … (openrouter)`, zatim `⚡ Auto-exec P1: TASK-272 -> potjeh (openrouter:z-ai/glm-5.2)`; run_log `provider:openrouter, model:z-ai/glm-5.2, session_percent_prije:99`; rezultat `PONG-A-openrouter-99` | ✅ |
| 3 | Razgovor R1 (prekidač, 99 %) | GLM odgovara, kvota se ne pita | `kvotaPitana:0`, `baseUrl:https://openrouter.ai/api`, transkript `z-ai/glm-5.2`, žeton vraćen | ✅ |
| 4 | „Vrati" | stanje = prije | defaults, agentOverrides i componentOverrides IDENTIČNO prije; snimka `_prebaciSvePrije` uklonjena | ✅ |
| 5 | TASK-273 (Anthropic) uz 99 % | stoji | 60 s `pending`, `⛔ [autonomy] sesija 99 % ≥ 90 % … 1 zadataka čeka obnovu kvote` (4×) | ✅ |
| 6 | Razgovor R2 (Anthropic, 99 %) | poruka kvote, 0 poziva | `kvotaPitana:1`, `pozivi:[]`, odgovor „Kvota je pri kraju — odgovaram kad se obnovi." | ✅ |
| 7 | Kraj simulacije (stvarno 14 %) | Anthropic kreće | `⚡ Auto-exec P1: TASK-273 -> potjeh (anthropic:opus)` u prvom prolazu nakon mjerenja; PONG-B vraćen | ✅ |
| 8 | Razgovor R3 (Anthropic, 14 %) | Claude odgovara | transkript `claude-opus-4-8`, žeton vraćen | ✅ |
| 9 | Mjerilo node-A svježe | ≤ 5 min | 275 zapisa, razmak prosječno 4,9 min (najviše 5,2), zadnji star 0,5 min; `autonomyGate.enabled=true`; pragovi iz Config-a (75/80/90, `source: settings`) | ✅ |

## Rezultati — glavni sustav (`e2e_glavni.out`)
| # | Korak | Izmjereno | |
|---|---|---|---|
| 1 | PUT svi → OpenRouter | HTTP 200, 19 polja (uz `kriticar` i `componentOverrides.hindsight`) | ✅ |
| 2 | TASK-5324 uz sesiju 96 % | `▶️ [vrata po provideru] 4 zadatak(a) … (openrouter)` i `⚡ Auto-exec P1: TASK-5324 -> potjeh (openrouter:z-ai/glm-5.2)`; run_log `session_percent_prije:96`; PONG vraćen | ✅ |
| 3 | Klaudio K1 (prekidač) | `target openrouter/z-ai/glm-5.2`, izvršitelj `openrouter-agent.ts`, exit 0, žeton vraćen | ✅ |
| 4 | „Vrati" | IDENTIČNO u sva tri dijela, snimka uklonjena | ✅ |
| 5 | TASK-5325 (Anthropic) uz 96 % | 45 s `pending`, `⛔ [autonomy] sesija 96 % ≥ 95 %` (3×) | ✅ |
| 6 | Klaudio K2 (vraćeno) | `anthropic/opus`, `modelUsage claude-opus-5-5`, žeton vraćen | ✅ |
| 7 | Kraj simulacije (stvarno 32 %) | `⚡ Auto-exec P1: TASK-5325 -> potjeh (anthropic:opus)`, run_log `claude-opus-5-5` | ✅ |
| 8 | Prozor prebacivanja (13:10:51–13:11:5x) | samo TASK-5324 je otišao na OpenRouter; Mandin TASK-5313 krenuo je u 13:12:28 nakon povratka, na `anthropic:opus` | ✅ |

Testovi: paket `bun test` = **1545 pass, 0 fail** (77 datoteka); glavni `tests/provider-vrata.test.ts` = 4 pass, 0 fail.

## Nalazi (nisu blokirajući za ovaj nalog)
1. **CLI kuka u paketu nema propuštanja za ne-Anthropic `ANTHROPIC_BASE_URL`.** Glavni ga ima (`72e8012`), a `TaskManagerAI/tools/session_usage.py` (paket i node-A) nema. Na node-A to znači sljedeće: `claude` CLI preusmjeren na kimi/glm/OpenRouter s korisničkim kukama bit će blokiran na `BLOCK_THRESHOLD`. Razgovor (izolirane postavke) i OpenRouter spawn (`openrouter-agent.ts`) to ne pogađa, a izmjereni E2E je prošao.
2. **Google izravno nije u izborniku.** `providers.google.enabled=false`, a `geminicli` nije na popisu `/api/models/available`. „Sve na Google" danas ide samo kao `openrouter:google/gemini-2.5-pro|flash`. PUT `google:…` bi vratio 400 (nije u popisu); to je izvedeno iz koda i popisa, ne pokretano, da se sustav ne prebaci.
3. **Trošak OpenRouter spawna se ne mjeri.** run_log ima `tokens 0, cost 0, cost_source none` za `openrouter-agent.ts`, pa ploča ne vidi novac potrošen na OpenRouteru (ADR K3 nije izveden).
4. **`componentOverrides.hindsight` se prebacuje u configu**, ali Hindsight model čita pri pokretanju. Bez `hindsight_uskladi.ts` stvarno ostaje na starom modelu.
5. **`/tmp` na glavnom stroju je tmpfs od 100 MB i 100 % je pun.** `bun test` koji piše u `tmpdir()` pada s `ENOSPC` / `JSON Parse error: Unexpected EOF` (prvi prolaz: 8 lažnih padova u `razgovor-jezgra`, 1 u `provider-vrata`). Uz `TMPDIR` u radnoj mapi sve prolazi.
6. Automatski prelazak na OpenRouter na pragu (ADR §6/K7) **nije izveden** (uputa #189 je suzila opseg). Prebacivanje je ručno, jednim potezom.

## Krug popravka (07./08.10.2026., nakon kritičara)

Kritičar je javio 13 palih testova paketa. Uzrok nije kod nego okolina: tada je `/tmp` (tmpfs od 100 MB) bio 100 % pun, što je nalaz 5 gore. Greške su bile `ENOSPC` i lančani padovi u istom procesu.

- `/tmp` je sada 7 % zauzet (6,3 MB od 100 MB).
- Svih 10 navedenih datoteka (`session-usage-van-anthropica`, `task-dorada-api`, `task-dorada-sql`, `telegram-obavijest-jednom`, `razgovor-jezgra`, `telegram-privitci`, `razgovor-identitet`, `razgovor-bot-kanal`, `profil-cvora`, `razgovor-dijelovi`) pojedinačno prolazi s 0 fail.
- Cijeli paket na HEAD `9f1b5c7` (bez `TMPDIR`, dakle kao kritičar): **1795 pass / 0 fail**, zapis u `bun_test_paket_krug2.out`.

Pogon, ponovno provjeren u 00:35 CEST:
- **Glavni:** `GET /api/models/svi` vraća `aktivno:false` (natrag na Claude). `session_usage.cache.json` je star 7 s.
- **node-A:** `GET /api/models/svi` vraća `cilj:anthropic:opus`, `tko:ploca`, `kada:2026-10-07T15:05:42Z`. To znači da je netko i s ploče, kroz izbornik, sam vratio sustav na Claude. `defaults` su svi `anthropic:opus`. Mjerilo je svježe: zadnji upis u `session_usage.jsonl` je od 22:31:54Z, status `allowed`, `http_error` je null. Simulator ne radi.
- **node-A, stvarni pogon (nije simulacija):** 14:47–14:50Z daemon je uz STVARNU sesiju od 91 % (≥ 90) ispisao `▶️ [vrata po provideru] … openrouter — Anthropic kvota ih ne koči`. To je kriterij (3) potvrđen na pravoj potrošnji.
