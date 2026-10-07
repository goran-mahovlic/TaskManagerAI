# ADR-0005 — Vrata potrošnje po provideru i prekidač „svi na model"

| | |
|---|---|
| **Stanje** | Prijedlog (dizajn, bez koda) — čeka Goranove odluke iz §9, zatim izvedbu (Jelena, §8) |
| **Datum** | 07.10.2026. |
| **Broj** | Zapisan kao ADR-0004 (TASK-5304); preimenovan u ADR-0005 pri spajanju u main (TASK-5311) jer je ADR-0004 već profil čvora (TASK-5295, 06.10.). Commiti TASK-5304/5305 ga zovu „ADR-0004". |
| **Autorica** | Kosjenka (Architect), TASK-5304 (PRJ-048) |
| **Nalog** | Goran, grupa REGOČ, 07.10.2026.: (1) node-A se mora moći CIJELI preseliti na OpenRouter kad je Anthropic sesija potrošena; (2) mjerenje sesije na node-A „ne radi pa se potroši do 100 %"; (3) OpenRouter i ostali ne-Anthropic modeli NE smiju reagirati na potrošnju Anthropic sesije; (4) jedan padajući izbornik „prebaci sve na model" (Config) |
| **Vrijedi za** | oba sustava: glavni (dell-home, `~/.claude/regoc`) i paket TaskManagerAI (node-A 192.168.10.20, `~/TaskManagerAI` + `~/.claude/regoc` na čvoru) |
| **Nadograđuje** | `WorkStateJournal.ts` (vrata autonomije, Goranove odluke 28./29.07.2026.), TASK-5028 (`AutonomyThresholdSetting.ts`), ADR-0002 §6.2 (vrata razgovora), `tools/modeli/node_model_policy.py` |
| **Kopija/poveznica** | `~/app/regoc_system/docs/ADR-0019-vrata-po-provideru-i-prekidac-svi-na-model.md` |

---

## 1. Problem u tri rečenice

Vrata potrošnje danas imaju **jedan** ulaz — Anthropic mjerenje (`session_usage.py` → `autonomyTierFromUsage`) — i
primjenjuju ga na **sve** izvršitelje, bez obzira vozi li zadatak Opus preko pretplate ili GLM preko OpenRoutera. Zato
potrošena Anthropic sesija zaustavlja i put koji s njom nema veze (Goranova točka 3), a na node-A su ista ta vrata
**ugašena** (SHADOW), pa Anthropic sesija ide do 100 % (točka 2). Model se bira na pet mjesta (agentOverrides,
componentOverrides, TIER, `razgovor.model`, Klaudijev `KlaudioModel.ts`) i ne postoji jedan potez koji cijeli sustav
prebacuje na drugi model (točke 1 i 4).

---

## 2. Dijagnoza node-A: zašto je sesija 06.10. stigla do 100 % (točka d)

Sva vremena su **UTC** (node-A radi u EDT, `daemon.log` i `session_usage.jsonl` pišu UTC). Izvori:
`regoc@192.168.10.20:~/.claude/regoc/daemon.log`, `…/data/session_usage.jsonl`, `…/features.json`,
`…/data/regoc.db` (tablica `settings`), transkripti `~/.claude/projects/*/*.jsonl` na čvoru.

### 2.1 Mjerenje RADI — nije uzrok
`session_usage.jsonl` ima 218 zapisa od 05.10., otprilike svakih 5 min. Mjerilo je uredno pratilo oba prozora:

| Prozor (reset) | Tijek |
|---|---|
| A (reset 16:30) | 14:48 **43 %** → 15:33 77 % → 15:37 80 % → 16:02 91 % → (16:07–16:12 stoji na 91 %) → 16:28 **95 %** |
| B (reset 21:30) | 16:33 **4 %** → 16:58 40 % → 17:22 69 % → 17:31 82 % → 17:36 91 % → 17:41 98 % → 17:46 **100 % `rejected`** → `rejected` do kraja prozora |

