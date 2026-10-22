# regoc-system — komplet sustava REGOČ

> English version: [README.md](README.md) · Paket: [../README.hr.md](../README.hr.md) ·
> Arhitektura: [../REGOC/ARHITEKTURA.md](../REGOC/ARHITEKTURA.md)

`regoc-system/` je **komplet sustava** TaskManagerAI: orkestrator `RegocDaemon` sa svim modulima koje
uvozi, pomoćni agenti, alati koje daemon pokreće, kuka `SecurityValidator` za Claude Code i primjeri
postavki. Bez njega je TaskManagerAI ploča (zadaci, API, razgovor). S njim čvor posao i **izvodi**:
bira zadatke, pokreće agente, provjerava njihov rezultat i zatvara zadatke.

Od odluke D3 (22. 10. 2026.) komplet je **mapa ovog paketa**: isti repozitorij i isti commit kao
ploča. Nema drugog repozitorija ni lock datoteke. Instalira se točno ono što si klonirao, a
`MANIFEST.sha256` u ovoj mapi dokazuje da usput ništa nije promijenjeno.

Sadržaj:
[Što je u kompletu](#što-je-u-kompletu) ·
[Ovisnosti](#ovisnosti) ·
[Instalacija](#instalacija-uz---komplet) ·
[Pokretanje i zaustavljanje](#pokretanje-i-zaustavljanje) ·
[Dnevnici](#dnevnici) ·
[Postavke](#postavke) ·
[Tajne](#tajne) ·
[Tajne nakon instalacije](#tajne-nakon-instalacije-korak-po-korak) ·
[Nadogradnja](#nadogradnja) ·
[Deinstalacija](#deinstalacija) ·
[Ponovni izvoz kompleta](#ponovni-izvoz-kompleta-iz-glavnog-sustava) ·
[Provjera](#provjera) ·
[Što nikad nije u kompletu](#što-nikad-nije-u-kompletu)

## Što je u kompletu

| Putanja | Što je |
|---|---|
| `RegocDaemon.ts` | orkestrator. Svake sekunde čita bazu zadataka ploče i odlučuje što smije krenuti (vrata autonomije, strop usporednih, pauza). Pokreće agente (Claude CLI ili drugi model), pušta nezavisnog kritičara nad rezultatom te zadatak zatvara ili blokira |
| `MessageQueue.ts` | red poruka između daemona, agenata i korisnika (SQLite `messages.db` u mapi kompleta) |
| `AgentDaemon.ts`, `AgentWorker.ts` | dugotrajni radnici agenata (timski način) i radnik koji izvodi jedan potez agenta |
| `CriticGate.ts`, `VerificationGate.ts`, `CompletionGuard.ts`, `MergeGate.ts` … | vrata kroz koja rezultat prolazi prije nego zadatak smije postati `completed` |
| `PauseControl.ts`, `ConcurrencySetting.ts`, `AutonomyThresholdSetting.ts` | ručna kočnica, strop usporednih agenata i pragovi autonomije (v. [Postavke](#postavke)) |
| `StaleCodeCheck.ts` | kaže vrti li živi proces još kod s diska |
| `lib/` | zajednički pomoćnici: `spremiste-tajni.ts` (jedini čitač spremišta tajni), `okolina-sustava.ts` (identitet stroja iz postavki), `platforma.ts` (razlike Linux/macOS) |
| `models/` | apstrakcija modela (`ModelRouter`, `ModelInterface`) i `model-config.example.json` |
| `tools/` | alati koje daemon pokreće: `modeli/` (petlje agenata za Ollamu i OpenRouter, savjet), `orkestracija/`, `zadaci/checkpoint.ts`, `rag/lib/` (RAG nad ChromaDB-om ili pgvectorom), `hindsight/`, `servisi/` (`brana_brisanja.ts` — brana brisanja, `restart_kad_mirno.sh`) |
| `workflows/` | tijekovi u više koraka (npr. novi projekt s mapom na Nextcloudu) |
| `zod/` | sheme podataka |
| `vanjsko/` | nekoliko modula koje daemon uvozi izvan `~/.claude/regoc`; `POVEZNICE.tsv` kaže kamo se vežu |
| `vanjsko/.claude/hooks/SecurityValidator.hook.ts` (+ `lib/`), `vanjsko/.claude/PAISECURITYSYSTEM/patterns.example.yaml`, `settings.json.primjer` | kuka za Claude Code koja svakom agentu blokira curenje tajni i razorne naredbe |
| `config.primjer/`, `features.example.json`, `models/model-config.example.json` | primjeri postavki; kopiraju se samo gdje još ničega nema |
| `TAJNE.json` | imena svih tajni koje kod kompleta čita, s opisom. **Samo imena** ([Tajne](#tajne)) |
| `PREKIDACI.md` | svaki prekidač iz `features.json` sa zadanom vrijednošću i objašnjenjem (piše ga izvoz) |
| `ULAZI.txt` | ulazne točke; svaka mora proći `bun build` |
| `instalacija.sh` | idempotentna priprema nakon kopiranja (ispisuje `PROMIJENJENO` ili `ISTO`) |
| `KOMPLET.json` | kamo se komplet instalira (`odrediste`, relativno na kućnu mapu); čita ga `install.sh` |
| `MANIFEST.sha256` | sha256 svake datoteke kompleta |
| `package.json`, `bun.lock` | npm ovisnosti s točnim inačicama |
| `tests/` | testovi koji rade bez ijednog drugog dijela sustava |

## Ovisnosti

| Što | Inačica | Tko instalira |
|---|---|---|
| ploča TaskManagerAI (ovaj paket) | isti commit | ti (git clone). Daemon prije pokretanja čeka da `http://127.0.0.1:<TM_PORT>/health` odgovori |
| bun | 1.3.6 ili novija | `install.sh` |
| npm paketi | točne inačice u `package.json`: `chromadb`, `ollama`, `pg`, `yaml`, `zod` | `install.sh --komplet` (`bun install --frozen-lockfile` u kompletu) |
| Claude CLI | aktualna | `install.sh --komplet` (korak `K2.13-claude`). Prijava je zaseban korak: ploča → Config → Prijava, ili `CLAUDE_CODE_OAUTH_TOKEN` na stranici Tajne |
| python3 | 3.9 ili novija | operacijski sustav. Treba ga `session_usage.py` (mjerilo potrošnje za vrata autonomije) |
| git, curl, tar, shasum/sha256sum | bilo koja | operacijski sustav |
| po izboru: Ollama, ChromaDB, pgvector, Hindsight | — | tvoj izbor; adrese dolaze iz postavki ([Postavke](#postavke)), nikad iz koda |

## Instalacija (uz `--komplet`)

Iz korijena paketa, kako kaže README paketa (korak 2):

```bash
bash scripts/install.sh --cvor <ime> --profil upravitelj-cvora --baze --komplet
```

Korak `K2.14-komplet` u `install.sh` tada ovim redom radi sljedeće. Svaki pad zaustavlja instalaciju
s izlazom 5, a usluge se ne pokreću.

1. **Provjerava ovu mapu**: svaka datoteka iz `MANIFEST.sha256` postoji s tim sha256 i nema datoteke
   koje nema u manifestu (smije postojati samo `node_modules/`). Izmijenjena ili oštećena mapa → izlaz 5.
2. **Kopira** mapu u `~/.claude/regoc` (`odrediste` iz `KOMPLET.json`, ili `TM_KOMPLET_DIR`). Ništa se ne klonira ni ne preuzima.
   Ako `~/.claude/regoc` postoji, a nije komplet (nema `MANIFEST.sha256`), **ne** prepisuje se → izlaz 5.
   Ako je to instalirani komplet s lokalnim izmjenama u svojim datotekama → izlaz 5 (čvor se nikad ne krpa na mjestu).
3. Kopiju ponovo provjerava prema manifestu.
4. `bun install --frozen-lockfile` u kompletu.
5. `instalacija.sh --paket <paket> --tm-home <TM_HOME>` kopira primjere postavki gdje ničega nema
   (`config/`, `features.json`, `models/model-config.json`). Module iz `POVEZNICE.tsv` veže u
   `~/.claude/…`, opet samo gdje ničega nema. Piše `~/.claude/settings.json` s kukom `SecurityValidator`
   (samo ako ga nema). `credentials.env` veže na spremište tajni paketa
   `$TM_HOME/config/credentials.env`. Sve što stvori izvan kompleta javlja `install.sh`-u i to ide u
   `$TM_HOME/instalirano.json`, pa ga deinstalacija uklanja.
6. `bun build RegocDaemon.ts` dokazuje da se graf modula razrješava, i to **prije** nego se ijedna usluga pokrene.
7. U `$TM_HOME/config/instalacija.env` upisuje `TM_SUSTAV_DIR=~/.claude/regoc` i
   `TM_MODEL_CONFIG=…/models/model-config.json`. Instaliraju se usluge `daemon` i `znanje` (postoje
   samo uz `--komplet`).

Ponovni `install.sh --komplet` ne mijenja ništa ako se mapa nije promijenila (`ISTO`).
`--suho` ispisuje što bi napravio i ništa ne mijenja.

## Pokretanje i zaustavljanje

Daemon radi kao usluga `daemon`, nakon ploče (`taskmanager`). Obje okolinu dobivaju iz
`scripts/s-okolinom.sh`: prvo postavke čvora, zatim tajne.

| | Linux (korisnička systemd jedinica `regoc-daemon.service`) | macOS (LaunchDaemon `hr.regoc.daemon`) |
|---|---|---|
| stanje | `systemctl --user status regoc-daemon` | `sudo launchctl print system/hr.regoc.daemon` |
| pokreni | `systemctl --user start regoc-daemon` | `sudo launchctl bootstrap system /Library/LaunchDaemons/hr.regoc.daemon.plist` |
| zaustavi | `systemctl --user stop regoc-daemon` | `sudo launchctl bootout system/hr.regoc.daemon` |
| ponovo pokreni | `systemctl --user restart regoc-daemon` | `sudo launchctl kickstart -k system/hr.regoc.daemon` |
| nakon pada | ponovo za 5 s (`Restart=on-failure`) | ponovo za 5 s (`KeepAlive` nakon pada) |

`templates/servis/sudoers.primjer` u paketu dopušta upravo ove naredbe `launchctl` bez lozinke, pa ploča
može ponovo pokrenuti uslugu. Ako želiš zaustaviti **rad**, a ne daemon, koristi ručnu kočnicu
([Postavke](#postavke)). Zaustavljen daemon ostavlja agente koji već rade bez nadzora. Dok zadaci rade,
bolje je koristiti `tools/servisi/restart_kad_mirno.sh`: on uslugu ponovo pokreće tek kad nijedan
zadatak nije `in_progress`.

## Dnevnici

| Dnevnik | Gdje |
|---|---|
| dnevnik daemona (svaka odluka, spawn, vrata) | `~/.claude/regoc/daemon.log` (daemon ga sam rotira) |
| izlaz usluge | Linux: `journalctl --user -u regoc-daemon` · macOS: `$TM_HOME/log/daemon.log` |
| instalacija | `$TM_HOME/log/install/<vrijeme>/` (`koraci.jsonl`, redak po koraku) |
| provjera zdravlja | `$TM_HOME/log/bootcheck/zadnji.txt` i `zadnji.json` |
| upisi tajni (tko i kada, nikad vrijednost) | `$TM_HOME/data/tajne_audit.jsonl` |

## Postavke

Komplet adrese i identitet čita iz postavki, nikad iz koda.

| Postavka | Gdje | Zadano bez nje |
|---|---|---|
| prekidači | `~/.claude/regoc/features.json`. Svaki prekidač je opisan u [PREKIDACI.md](PREKIDACI.md). Komplet kreće s **ugašenima** `autonomyGate` i `ollamaClassifier` (novi čvor nema mjerilo potrošnje ni Ollamu) | `features.example.json` |
| **vrata autonomije** | prekidač `autonomyGate`. Pragovi su na ploči, Config → Strop i vrata autonomije → Vrata autonomije (`PUT /api/config/autonomy`): sesija 70 % (autonomija prestaje sama vući posao) / 85 % (oprez, jedan agent) / 95 % (blokada), tjedan 90 %. Trebaju mjerilo potrošnje `session_usage.py` | ugašena; pragovi 70/85/95/90 |
| **strop usporednih** | ploča, Config → Strop i vrata autonomije → Usporedni agenti (`PUT /api/config/concurrency`). Sprema se u bazu ploče s poviješću promjena, raspon 1–10. `REGOC_MAX_AGENT_CONCURRENT` je samo početna vrijednost | 3 |
| **ručna kočnica** (pauza) | ploča, gumb ⏸ Pauza (ponovni klik nastavlja; `/api/pause`). Globalna pauza zaustavlja pokretanje posla i prekida agente koji rade; zadaci zadržavaju status. Može se pauzirati i jedan zadatak. Stanje: `~/.claude/regoc/data/pause.state.json` | nije pauzirano |
| modeli | `~/.claude/regoc/models/model-config.json` (`apiKey` je uvijek `env:IME`) | `models/model-config.example.json` |
| Ollama | `OLLAMA_HOST` → `models/model-config.json` `providers.ollama.baseUrl` → `memory-config.json` | `http://127.0.0.1:11434` |
| ChromaDB | `CHROMA_HOST`/`CHROMA_PORT` → `memory-config.json` | `127.0.0.1:18765` |
| git identitet, URL ploče, Telegram grupa i dopušteni uid-ovi, banka memorije | `~/.claude/regoc/config/okolina.json` | `REGOC <regoc@localhost>`, `http://localhost:17781`, ništa |
| vrata, nadzornici, kritičar, tijekovi | `~/.claude/regoc/config/*.json` (iz `config.primjer/`) | vrijednosti iz primjera |
| postavke čvora (vrata, hostovi, `NEXTCLOUD_URL`, `NEXTCLOUD_USER` …) | `$TM_HOME/config/postavke.env`. Nisu tajne | — |

## Tajne

Komplet tajne čita iz **jednog** spremišta, `~/.claude/regoc/credentials.env`, i to samo kroz
`lib/spremiste-tajni.ts`. Uz paket `instalacija.sh` od te datoteke napravi poveznicu na spremište paketa
`$TM_HOME/config/credentials.env` (prava 0600). To je ista datoteka u koju ploča piše kad upišeš tajnu
na Config → Tajne. Čitač razumije zapis ploče (`IME='vrijednost'`) i datoteku čita pri svakoj uporabi,
pa novoupisana tajna radi bez ponovnog pokretanja. Vrijednosti se nikad ne ispisuju, ne zapisuju u
dnevnik i ne izvoze u okolinu drugih procesa.

`TAJNE.json` navodi ime svake tajne koju kod kompleta čita. Popis se **izvlači iz koda** pri izvozu
(`izvuci_tajne.py`): nova tajna u kodu bez opisa zaustavlja izvoz. Na čvoru s kompletom ploča na
Config → Tajne pokazuje sva ta imena, a provjera zdravlja (`bootcheck`, mjerenje M9) navodi ona koja
još nisu upisana.

Nijedna nije uvjet da daemon radi: agenti kroz Claude CLI trebaju samo prijavu CLI-ja (ili
`CLAUDE_CODE_OAUTH_TOKEN`, upisan na istoj stranici). Svaka druga tajna uključuje jednog davatelja ili
jednu mogućnost:

| Ime | Čemu služi | Bez nje | Čita je |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | API ključ Anthropica za izravne pozive modela iz daemona (davatelj anthropic u models/model-config.json). Agenti preko Claude CLI-ja ga NE trebaju — oni koriste prijavu CLI-ja ili CLAUDE_CODE_OAUTH_TOKEN paketa. | izravni API pozivi Anthropica (klasifikator, sažeci u procesu daemona) padaju na sljedećeg davatelja ili se preskaču; agenti preko CLI-ja rade normalno. | `models/ModelInterface.ts`, `models/ModelRouter.ts`, `models/model-config.example.json` |
| `DEEPSEEK_API_KEY` | API ključ DeepSeeka (davatelj deepseek, Anthropic-kompatibilni endpoint). | agenti na modelima deepseek:* ne mogu raditi. | `models/model-config.example.json` |
| `GEMINI_API_KEY` | API ključ Google AI Studija. Koriste ga davatelj google (izravni pozivi) i geminicli (agenti kroz `gemini` CLI — daemon ga predaje procesu agenta). | agenti dodijeljeni modelu geminicli:* ne mogu raditi; daemon ih preskače ili prebacuje na drugi model. | `RegocDaemon.ts`, `models/ModelInterface.ts`, `models/ModelRouter.ts`, `models/model-config.example.json` |
| `GLM_API_KEY` | API ključ Z.ai GLM (davatelj glm, Anthropic-kompatibilni endpoint). | agenti na modelima glm:* ne mogu raditi. | `models/model-config.example.json` |
| `GOOGLE_API_KEY` | Staro ime istog ključa Google AI Studija (zamjena za GEMINI_API_KEY u lancu `env:GEMINI_API_KEY|GOOGLE_API_KEY`). Upiši samo jedno od dva imena. | ništa, ako je upisan GEMINI_API_KEY; inače isto kao bez GEMINI_API_KEY. | `models/ModelInterface.ts`, `models/ModelRouter.ts`, `models/model-config.example.json` |
| `KIMI_API_KEY` | API ključ Moonshot Kimi (davatelj kimi, Anthropic-kompatibilni endpoint): daemon njime pokreće Claude CLI prema Kimi modelu. | agenti na modelima kimi:* ne mogu raditi. | `models/model-config.example.json` |
| `MINIMAX_API_KEY` | API ključ MiniMaxa (davatelj minimax, Anthropic-kompatibilni endpoint). | agenti na modelima minimax:* ne mogu raditi. | `models/model-config.example.json` |
| `NEXTCLOUD_PASSWORD` | Lozinka (ili lozinka aplikacije) Nextclouda za tijek „novi projekt” (workflows/CreateProjectWorkflow.ts: mapa projekta i dijeljenje). Uz nju trebaju i postavke NEXTCLOUD_URL i NEXTCLOUD_USER u $TM_HOME/config/postavke.env (nisu tajne). | projekt se stvara bez Nextcloud mape; tijek javlja da vjerodajnice nedostaju. | `workflows/CreateProjectWorkflow.ts` |
| `OPENAI_API_KEY` | API ključ OpenAI-ja za davatelja openai (zadano ugašen u models/model-config.json). | davatelj openai ostaje neiskoristiv; ništa drugo ne ovisi o njemu. | `models/ModelRouter.ts`, `models/model-config.example.json` |
| `OPENROUTER_API_KEY` | API ključ OpenRoutera za agente na modelima openrouter:* (alat tools/modeli/openrouter-agent.ts). | agenti na modelima openrouter:* ne mogu raditi. | `models/model-config.example.json`, `tools/modeli/openrouter-agent.ts` |
| `PGVECTOR_PASSWORD` | Lozinka PostgreSQL/pgvector baze za RAG kompleta kad je u memory-config.json `rag.backend` = pgvector ili dual (ili REGOC_RAG_BACKEND). Lokalni pgvector paketa (install.sh --baze) ima svoju lozinku TM_PGVECTOR_PASSWORD — ova je samo za vanjsku pgvector bazu. | RAG kompleta na pgvectoru ne radi (pretraga i upis znanja agenata); s ChromaDB-om (zadano) ne treba. | `tools/rag/lib/rag-backend-factory.ts` |
| `QWEN_API_KEY` | API ključ Alibaba DashScope (davatelj qwen, Anthropic-kompatibilni endpoint). | agenti na modelima qwen:* ne mogu raditi. | `models/model-config.example.json` |

## Tajne nakon instalacije (korak po korak)

Za vlasnika čvora, kad `install.sh --komplet` završi. Instalacija i agenti nikad ne upisuju
vrijednosti tajni. To radiš samo ti.

1. Otvori ploču iz mreže kojoj vjeruješ: `http://<čvor>:17781` (na samom čvoru ili kroz Tailscale).
2. U Telegramu jednom pošalji `/start` botu čvora (ploča kaže kojem). Kod za potvrdu ide samo u tvoj
   privatni razgovor.
3. Ploča → **Config → Tajne**. Popis pokazuje svaku tajnu paketa i kompleta. Tajne kompleta imaju opis,
   a kad prijeđeš mišem preko opisa, vidiš što bez njih ne radi. Sve su „nije upisana”.
4. Upiši vrijednost u polje svake tajne koja ti treba (samo za davatelje koje stvarno koristiš), pa
   **Spremi**. Ploča šalje kod od 8 znamenki u tvoj Telegram; upiši ga. Vrijednost ide u
   `$TM_HOME/config/credentials.env`, a stranica pokazuje samo „postoji” i otisak.
5. Provjeri: `bash scripts/bootcheck.sh`. Mjerenje **M9 tajne kompleta** smije navesti samo ono što si
   namjerno izostavio.
6. Za tajne koje komplet čita iz spremišta ponovno pokretanje ne treba. Ako si upisao
   `CLAUDE_CODE_OAUTH_TOKEN` ili promijenio `NEXTCLOUD_URL`/`NEXTCLOUD_USER` u `postavke.env`, ponovo
   pokreni daemon ([Pokretanje i zaustavljanje](#pokretanje-i-zaustavljanje)).

Tajnu mijenjaš tako da preko nje upišeš novu vrijednost, a brišeš gumbom **Obriši** (i to se potvrđuje
kodom). Na čvoru bez Telegrama tajne se upisuju na samom čvoru: `bun scripts/tajna.ts postavi IME`
(vrijednost se čita iz terminala, nikad iz naredbenog retka).

## Nadogradnja

Komplet se nadograđuje zajedno s paketom:

```bash
bash scripts/nadogradi.sh --git origin --grana main     # novi commit paketa (ploča se ponovo pokreće)
bash scripts/install.sh --cvor <ime> --profil upravitelj-cvora --baze --komplet
```

Druga naredba provjerava novi `regoc-system/` prema njegovom manifestu. Iz `~/.claude/regoc` uklanja
datoteke kojih u novom manifestu više nema, kopira nove i ponavlja korake 4–6. Tvoje postavke
(`config/`, `features.json`, `models/model-config.json`), podaci (`data/`, `messages.db`) i spremište
tajni nisu u manifestu i ostaju kakvi jesu. Ako si datoteku kompleta mijenjao ručno, nadogradnja staje
s izlazom 5: čvor se nikad ne krpa na mjestu.

## Deinstalacija

```bash
bash scripts/deinstaliraj.sh              # usluge staju; komplet i podaci ostaju
bash scripts/deinstaliraj.sh --sve        # + $TM_HOME (prije toga se radi kopija)
bash scripts/deinstaliraj.sh --do-nule    # + sve što je instalacija stvorila, po manifestu
```

`--do-nule` uklanja `~/.claude/regoc` i svaku poveznicu i datoteku koju je `instalacija.sh` stvorila
izvan njega (popis je u `$TM_HOME/instalirano.json`). Ono što je postojalo prije instalacije ostaje.

## Ponovni izvoz kompleta (iz glavnog sustava)

Ova mapa je izvoz. Popravci idu prvo u glavni sustav, a ovamo stižu sljedećim izvozom.
Na glavnom sustavu:

```bash
bash ~/.claude/regoc/deploy/node-a-samostalnost/gradi_komplet.sh --javno [--izlaz MAPA] [--bez-testa]
```

1. gradi graf modula svake ulazne točke (`bun build --metafile`) i skuplja module, alate koje daemon
   pokreće i njihove npm pakete (testne datoteke glavnog sustava ne idu);
2. `sastavi_izvoz.py` slaže stablo: moduli, `vanjsko/` + `POVEZNICE.tsv`, kuka, primjeri postavki bez
   vrijednosti vezanih uz stroj, `package.json` s točnim inačicama, `TAJNE.json` (`izvuci_tajne.py`),
   `PREKIDACI.md` i ovaj README;
3. `bun install --lockfile-only` piše `bun.lock`;
4. **brane** (`brane_izvoza.py`): privatne IPv4 adrese, adrese i imena tailneta, putanje
   `/home/<korisnik>` i `/Users/<korisnik>`, adrese e-pošte, Telegram id-ovi grupa i korisnika, imena
   strojeva, prezime, imena banaka memorije, sve iz `config/okolina.json` glavnog sustava, oblik tajne,
   binarne datoteke i poveznice koje vode izvan stabla. **Jedan pogodak zaustavlja izvoz**;
5. `MANIFEST.sha256`;
6. `bun install --frozen-lockfile` i `bun test` u zasebnoj kopiji;
7. tek tada se zamjenjuje mapa `regoc-system/` paketa (zadano
   `~/app/TaskManager/TaskManagerAI/regoc-system`; `node_modules/` ostaje). Mapa se provjerava sa
   `sha256 -c` i ponovo prolazi brane, a nijednu datoteku manifesta git paketa ne smije ignorirati.

Alat nikad ne radi commit ni push. Izvoz se commita na grani paketa, brane se pregledavaju, a push radi
vlasnik.

## Provjera

| Provjera | Naredba | Očekivano |
|---|---|---|
| mapa = manifest | `cd regoc-system && sha256sum -c --quiet MANIFEST.sha256` (macOS: `shasum -a 256 -c --quiet MANIFEST.sha256`) | bez ispisa, izlaz 0 |
| testovi kompleta | `cd regoc-system && bun install --frozen-lockfile && bun test` | `0 fail` |
| graf modula | u kompletu: `bun test` iznad (`tests/gradnja.test.ts` kopira komplet u privremeni HOME, pokreće `instalacija.sh` i gradi svaku ulaznu točku); instalirani: `bun build ~/.claude/regoc/RegocDaemon.ts --target=bun --outdir=/tmp/rd` | izlaz 0 |
| instalirani komplet | `bash scripts/install.sh … --komplet --suho` | korak `K2.14-komplet` javlja da je komplet isti kao `regoc-system/` |
| zdravlje čvora | `bash scripts/bootcheck.sh` | `VERDIKT: PASS`; M9 navodi tajne kompleta koje fale |

Testovi paketa (`bun test` u korijenu paketa) ne vrte testove kompleta. Komplet ima vlastite ovisnosti
i svoje testove vrti u ovoj mapi.

## Što nikad nije u kompletu

API ključevi, tokeni i lozinke (svaki `apiKey` je referenca `env:IME`, a vrijednosti žive samo u
spremištu tajni čvora s pravima 0600), podaci iz rada (`data/`, `messages.db`), postavke čvora
(`config/`, `features.json`, `models/model-config.json`), dnevnici, te ijedna adresa, uid ili e-pošta
stroja s kojeg je komplet izvezen. Za to se brinu brane izvoza, a `tests/bez-nasih-vrijednosti.test.ts`
ovdje ponavlja opće brane.

## Licenca

MIT, ista kao TaskManagerAI. V. [../LICENSE](../LICENSE).