`status: "allowed"` do 100 % **nije kvar mjerila**: to je Anthropicov status zahtjeva („još prolazi"), a ne preporuka.
Vrata ne smiju čitati `status`, nego postotak — i to rade.

### 2.2 Uzrok 1 (glavni): vrata autonomije na node-A su u SHADOW načinu
`~/.claude/regoc/features.json` na node-A:
```
"autonomyGate": { "enabled": false, ...
  "note": "TASK-4777: ugaseno jer session_usage.py ne mjeri (blindDecision => fail-open)" }
```
Na glavnom stroju je ista zastavica `enabled: true`. Vrata su na čvoru ugašena 09.09. dok mjerilo nije radilo
(čvor nije imao prijavu) i **nikad nisu vraćena** kad je mjerilo proradilo. U SHADOW načinu
(`RegocDaemon.ts:6846`, `const live = isEnabled('autonomyGate', false)`) daemon samo zapiše što bi zaustavio i pokrene
posao. Doslovni dokaz iz `daemon.log`:

```
[2026-10-06T17:40:13.696Z] 👁️ [autonomy SHADOW] sesija 91 % ≥ 85 % — bez multiagenata, tražim potvrdu prije početka — 1 zadataka čeka obnovu kvote
[2026-10-06T17:40:13.725Z] ⚡ Auto-exec P3: TASK-189 -> jelena (anthropic:opus)
[2026-10-06T17:41:45.881Z] 👁️ [autonomy SHADOW] sesija 98 % ≥ 95 % — odgovaram, ali ništa se ne izvršava do obnove kvote — 1 zadataka čeka obnovu kvote
[2026-10-06T17:41:45.912Z] ⚡ Auto-exec P1: TASK-190 -> kosjenka (anthropic:opus)
```
Isto u 15:28:39 (70 %, TASK-163) i u 17:31:18 (82 %, TASK-177). Toga dana: **41 auto-exec**, od toga 35 `anthropic:opus`
i 6 `openrouter:z-ai/glm-5.2`.

### 2.3 Uzrok 2: pragovi s Config stranice (75/80/90) daemon ne čita ni na jednom sustavu
`regoc.db` na node-A ima `autonomy.session_autonomy=75`, `autonomy.session_caution=80` i `autonomy.session_block=90`
(TASK-5028, Config). Daemon ipak piše „70 % ≥ 70 %", „91 % ≥ 85 %" i „98 % ≥ 95 %", dakle radi s konstantama u kodu
(`WorkStateJournal.ts`: `SESSION_AUTONOMY_PERCENT=70`, `CAUTION=85`, `BLOCK=95`).
`grep -rl "AutonomyThreshold\|autonomy.session" ~/.claude/regoc --include=*.ts` na **oba** stroja vraća 0 datoteka.
Pragove iz `settings` čita samo razgovor (`TaskWebUI.ts:10845`, `kvotaPuna`). Postavka postoji i pamti se, ali daemon
je ne vidi. Za Gorana to znači da broj koji je upisao na Config stranici ne radi ono što piše.
Isti obrazac vrijedi i za strop usporednih agenata: Config kaže `agents.max_concurrent=1`, a daemon na node-A piše
„Max concurrent spawns: 3". Daemon na node-A (7433 retka) zaostaje za glavnim (8339 redaka) i nema `ConcurrencySetting`.

### 2.4 Tko je trošio (prozor B, 16:31–17:47, tokeni iz transkripata na čvoru)

| Potrošač | Poruka | Izlaz | Cache čitanje | Cache pisanje | Model |
|---|---:|---:|---:|---:|---|
| **Spawnovi daemona** (`-home-regoc`, sdk-cli, prompt „Ti si Jelena/Kosjenka…") | 151 | 162 828 | 5 654 584 | 1 485 706 | opus-4-8 (+1 haiku proba) |
| E2E probe razgovora s glavnog stroja (TASK-5278/5279/5281/5293) | 77 | 16 703 | 1 353 858 | 328 661 | opus/haiku |
| Šabanov razgovor (`taskmanager-data-razgovor-radni*`) | 21 | 11 750 | 208 269 | 107 629 | opus-4-8 |
| ostalo (`-tmp`) | 2 | 700 | 0 | 23 878 | haiku |

**Spawnovi daemona čine ≈ 80 % tokena** u tom prozoru: TASK-172 (0,98 USD), TASK-173 (0,89 USD), TASK-178 (0,49 USD),
TASK-177 (1,12 USD), TASK-182 (1,86 USD), TASK-189 (0,66 USD) i TASK-190 (0,68 USD), ukupno **6,68 USD po CLI cijeni za
96 postotnih bodova**. Sesija na node-A je mala: **jedan Opus zadatak pojede 5–25 pp**. Zato vrata koja kasne i jedan
prolaz (15 s) na ovom čvoru znače desetke postotnih bodova.

Ostali kandidati koje je REGOČ naveo:
- **spawnOnRequest** nije trošio: svi spawnovi u prozoru su `Auto-exec`, nijedan nije nalog s Telegrama.
- **Hindsight** se u logu vidi samo kao „🧠 [memorija SHADOW] … dohvat u pozadini (banka regoc_opus_nodea)". To je
  poslužitelj na 17792 s vlastitim modelom i nema Claude transkript, pa po ovim mjerenjima ne troši Anthropic sesiju.
  Nije izmjereno koji model Hindsight koristi na čvoru, vidi §10.

### 2.5 Sporedni nalazi
- **Pet restarta daemona** u prozorima (15:16, 15:27, 17:07, 17:26 i 17:31) zbog isporuka. Restart u 17:26 ubio je
  TASK-178 nakon 30 s, pa je 0,49 USD potrošeno bez rezultata. Isporuka na čvor treba ići kroz
  `restart_kad_mirno.sh`, a ne izravno.
- **„Sve je blokirano"** (Goranova točka 3): u 17:46 status prelazi u `rejected` i `autonomyTierFromUsage` vraća
  `answer-only` za **sve**. To uključuje i zadatke kojima je `agentOverrides` `openrouter:…`. Šabanova vrata kvote
  (`kvotaPuna`) također ne pitaju koji je model. Kad bi se `razgovor.model` i prebacio na OpenRouter, razgovor bi i
  dalje rekao „Kvota je pri kraju".

---

## 3. Odluka u jednoj rečenici

**Kvota pripada vjerodajnici izvršitelja, a ne sustavu. Svaki poziv modelu najprije razriješi KONAČNI izvršitelj
(uključujući globalni prekidač „svi na model"), pa tek onda pita vrata te obitelji kvote. Anthropic mjerenje gasi samo
Anthropic izvršitelje; OpenRouter ima vlastito mjerilo (stanje ključa), Ollama nema nikakvo. Jedina globalna kočnica
ostaje ručna pauza s ploče.**

```
zadatak/poruka/uloga ──► razrijesiIzvrsitelja(uloga, agent, zadatak)
                           1. model.svi (globalni prekidač)          ─┐
                           2. model.prelazak (automatski, §6)          │  prvi koji vrijedi
                           3. task tier / agentOverrides / componentOverrides / razgovor.model
                           4. defaults
                         ──► SpawnTarget {provider, model, node, izvrsitelj}
                         ──► obiteljKvote(target)  → 'anthropic' | 'openrouter' | 'nema'
                         ──► vrata(obitelj, tko je pokrenuo)  → pusti / čekaj / odbij
```

---

## 4. Vrata po provideru (točka a)

### 4.1 Obitelj kvote = čija se vjerodajnica troši
| Provider u `model-config.json` | Izvršitelj | Obitelj kvote | Mjerilo |
|---|---|---|---|
| `anthropic` / `claude` | `claude --print` uz pretplatu (OAuth) | **anthropic** | `session_usage.py` (sesija %, tjedan %, `rejected`/429) — postojeće |
| `openrouter` | danas `tools/modeli/openrouter-agent.ts` (tool-loop bash/read_file/write_file, do 60 iteracija, bez obrade 402/429; `RegocDaemon.ts:3384`); nakon K6 `claude --print` uz `ANTHROPIC_BASE_URL` (§5.4) | **openrouter** | NOVO: `GET https://openrouter.ai/api/v1/key` (`limit`, `limit_remaining`, `usage`), reaktivno 402/429 |
| `kimi`, `glm`, `minimax`, `qwen`, `deepseek` (anthropicCompatible) | `claude --print` uz `ANTHROPIC_BASE_URL` (`getAnthropicCompatProvider`, `RegocDaemon.ts:1115`) | **vlastita** po provideru | zasad samo reaktivno (429/402 → osigurač), bez proaktivnog mjerila |
| `kimicli`, `geminicli` | njihov CLI (OAuth) | vlastita | reaktivno |
| `google` | `GoogleProvider` u procesu (bez alata, samo kroz ModelRouter; `providers.google.enabled=false`) | google | reaktivno (429) |
| `ollama` | `tools/ollama-agent.ts` / HTTP | **nema** | nema kvote; samo dostupnost čvora |

Pravilo: **obitelj određuje vjerodajnica, a ne ime modela.** `claude --print` s preusmjerenim `ANTHROPIC_BASE_URL`
nije Anthropic kvota iako koristi isti CLI. Funkcija `obiteljKvote(target)` je čista i ima testove. Vraća `anthropic`
samo za `provider ∈ {anthropic, claude}` bez preusmjerenja.

### 4.2 Što vrata rade po obitelji
- **anthropic**: današnja semantika `autonomyTierFromUsage` se NE mijenja (70/85/95, tjedan 90, `rejected` → samo
  odgovor, stara snimka → fail-closed za autonomiju). Mijenja se samo **izvor brojeva**: pragovi se čitaju iz
  `settings` (`AutonomyThresholdSetting.ts`, keš ≤ 5 s), a ne iz konstanti. Time se zatvara uzrok 2.3.
- **openrouter**: autonomija stoji kad je `limit_remaining < openrouter.minStanjeUsd` (postavka, zadano 1 USD) ili kad
  je zadnji odgovor bio 402. Ključ bez limita (`limit: null`) znači da kvote nema i vrata su otvorena. Mjerilo je
  nedostupno → **fail-open** za OpenRouter, jer je kvota novac s vidljivim stanjem, a ne pretplata koja se tiho
  zaključava. Reaktivni osigurač (402/429 → hlađenje 10 min za tu obitelj) uvijek vrijedi.
- **nema (Ollama)**: vrata kvote se ne pitaju. I dalje vrijede strop usporednih agenata, `SpawnBreaker` i pauza.
- **Ručna pauza** (`PauseControl`) i **strop usporednih agenata** ostaju globalni. To nisu kvote nego Goranove kočnice.

### 4.3 Gdje se vrata pomiču u kodu
Danas se razina računa **jednom po prolazu, prije razrješenja izvršitelja** (`RegocDaemon.ts:7626` na glavnom,
`:6853` na node-A), a izvršitelj se razrješava tek kasnije po zadatku (`resolveTaskSpawnTarget`, `:1076`). Novo:
1. Za svaki zadatak se najprije pozove jeftini dio razrješenja (`model.svi` → `model.prelazak` →
   `resolveAgentTarget`). To je samo čitanje konfiguracije, bez poziva modelu, pa smije ići prije `scopeGateAllows`.
2. Za obitelj tog izvršitelja pita se `vrataObitelji(obitelj)`. Za `anthropic` to je postojeći `TierDecision`.
3. Zadatak čija obitelj nema kvotu ide dalje, a zadatak čija obitelj stoji ostaje u redu. Red čekanja
   (`autonomy_queue.json`, `QuotaWakeup`) vodi se **po obitelji**, pa obnova Anthropic kvote ne budi OpenRouter red i
   obratno.
4. TIER (`TaskTier.ts`) smije mijenjati model samo **unutar iste obitelji**. Već danas vrijedi
   `base.provider === 'anthropic'` (`:1105`), pa se to pravilo samo zapisuje kao nepromjenjivo.

Isto pravilo vrijedi za `spawnAgentOnDemand` (nalog), kritičara/Suca, odlučitelja, dežurnog i razgovor (Klaudio i
Šaban): svatko prije poziva pita vrata **svoje** obitelji. Šabanov `kvotaPuna()` dobiva argument `target` i za
ne-Anthropic obitelj vraća stanje te obitelji.

### 4.4 Inventar vrata koja danas ne pitaju providera (sva se prevode na `vrataObitelji`)
Izvor: pregled koda glavnog sustava 07.10.2026. (`file:line` na glavnom stroju).

| Vrata | Mjesto | Danas | Novo |
|---|---|---|---|
| auto-exec razina | `RegocDaemon.ts:7620-7709` (LIVE samo uz `autonomyGate`) | Anthropic % prije razrješenja izvršitelja (`:7720`) | po zadatku, po obitelji (§4.3) |
| `rejected`/429 | `WorkStateJournal.ts:299-306` | `answer-only` i `spawnOnRequest:false` **za sve** | samo obitelj `anthropic` |
| SpawnBreaker | `SpawnBreaker.ts:13,53-58,125-133`, `RegocDaemon.ts:4054` | jedan globalni osigurač („jedan račun, jedan limit"): 429 s OpenRoutera gasi i Anthropic, i obratno | osigurač **po obitelji** (ključ = `obiteljKvote(target)`) |
| Sudac (kritičar) | `Sudac.ts:368-378,440-443` | odbija na `rejected`/429/tjednu bez obzira na model kritičara | pita obitelj kritičarova izvršitelja |
| StaleWatchdog | `StaleWatchdog.ts:921-923` | koristi Anthropic razinu | razina obitelji zadatka |
| **CLI kuka** | `session_usage.py --hook prompt` (`settings.json:119`, `session_usage.py:398-417`) | blokira **svaki** `claude` CLI poziv iznad praga, uključujući kimi/glm/minimax preko `ANTHROPIC_BASE_URL` | kuka propušta poziv kad je u okolini postavljen `ANTHROPIC_BASE_URL` koji nije Anthropic. Bez toga put iz §5.4/1 (OpenRouter kroz `claude` CLI) pada baš kad treba |
| razgovor Šaban | `TaskManagerAI/src/TaskWebUI.ts:10845-10852` (`kvotaPuna`) | Anthropic % / `sessionBlock` | obitelj `razgovor` izvršitelja |
| razgovor Klaudio | `~/.claude/tools/Telegram/telegram_agent.ts` | **nikakva** provjera potrošnje | dobiva ista vrata obitelji (odgovaranje ostaje dopušteno na svakoj razini, Goranovo pravilo 28.07.) |
| nalog (`delegateToAgent`) | `RegocDaemon.ts:4805`, vrata u `spawnAgentOnDemand:3187-3225` | bez provjere potrošnje (pauza, slot, backoff, osigurač) | ostaje tako, ali osigurač je po obitelji |

---

## 5. Globalni prekidač „svi na model X" (točka b)

### 5.1 Postavka
U tablici `settings` (`regoc.db`), s auditom u `settings_history`. Isti obrazac kao `ConcurrencySetting.ts` i
`AutonomyThresholdSetting.ts`: čitač s kešom ≤ 5 s, uživo, bez restarta. Modul `ModelSviSetting.ts` je bez putanja i
bez okoline, pa je isti u pogonu i u paketu.

| Ključ | Vrijednost | Zadano |
|---|---|---|
| `model.svi` | `""` (isključeno, vrijedi konfiguracija) ili `"provider:model"` (npr. `openrouter:z-ai/glm-5.2`, `anthropic:sonnet`, `ollama:qwen3:8b`, `google:gemini-…`) | `""` |
| `model.svi.uloge` | popis uloga na koje prekidač djeluje | sve generativne uloge (§5.2) |
| `model.svi.razlog` | slobodan tekst (tko je i zašto prebacio) | — |

### 5.2 Prednost i doseg
`model.svi` ima prednost nad `agentOverrides`, `componentOverrides`, TIER-om, `razgovor.model` i Klaudijevim modelom.
Djeluje na **sve generativne uloge**:

| Uloga | Gdje se danas bira model | Kroz koji razrješivač ide |
|---|---|---|
| spawn agenta (auto-exec `:7720`/`:7752`, nalog `:4828`/`:4935`) | `models/AgentModel.ts:40` `resolveAgentTarget` (`agentOverrides`; bez njega registarski alias, `RegocDaemon.ts:413`) | `resolveAgentTarget` → prvo `model.svi` |
| perzistentni AgentDaemon | `RegocDaemon.ts:416-423` (ne-Anthropic override ignorira, pada na alias) | ostaje Anthropic-only: kad `model.svi` nije Anthropic, perzistentni se ne pokreću i posao ide spawnom |
| kritičar (Sudac, doc2) | `CriticGate.ts:198`, `Sudac.ts:46,401,415` (`agentOverrides.kriticar`; ne-Anthropic = samo tekst `:421`) | `resolveAgentTarget('kriticar')` |
| adversarial verify | `tools/orkestracija/adversarial-pozivac.ts:130`, `config/adversarial-verify.json → modeli` (3 Ollama modela, `nacin:"off"`) | izuzet dok je `off`. Leće koje idu kroz Suca prate prekidač |
| razgovor glavnog stroja (Klaudio) | `~/.claude/tools/Telegram/lib/KlaudioModel.ts:70,81,156-212` (`agentOverrides.klaudio`, čita se po poruci; zna openrouter, ollama, kimicli, geminicli i kompatibilne) | `ModelSviSetting` prije `agentOverrides.klaudio` |
| razgovor paketa (Šaban) | `razgovor.model` → `agentOverrides.razgovor` → zadano CLI-ja (`RazgovorPloca.ts:76-83`); `Izvrsitelj.ts:30-46` uvijek `claude -p --model <niz>`, **bez raščlambe providera** | `ModelSviSetting`. Izvršitelj razgovora mora raščlaniti `provider:model` i za kompatibilne postaviti `ANTHROPIC_BASE_URL` (isti kod kao daemon `:1116-1131`) |
| Hindsight (retain/reflect) | `tools/hindsight/HindsightConfig.ts:170-219` (`componentOverrides.hindsight`, glavni: `anthropic:opus`; čita se pri pokretanju, primjenjuje `hindsight_uskladi.ts`) | uloga `hindsight` u `model.svi.uloge`. Promjena zove `hindsight_uskladi.ts` (restart Hindsighta, ne daemona) |
| dežurni | `tools/telegram/dezurni.py:147-199`, `~/.claude/tools/Telegram/dezurni.ts:30-36` (`config/dezurni.json`, danas `ollama/qwen3:8b`) | čita `model.svi` prije `dezurni.json` |
| odlučitelj | `tools/orkestracija/odlucitelj.py:467-511` (`config/odlucitelj.json`, `openrouter` `qwen/qwen3.8-27b:free`) | isto |
| consult-potjeh | `tools/modeli/consult-potjeh.ts:39-73` (samo Ollama; uz `potjeh: anthropic:opus` alat se uvijek preskače) | izuzet (savjetnik je namjerno lokalan) |
| klasifikator (`componentOverrides.classifier`) | `ClassifierModel.ts:13,105`, `LocalOffload.ts:127-133` | **opcionalno**: zadano izuzet jer je lokalni i besplatan; uključuje se popisom `model.svi.uloge` |
| **embeddings** | `componentOverrides.embeddings` | **NIKAD**: promjena modela mijenja vektorski prostor i kvari RAG/Hindsight. Prekidač ga ne vidi. |

U logu se vidi jedan redak: `[MODEL-SVI] jelena → openrouter:z-ai/glm-5.2 (prekidač; nadjačava agentOverrides
anthropic:opus)`. Ploča dok je prekidač uključen pokazuje traku „Sustav vozi X (prebacio Goran u HH:MM)".

### 5.3 Popis podržanih providera/modela
Izbornik se puni iz postojećeg koda, a ne iz ruke:
- **provideri**: ključevi `providers` u `models/model-config.json` s `enabled: true` i vjerodajnicom koja postoji (provjera
  `secret_probe` stila, bez ispisa). Danas: `anthropic`, `openai`, `google`, `ollama`, `openrouter`, `kimi`,
  `kimicli`, `glm`, `minimax`, `qwen`, `deepseek`, `geminicli`, `claude`. Onemogućeni se prikazuju sivo, s razlogom.
- **modeli**: `anthropic` → opus/sonnet/haiku; `ollama` → `GET /api/tags` čvora; ostali → `config/izvrsitelji.json`
  (izmjereni) i `models/model-capabilities.json`, uz unos slobodnog teksta (`openrouter:<slug>`).
- uz svaki model stoje njegove **izmjerene sposobnosti** (`izvrsitelji.json → sposobnosti`: alate, pisanje, rag, web,
  dug-kontekst).

### 5.4 Što kad provider nema alate
Agent bez alata ne može izvršiti zadatak (čitati, pisati, pokretati testove). Izvršitelj se bira ovim redom:
1. **`claude --print` uz `ANTHROPIC_BASE_URL`** za svakog Anthropic-kompatibilnog providera. To već radi za
   kimi/glm/minimax (`getAnthropicCompatProvider`). OpenRouter nudi Anthropic-kompatibilan endpoint, pa uz
   `providers.openrouter.anthropicCompatible=true` i `baseUrl` OpenRouter dobiva **iste alate kao Claude Code**. Ovo je
   preporučeni put za „cijeli sustav na OpenRouter". Prije uključivanja ga mjeri Jelena
   (`tools/sposobnosti-probe.ts`, korak K6).
2. **`tools/openrouter-agent.ts`** (vlastiti tool-loop: bash/read/write) kao rezerva, ako korak 1 za neki model ne
   prođe probu.
3. **`tools/ollama-agent.ts`** za Ollamu (postojeći, `node_model_policy.py`).
4. **`google`** (`GoogleProvider`, u procesu) nema alate: smije za razgovor bez ovlasti i za kritičara bez alata, ali
   ne za spawn agenta. Za agente se koristi `geminicli`.

**Pravilo izbornika:** model kojem `sposobnosti` nema `alate` nije ponuđen kao „svi". Ponuđen je kao „svi osim
agenata", gdje agenti ostaju na svom modelu, uz objašnjenje u sučelju. Nema tihog spuštanja na slabiji model.

### 5.5 Sučelje i API
- **Config → vrh stranice, „Model sustava"**: jedan padajući izbornik (grupiran po provideru) + gumb „Primijeni" +
  „Vrati na konfiguraciju". Ispod izbornika piše koje uloge mijenja i stanje kvote odabrane obitelji.
- Postojeće ne ide u otpad: `GET /api/models/available` (`TaskWebUI.ts:10523`, popis + živi modeli) puni izbornik, `PUT /api/agents/:id/model` (`:11673`) ostaje za pojedinačnog agenta (piše `agentOverrides` kroz `ModelConfigWriter`). Skupnog „svi agenti" endpointa danas nema.
- **Gdje je Config stranica:** na glavnom stroju ploču poslužuje `~/.claude/regoc/TaskManagerMD` (ne TaskManagerAI), a u paketu i na node-A `TaskManagerAI/src/TaskWebUI.ts`. Izbornik se radi u oba.
- `GET /api/config/model-svi` → `{ vrijednost, uloge, ponuda: [{provider, model, sposobnosti, omogucen, razlog}] }`
- `PUT /api/config/model-svi` `{ vrijednost, uloge?, razlog? }` → validacija (§5.4), upis i audit. Odbijen unos
  vraća 400 s razlogom.
- Telegram (Klaudio/Šaban, samo vlasnik): naredba `/model svi openrouter:…` i `/model natrag` zovu isti API.
- `tools/modeli/node_model_policy.py` postaje tanki CLI nad istim API-jem. Više ne prepisuje `agentOverrides`, pa
  ostaje jedan izvor istine.

---

## 6. Automatski prelazak na OpenRouter (točka c)

Postavke (`settings`):

| Ključ | Značenje | Prijedlog zadanog |
|---|---|---|
| `model.prelazak.ukljucen` | uključuje automatski prelazak | **Goran odlučuje** (§9) — prijedlog: glavni `false`, node-A `true` |
| `model.prelazak.cilj` | `provider:model` na koji se prelazi | izmjereni OpenRouter model s `alate` (npr. `openrouter:z-ai/glm-5.2`, već radi na node-A) |
| `model.prelazak.prag` | Anthropic sesija % na kojoj se prelazi | = `autonomy.session_block` (node-A 90) |
| `model.prelazak.dnevniStropUsd` | najviše USD na dan na cilju | 5 USD |

Ponašanje:
- Kad je Anthropic sesija ≥ `prag` **ili** `rejected`, uloge koje se razrješavaju u obitelj `anthropic` dobivaju
  `cilj`. Tako rad ne staje, nego prelazi na drugi model.
- Prelazak **ne nadjačava** ručni `model.svi`: Goranov izbor uvijek ima prednost.
- **Povratak** se događa sam kad prođe `session_reset_at` i svježe mjerenje pokaže manje od `autonomy.session_autonomy`.
  Prijelaz i povratak javljaju se **jednom** na Telegram („↪ Anthropic 91 % — prelazim na X do HH:MM").
- Strop: kad OpenRouter mjerilo javi `limit_remaining < minStanjeUsd` ili je dnevni strop dosegnut, prelazak se gasi.
  Rad tada stoji kao danas i dolazi jedna poruka.
- Zadatak koji je **već u radu** ne mijenja model usred posla. Prelazak vrijedi za iduće pozive.

---

## 7. Mjerilo sesije na node-A (točka 2 Goranova naloga)
Mjerilo nije kvar (§2.1). Popravak su §2.2 i §2.3:
1. **Odmah (operativno, bez koda):** `features.json → autonomyGate.enabled=true` na node-A. Zastavica se učitava
   uživo, bez restarta, a na glavnom je već `true`. Dok §4 nije izveden, to znači da potrošena Anthropic sesija koči
   i OpenRouter zadatke na čvoru. To je i danas stanje glavnog stroja. Rješava ga K2.
2. Daemon čita pragove iz `settings` (K1), pa Goranovih 75/80/90 stvarno vrijedi.
3. Daemon na node-A se usklađuje s glavnim (zaostaje 906 redaka; nema `ConcurrencySetting`).
4. Kontrola da se ovo ne ponovi: `system_map_check`/bootcheck javlja **„mjerilo radi, a vrata su u SHADOW"** kao
   nesukladnost (svježa snimka s postotkom + `autonomyGate=false` → upozorenje na ploči).

---

## 8. Plan izvedbe za Jelenu (točka e)

Svaki korak je zaseban zadatak, ima testove prije koda (TDD) i ide najprije na glavni sustav, zatim u paket i na
node-A. Isporuka na čvor ide kroz `restart_kad_mirno.sh`, a ne kroz izravni restart (§2.5).

| # | Korak | Sustav | Mjerilo prihvaćanja |
|---|---|---|---|
| **K0** | `autonomyGate.enabled=true` na node-A + nesukladnost „mjerilo radi, vrata SHADOW" | node-A (operativno) | `grep -a "autonomy SHADOW" daemon.log` nakon promjene = 0 novih redaka; uz sesiju ≥ prag u logu `⛔ [autonomy]` i **nijedan** `Auto-exec` na `anthropic:` u istom prolazu |
| **K1** | `WorkStateJournal.autonomyTier*` prima pragove iz `getAutonomyThresholds()` (keš ≤ 5 s); konstante ostaju samo kao zadano | glavni + paket + node-A | jedinični test: postavka 75/80/90 → 76 % = `task-by-task`, 81 % = oprez, 91 % = `answer-only`; u logu node-A „sesija 76 % ≥ 75 %"; promjena na Config stranici vrijedi ≤ 5 s bez restarta |
| **K2** | `obiteljKvote(target)` + `vrataObitelji()`; vrata se pitaju **po zadatku nakon razrješenja izvršitelja**; red čekanja po obitelji; `kvotaPuna(target)` u razgovoru | glavni + paket | + SpawnBreaker po obitelji, Sudac, StaleWatchdog, CLI kuka `session_usage.py --hook prompt` propušta poziv s ne-Anthropic `ANTHROPIC_BASE_URL` (§4.4). Testovi: (a) Anthropic `rejected` + zadatak `openrouter:x` → spawn ide; (b) isto + `anthropic:opus` → čeka; (c) `kimi:` preko `ANTHROPIC_BASE_URL` = obitelj kimi, ne anthropic; (d) Šaban s `razgovor.model=openrouter:x` na 100 % Anthropic sesije odgovara. E2E na node-A: sesija ≥ 90 % i jedan GLM zadatak → `Auto-exec … (openrouter:…)` u logu |
| **K3** | mjerilo OpenRouter: `tools/telemetrija/provider_usage.py` (`GET /api/v1/key`, ključ kroz okolinu, nikad ispisan) → `data/provider_usage.jsonl`; reaktivni osigurač 402/429 po obitelji | glavni + node-A | zapis svakih 5 min s `limit_remaining`; umjetni 402 → obitelj openrouter 10 min stoji, anthropic radi; `secret_scan` čist |
| **K4** | `ModelSviSetting.ts` + `GET/PUT /api/config/model-svi` + izbornik na Config stranici + traka na ploči; `resolveAgentTarget` prvo pita `model.svi` | glavni + paket | PUT `openrouter:z-ai/glm-5.2` → idući spawn u logu `[MODEL-SVI] … → openrouter:z-ai/glm-5.2`; PUT modela bez `alate` za uloge s agentima → 400 s razlogom; audit u `settings_history`; „Vrati" vraća `agentOverrides` ponašanje |
| **K5** | sve uloge iz §5.2 prolaze kroz `razrijesiModel(uloga)` (Klaudio, Šaban, Sudac/kritičar, odlučitelj, dežurni, Hindsight, consult-potjeh); embeddings izuzet | glavni + paket | uključuje raščlambu `provider:model` u izvršitelju razgovora (`Izvrsitelj.ts`) i `hindsight_uskladi.ts` za Hindsight. Test-matrica: `model.svi=X` → svaka uloga prijavi X (jedan redak po ulozi u testu); `embeddings` ostaje nepromijenjen; `grep` nema više izravnog čitanja `agentOverrides` izvan razrješivača |
| **K6** | OpenRouter kao Anthropic-kompatibilan (`providers.openrouter.anthropicCompatible`, `baseUrl`) + `sposobnosti-probe.ts` za 2–3 kandidata → `izvrsitelji.json` | glavni + node-A | proba: `alate` dokazano (5/5 ili navedeno koje pada) za barem jedan OpenRouter model; ako put 1 ne prođe, `openrouter-agent.ts` prolazi istu probu |
| **K7** | automatski prelazak §6 iza zastavice `modelPrelazak` (SHADOW → LIVE) | glavni + paket | SHADOW: uz sesiju ≥ prag log „bi prešao na X"; LIVE na node-A: sesija ≥ 90 % → idući zadatak na cilju, jedna Telegram poruka; nakon obnove povratak na Anthropic i jedna poruka; dnevni strop zaustavlja prelazak |
| **K8** | paket: isti moduli u `TaskManagerAI/src/core` (bez putanja), Config kartica, `docs`; usklađivanje daemona na node-A s glavnim | paket + node-A | `bun test` u paketu zelen; `StaleCodeCheck` na node-A exit 0; `Max concurrent spawns` u logu = Config vrijednost |
| **K9** | E2E (Potjeh) na node-A: scenarij „Anthropic potrošen → jednim potezom sve na OpenRouter" | node-A | na sesiji ≥ 95 % ili `rejected`: (1) Config izbornik → OpenRouter; (2) Šaban odgovara; (3) jedan auto-exec i jedan nalog izvršeni na OpenRouteru; (4) nijedan novi Anthropic poziv u `session_usage` (postotak ne raste); (5) „Vrati" → idući zadatak opet na Anthropic |

Redoslijed: K0 odmah → K1 → K2 (to rješava Goranovu točku 3) → K3 → K4 + K6 usporedno → K5 → K7 → K8 → K9.

---

## 9. Odluke koje donosi Goran
1. **Automatski prelazak (§6): zadano uključen ili isključen?** Prijedlog: node-A `uključen` (mala sesija, od 5 do
   25 pp po Opus zadatku, §2.4); glavni `isključen` (Max pretplata, tamo Goran prebacuje ručno).
2. **Cilj prelaska** i dnevni strop u USD. Prijedlog: `openrouter:z-ai/glm-5.2` (već radi na node-A) nakon K6 probe,
   strop 5 USD/dan.
3. **Klasifikator u prekidaču**: izuzet (prijedlog, lokalni je i besplatan) ili uključen.

## 10. Otvoreno / nije izmjereno
- Koji model koristi Hindsight poslužitelj na node-A (17792). Na glavnom je `componentOverrides.hindsight=anthropic:opus`, a na node-A ključ `hindsight` u `componentOverrides` ne postoji.
- Zašto na glavnom perzistentni `AgentDaemon --agent klaudio --model sonnet` radi, a u konfiguraciji je `klaudio: anthropic:opus` (inventar, nije praćeno).
- Stvarna podrška alata za OpenRouter preko `ANTHROPIC_BASE_URL` u našem `claude` CLI-ju (K6 to mjeri).
- Polja `GET /api/v1/key` nisu izmjerena s našim ključem: proba je odbijena jer bi ključ završio u transkriptu. K3 to
  radi kroz okolinu procesa.

## 11. Posljedice
- **+** Potrošena Anthropic sesija više ne zaustavlja rad koji ide preko drugog providera. Goran jednim potezom seli
  cijeli sustav, a vidi i točno što se seli.
- **+** Config pragovi postaju istiniti. Danas su na oba sustava ukrasni.
- **−** Vrata se računaju po zadatku, a ne po prolazu, pa po prolazu ima nekoliko čitanja konfiguracije više (keš
  ≤ 5 s, zanemarivo).
- **−** OpenRouter postaje stvaran trošak u novcu, pa su njegovo mjerilo (K3) i dnevni strop obvezni prije K7.
- **Rizik:** model bez alata kao „svi". Ublaženo pravilom §5.4: nije ponuđen za agente.
