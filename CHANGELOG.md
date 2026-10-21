## 2026-10-21 — K6 dorada: nalazi QA svježe instalacije B1–B7 (TASK-5693)

- Iz QA K6 (TASK-5660), kandidat main 306c442. Svaki popravak ima test koji pada na starom kodu.
- B1 `scripts/start.sh` gasi samo ploču IZ OVOG paketa (radna mapa procesa = paket, isto mjerilo kao
  `install.sh` k_provjera i `deinstaliraj.sh` d_procesi); tuđi proces na vratima ostaje, izlaz 3 s PID-om
  i mapom. Nakon pokretanja provjerava da odgovara NAŠ proces. Test: `tests/start-sh.test.ts`.
- B2 `start.sh` postavke čita kroz `scripts/s-okolinom.sh` (isti red kao usluga: `$TM_HOME/config/
  instalacija.env`, pa `postavke.env`); stari `<paket>/config/postavke.env` još se čita, uz upozorenje.
- B3 `install.sh`: stanje PRIJE prve instalacije u `$TM_HOME/instalacija-prije.txt` (ponovni prolaz ga
  čita), svaka stavka manifesta odmah u `$TM_HOME/instalirano.ceka`, a pad koraka ih upisuje u
  `instalirano.json`. `deinstaliraj.sh` i `provjeri-cisto.sh` čitaju i `instalirano.ceka` (pad bez buna).
  Test: pad na K2.24 → ponovni install → `--do-nule` → `provjeri-cisto` = 0 i HOME = snimka prije.
- B4 `src/core/paths.ts` `tmHomeKonfiguracije()`: bez `TM_HOME` u okolini, a uz instalaciju čvora
  (`~/.taskmanager/config/instalacija.env`), CLI (`tajna.ts`, `prijava-ai.ts`, IngestConfig) koristi
  `~/.taskmanager` kao usluga. `config/tajne-otisak.kljuc` u `.gitignore`.
- B5 `install.sh --baze`: na Linuxu `uv pip install --torch-backend cpu` (bez nvidia-*/triton, ≈ 5 GB
  manje); modeli bez ONNX/OpenVINO kopija (`ignore_patterns`: 2,8 GB umjesto ≈ 8,7 GB). README EN/HR:
  ≈ 3,5 GB preuzimanja, HOME + ≈ 5 GB.
- B6 `platforma.ts` `lstartMs`: `ps` s `TZ=UTC0`, ispis se čita kao UTC (prije pomak sati izvan UTC-a);
  `TM_INSTALL_SLOBODNO_MIB` podmeće slobodni disk u testovima `install.sh`.
- B7 `scripts/instaliraj-pdf.sh`: proba i predmemorija fontconfiga u privremenoj mapi u `$TMPDIR`
  (briše se na izlasku), ne u `~/app/tmp/pdf-proba` i `~/.cache/fontconfig`; `TM_PDF_PROBA_DIR` je čuva.

## 2026-10-21 — kritičar bez lažnih CRITIC_FAILED: okolina, istek roka, 0 izvedenih testova (TASK-5691, prijenos TASK-5670 i TASK-5674)

- `src/core/CriticGate.ts` i `src/core/KriticarOpseg.ts` dobivaju pravila iz jezgre domaćina; postavka
  `lazniPadMode` (`on` zadano, `off` = staro ponašanje), `timeoutRetryMs`, `visestrukiProzorH`
  (`config/critic-gate.example.json`).
- K1 istek roka auto test/parse → jedan ponovni pokušaj s duljim rokom, pa NEPROVJERENO (`unverifiable`, nikad pass).
- K2 worktree bez `node_modules` → za vrijeme suda poveznica na `node_modules` matičnog stabla (miče se nakon
  suda); bez nje nerazriješen paket u stablu bez ikakvog `node_modules` = okolina.
- K3 ENOSPC/EDQUOT = okolina samo uz stvarno pun disk (statfs) ili za datoteku koju spawn nije dirao.
- K4 isti potpis pada na drugom zadatku u prozoru, a ovaj spawn nije dirao test ni modul koji test uvozi →
  zatečen + jedan zadatak popravka u 7 dana (`$TM_HOME/data/kriticar_popravak_testa.json`; izvršitelj i projekt iz
  `TM_KRITICAR_POPRAVAK_IZVRSITELJ` / `TM_KRITICAR_POPRAVAK_PROJEKT`, bez njih zadatak nema dodijeljenog).
- K5 `docs/architecture/**` je snimka koda (ne pokreće se).
- TASK-5674: propisani `bun test` koji nije izveo nijedan test („filters did not match any test files",
  „Ran 0 tests") je NEPROVJEREN, nikad CRITIC_FAILED — i uz `lazniPadMode: off`. Okolina po tekstu ispisa vrijedi
  samo kad disk potvrdi da put-filter ne postoji u stablu provjere; test koji postoji i sam ispiše tu poruku
  ostaje pad. Kritičar propisane provjere izvodi u `rootDir` (stablo zadatka).
- Nije preneseno (samo domaćin, ADR-0023 §5): kuka „dirnuto samo jedno stablo" (`TmRazlike`), izbor
  sačuvanog worktreeja pri ponovnom spawnu (`WorktreeIsolation`) i voditelj lanca (ADR-0024) — dolaze s kompletom
  izvornog sustava.
- Testovi: `tests/kriticar-lazni-padovi.test.ts`, `tests/kriticar-stablo-zadatka.test.ts` (37); `diskNizak`
  očekivanje se računa iz istog statfs-a (test nije smio pretpostaviti prazan disk).
- Spojen TASK-5509 (odgovor na dolazni mail preko ploče — na node-A u pogonu od 14.10., a nije bio u main).
  `PostaOdgovor.procitajProvjereno` više ne čita stvarnu putanju opisnika iz procfs-a (na macOS-u je provjera
  „izvan dopuštene mape" tada tiho otpadala): realpath nakon otvaranja mora biti u dopuštenoj mapi i voditi na
  isti inode kao opisnik. Test `tests/posta-odgovor-prenosivo.test.ts`.

## 2026-10-21 — sigurnosna dorada K5: zatamnjivanje loga, TM_BIND zadano, javni docs/ (TASK-5686)

- Iz pregleda K5 (TASK-5659), nalazi S1–S3 i N2.
- S1 `scripts/instalacija/zapis.sh` `zatamni()`: skriva i vrijednost u navodnicima (`IME_TOKEN="…"`,
  `'…'`), Telegram token bez imena varijable (`api.telegram.org/bot<broj>:<35>/…`) i GitHub tokene
  (`ghp_…`, `github_pat_…`).
- S2 `src/core/vezanje.ts` `zadanaAdresa()`: bez `TM_BIND` ploča na macOS-u i u svakoj instalaciji
  paketa (`$TM_HOME/config/postavke.env` postoji) sluša samo na `127.0.0.1`; `0.0.0.0` ostaje samo na
  Linuxu bez postavke.env ili uz izričit `TM_BIND=0.0.0.0`.
- S3 brana `tests/bez-nasih-vrijednosti.test.ts` pretražuje i `docs/` (pravila za adrese, e-poštu,
  ID-ove chatova i korisnika, imena ljudi; osnovica 0), novi uzorak ID-a chata uz izuzeće izmišljenih
  primjera, uid-ovi i prezime. `docs/`, testovi, `locales/` i `scripts/posalji-dokument.ts` nose
  primjere (-1001234567890…-1001234567893, 10.0.0.x, 100000011, „vlasnik", example.com). Povijest NIJE prepisana.
- N2 `deinstaliraj.sh` / `provjeri-cisto.sh`: ključ tunela je samo redak čiji komentar je točno
  `tm-tunel`; tuđi ključ s `tm-tunel-x` ostaje.

## 2026-10-21 — K5 sigurnost: brana za root, upozorenje na neograničen sudo, suženi sudoers (TASK-5685)

- V2: `install.sh` i `deinstaliraj.sh` pokrenuti kao root izlaze s 2 („pokreni kao korisnik usluge, bez sudo");
  `servis.ts` odbija korisnika usluge `root` i prazan korisnik (plist s `UserName=root` se više ne radi).
- V1: korak preduvjeta u `install.sh` i bootcheck (nova stavka M8) javljaju UPOZORENJE kad `sudo -n -l`
  pokazuje `NOPASSWD: ALL`. `templates/servis/sudoers.primjer` (generator: `servis.ts sudoers --korisnik IME`)
  nabraja točne `launchctl` naredbe za svaku uslugu iz `usluge.json`, bez zamjenskih znakova.
  `docs/INSTALL.md` §2.4 i README: nakon instalacije zamijeni puni sudoers suženim.
- N1: poruka pada `sudo install` više ne upućuje na nepostojeći `install.sh --sudoers`.

## 2026-10-21 — README „Instalacija na novi stroj", primjeri postavki bez vrijednosti, brana granice repo ↔ čvor (TASK-5658)

- Plan Mac v2 K4a, P3.2: README (EN i HR) ima odjeljak „Instalacija na novi stroj (Linux / macOS)":
  preduvjeti za Debian (`apt-get`) i macOS (`xcode-select --install`, `sudo -v`), `git clone` →
  `install.sh --cvor <name> --profil upravitelj-cvora --baze`, provjera (`install-rezultat.json`, `/health`,
  `bootcheck.sh`), izbor AI servisa po volji (`prijava-ai.ts popis` / čarobnjak), lokalne postavke i tajne,
  uklanjanje `--do-nule`. `tests/readme-instalacija.test.ts` drži da svaka naredba i zastavica postoje,
  da su preduvjeti oni koje traži `install.sh` i da EN i HR imaju iste naredbe.
- P4.1: `config/postavke.env.primjer` i `config/memorija.primjer.json` bez ijedne vrijednosti (prazni
  host/port/banka; zadane vrijednosti su u kodu). `.gitignore`: `*.env` (osim `*.primjer.env`),
  `config/memorija.json`, `vjerodajnice*`, `*.local.*`. `install.sh` na kraju imenuje i `memorija.json`.
- Brana `bez-nasih-vrijednosti` proširena: adrese tailneta izvan primjernih blokova 100.64.0.0/24 i
  100.127.255.0/24, imena naših strojeva, imena banaka memorije, oblici stvarnih tokena (Telegram,
  OpenRouter, Anthropic, GitHub, GitLab), ime našeg bota i uid vlasnika. Sve osnovice su 0. Testovi
  kanala bot↔bot rabe izmišljeni bot i uid. Korpus znanja: opći uzorak `banka` (`src/znanje/Korpus.ts`),
  a dvije stavke s imenom banke redigirane su (MANIFEST obnovljen).

## 2026-10-21 — `scripts/bootcheck.sh`: provjera čvora M1–M7 na Linuxu i macOS-u (TASK-5657)

- Plan Mac v3 K4: bootcheck je sada u paketu (`scripts/bootcheck.sh` + `scripts/bootcheck.ts`), za oba OS-a:
  M1 vlasnik usluge, M2 radna mapa, M3 brana Hosta (200/403), M4 siročad na vratima, M5 prijava na bilo koji
  AI servis i mjerilo autonomije, M6 sat, M7 izvori memorije i RAG-a prema `memorija.json`. Zapis u
  `$TM_HOME/log/bootcheck/` (txt + json). Okolina usluge se čita iz živog procesa.
- Platforma: `opisUsluge()` (stanje, glavni PID i radna mapa iz `systemctl show` / `launchctl print`),
  `procesi()` (tablica jednim `ps` pozivom na macOS-u) i `ppid()`.
- `prijava-ai.ts`: `stanjePrijave()` prima OS, okolinu i spremište izvana (koristi ga bootcheck M5).

## 2026-10-20 — deinstalacija do nule, provjera čistoće i nadogradnja čvora (TASK-5656)

- Plan Mac v3 K3, P3.4: `scripts/deinstaliraj.sh` u tri razine (zadano: usluge i naredbe; `--sve`:
  i `$TM_HOME` nakon kopije 0600; `--do-nule`: i sve iz manifesta `instalirano.json`, označeni retci
  u datotekama ljuske, ključ tunela). Svaki put prolazi branu: ništa izvan `$HOME` osim
  `LaunchDaemons/hr.regoc.*`, `~/.ssh`, `~/Library`, `~/Documents` i sam paket se odbijaju (izlaz 9).
  `--suho` ispiše sve i ništa ne dira. Log u formatu P3.1, logovi instalacije sele u arhivu.
- `scripts/provjeri-cisto.sh`: samostalna (bez repozitorija i buna), redak po ostatku, 0 redaka = čisto.
- `scripts/nadogradi.sh`: logika dosadašnjeg omotača sa stroja koji postavlja čvorove, sada u paketu i
  za oba OS-a (bundle ili git remote, kopija baze, restart kroz upravitelj usluga, provjera da novi
  proces drži istu bazu i da je broj zadataka isti).
- `install.sh`: ono što bun/Claude/uv instalator dopiše u `~/.zshrc`/`~/.bashrc` omota oznakama
  (`scripts/instalacija/rc.sh`); mape alata koje prije instalacije nisu postojale idu u manifest.
- `docs/INSTALL.md` §10.1: uklonjena nepostojeća zastavica `--s-kompletom`.

## 2026-10-20 — `install.sh`: jedan ulaz za Debian i macOS, log instalacije, čvor, baze, komplet, AI prijava (TASK-5655)

- Plan Mac v3 K2: `scripts/install.sh` prepoznaje OS (Debian/Ubuntu, macOS ≥ 14; bash 3.2), provjerava
  preduvjete i na macOS-u ispisuje tablicu 35 Linux → macOS zamjena (`scripts/instalacija/preduvjeti-macos.tsv`).
  Bun, Claude CLI i uv dohvaća službenim skriptama u korisničku mapu (preuzimanje u datoteku, 3 pokušaja);
  Homebrew ne treba ni za jedan korak.
- Log (P3.1): `$TM_HOME/log/install/<vrijeme>/` s `koraci.jsonl` (redak po koraku s izlaznim kodom, i za
  preskočene), `install.log`, `okolina.txt` i `install-rezultat.json` (piše se i u padu i na Ctrl-C);
  tajne zatamnjene. Izlazni kodovi 3–8 po vrsti koraka.
- Idempotentno: drugo pokretanje = `GOTOVO: 0 promjena`; `--suho` ne piše ništa.
- `--cvor`: `postavke.env` (0600) s `TM_BIND` = petlja + tailnet; nova postavka ploče **`TM_BIND`**
  (`src/core/vezanje.ts`): popis adresa, bez nje `0.0.0.0` kao prije, neispravan unos → samo `127.0.0.1`.
- Usluge iz jednog opisa (`templates/servis/usluge.json`, `scripts/instalacija/servis.ts`): systemd korisnička
  jedinica ili LaunchDaemon (`UserName`, `ProcessType=Background`, `plutil -lint`); tajne kroz
  `scripts/s-okolinom.sh`, nikad u plistu.
- `--baze`: lokalni pgvector (pg0 + `vector`, 127.0.0.1:15433) i Hindsight (127.0.0.1:17796), zaustavljeni
  dok ih ne uključi `memorija.json` (`config/memorija.primjer.json`); lozinka baze samo u spremištu tajni.
- `--komplet`: komplet izvornog sustava samo iz `config/komplet.lock` (commit + sha256 manifesta).
- Manifest `$TM_HOME/instalirano.json` (sve stvoreno izvan git stabla, za deinstalaciju).
- AI servis po izboru: katalog 14 davatelja (`src/core/davateljiAI.ts`) i čarobnjak `scripts/prijava-ai.ts`;
  spremište tajni prima točno ime `CLAUDE_CODE_OAUTH_TOKEN` (Claude pretplata na macOS-u ide kroz
  `claude setup-token`), ostala imena s prefiksom `CLAUDE_` ostaju zabranjena.

## 2026-10-14 — odgovor na dolazni mail preko ploče, na nalog čovjeka (TASK-5509)

- Povod (node-A, 14.10.): bot razgovora je na nalog vlasnika napravio tablicu i nacrt odgovora, ali
  mail nije mogao poslati — razina `puno` namjerno ne čita tajne (SMTP lozinku). Slanje je odradio
  drugi agent ručno.
- Novo: `POST /api/email/posalji` s `odgovorNa` (UID ili ključ iz `posta.json`): primatelj je
  pošiljatelj primljene poruke (ili `Reply-To`), vlasnik UVIJEK u CC-u (nova postavka `vlasnik`;
  bez nje nema slanja), `Re:` predmet, `In-Reply-To`/`References`, privitci samo iz radne mape
  chata / `privitci/<chat>` / privitaka tog maila (realpath, bez `..`, O_NOFOLLOW, 10 datoteka /
  15 MB); mail mora biti obaviješten u chatu naloga.
- Nalog čovjeka (`src/PostaOdgovor.ts`): ljudski potez na `puno` dobiva jednokratni token
  (`TM_NALOG_POTEZA`, zaglavlje `X-Regoc-Nalog`) vezan uz chat i pošiljatelja; opoziva se na kraju
  poteza. Bot-poruka, autonomija i agenti ga nemaju → 403.
- Proba (`X-Regoc-Proba`) vanjskoj adresi ne šalje ništa, vraća pripremu.
- `PostaUlaz` sprema `Reply-To` i `References` dolazne poruke; `posta.json` → `odgovori[]` nosi
  kome, CC, privitke i Message-ID. Uputa modelu u identitetu razgovora, u svakom potezu s nalogom
  i u znanju čvora (`cvor/stanje`). Detalji: docs/INTEGRACIJE.md.

## 2026-10-08 — naredba `pdf`: PDF s hrvatskim slovima, provjeren prije slanja (TASK-5369)

- Povod (TASK-5360): node-A je poslao PDF iz vlastite reportlab skripte s Helveticom (WinAnsi,
  font nije ugrađen) i pdftotext je čitao „■vor" umjesto „čvor". md2pdf glavnog sustava traži
  Chromium kojeg na čvoru nema.
- Novo: `scripts/pdf` + `tools/pdf/pdf.py` — md/tekst → PDF (A4) s ugrađenim DejaVu Sans
  (i za tablice, popise i početni font platna, pa nijedan font u PDF-u nije neugrađen). Nakon
  izrade izvadi tekst (pdftotext, inače pypdf); ako fali ijedno č ć ž š đ iz izvora ili se pojavi
  zamjenski znak, PDF briše i vraća 5. Izlaz je JSON sa `send_doc` oznakom.
- `scripts/instaliraj-pdf.sh` (font, poppler-utils, venv s reportlab + pypdf, veza
  `~/.local/bin/pdf`, proba s č ć ž š đ); poziva ga `scripts/install.sh`.
- Upute čvora (`profili/upravitelj-cvora/CLAUDE.md.predlozak`): PDF samo naredbom `pdf`.

## 2026-10-08 — e-pošta do kraja: zapis u ulaz, slanje na zahtjev, stanje na kartici (TASK-5371)

- Nadogradnja `PostaUlaz` (TASK-5358): svaka nova poruka je, uz obavijest u grupu čvora, i JEDAN
  `POST /api/ingest` sa `source: 'email'` (externalId = Message-ID, inače `imap:<uidvalidity>:<uid>`).
  Zove se nakon što je stanje pomaknuto, pa restart ploče ne ponavlja ni obavijest ni zapis.
- Dedup i po Message-ID-u (zadnjih 500): ista poruka pod novim UID-om ne daje drugu obavijest.
- Sigurnost: izvor `email` NE nasljeđuje `perSource['*']: 'on'`. Bez izričitog `perSource.email`
  mail se u ulazu bilježi kao sjena i ne otvara zadatak sam. Zadatak se otvara odlukom čovjeka
  u grupi (`zadatak`).
- Novo: `POST /api/email/posalji {predmet, tekst, prima?}` je slanje na zahtjev (agent/bot) i vraća
  Message-ID. Adrese se biraju samo s popisa `primatelji`, pa ploča nije otvoreni relej.
- Obavijest o zadatku (completed/failed) ide i e-poštom kad je izlaz uključen i ima primatelja.
- Kartica E-pošta pokazuje provjeru pošte (radi/greška, zadnja provjera, broj obavijesti), zadnju
  primljenu poruku i zadnju grešku (ona ostaje vidljiva i nakon oporavka).

## 2026-10-07 — razgovor: SEND_DOC iz privitaka chata, trag na ploči, trajna konzola (TASK-5337)

- Popravak (node-A 07.10.): oznaka `[[SEND_DOC: /put | opis]]` smije slati i iz mape privitaka
  TOG chata (`privitci/<chatId>`, nova ovisnost `dokumentiMapeChata`); prije je jedina dopuštena
  bila radna mapa pa je xlsx koji je bot izradio uz privitke odbijen („izvan dopuštene mape").
  Identitet sada navodi STVARNE mape i kaže da oznaka nije primjer (svaka oznaka je slanje).
- Popravak: neuspjelo slanje dokumenta javlja razlog u chat (`📎 dokument X nije poslan: Telegram
  sendDocument HTTP 400: …`, bez tokena) — novi `Kanal.posaljiDokumentIshod`.
- Novo: trag razgovora na ploči (`src/razgovor/ZadatakRazgovora.ts`). Potez s drugim botom (od
  njega ili upit prema njemu) odmah, a ljudski potez dulji od 20 s, otvara zadatak niti
  (bez nositelja, oznake `razgovor` + `no-autonomy` + `chat:<kanal:id>`) s bilješkama 📥 primljeno →
  ⚙️ radi → 💬 odgovor / 📤 upit drugom botu → ✅ gotovo; poruke upućene drugome dok je nit
  otvorena upisuju se kao 👁 pročitano. Upit drugom botu drži nit u radu najviše 30 min, zatim
  ⌛ zatvaranje. Stanje niti u `data/razgovor/zadaci.json`. Zadatak se zatvara izravno kroz
  jezgru ploče (trag, ne posao agenta — ne ide kroz kritičara).
- Novo: retci Konzole razgovora upisuju se i u `data/razgovor/konzola.log`; `GET
  /api/konzola/logs?source=razgovor`, naredba `logs razgovor N`, a Konzola pri otvaranju pokaže
  zadnjih 30 redaka.
- Novo: `bun scripts/posalji-dokument.ts --chat <id> --datoteka </put> [--opis …] [--suho]` —
  slanje tokenom bota OVE instalacije iz konfiguracije čvora, samo u chat iz postavki.

## 2026-10-07 — revizija blokiranih i zatvaranje kroz daemon na ploči (TASK-5327)

- Novo: naknadna revizija blokiranih (prijenos TASK-5204 izvornog sustava). `PUT status=blocked`
  dobiva oznaku `blok:<klasa>` (prekidač `revizijaBlokiranih` = sjena; `revizijaBlokiranihLive` =
  uživo: bez `blockedReason` 400, `COVJEK` dobiva i `waiting-for-human`). Rute
  `GET /api/blokirani/revizija` (skupine ponovno / covjeku / istroseno / ostalo, proračun),
  `GET /api/tasks/:id/revizija` (povijest presuda), `GET/PUT /api/config/revizija-blokiranih`
  (način off/shadow/on + klase uživo, audit u `settings_history`). Ploča: traka „Blokirano”,
  bedž na kartici, polje u detaljima s „Pusti sada” / „[ARHIVA]”, kartica na Config stranici.
  Modul `src/core/RevizijaBlokiranih.ts` — presude računaju ISTA pravila kao daemon.
- Novo: `POST /api/tasks/:id/reclaim {from:"blocked"}` — smiju samo `revizija-blokiranih`,
  `covjek` (gumb ploče) i `pozadina-gotova`; oznake blokade koje je dao SUSTAV odlaze s blokadom,
  ručna ljudska oznaka zadržava zadatak (409 `Human-gated`). `task_history` sada bilježi i
  promjenu oznaka (`tags`, `oznake_auto`).
- Novo: zatvaranje kroz daemon (prijenos TASK-5164 B). `completed` od bilo koga osim daemona
  (`X-REGOC-Zatvara: daemon` + `X-REGOC-Zatvarac: <ključ>`, usporedba `timingSafeEqual`) i čovjeka
  (`X-REGOC-Zatvara: covjek`) je ZAHTJEV: uz `zatvaranjeKrozDaemonLive` → 202, zadatak ostaje
  `in_progress` s oznakom `ceka-kriticara`; u sjeni (`zatvaranjeKrozDaemon`) se samo bilježi.
  Modul `src/core/ZatvaranjeKrozDaemon.ts`. Kritičara izvodi daemon (na čvoru: komplet izvornog
  sustava). Nove varijable `TM_IZVORNI_PODACI`, `TM_STALE_WATCHDOG_CONFIG` (v. env.example).
- Odlučitelj: `PUT /api/odlucitelj/config` prima `rizicno_covjeku` (rizici koje model nikad ne
  odlučuje; sprema ga kartica revizije).

## 2026-10-07 — značka živih spawnova i „BEZ PROCESA” na ploči (TASK-5323)

- Novo: `GET /api/config/concurrency` → `active` broji ŽIVE spawnove po najmovima (pid provjeren
  kroz `/proc`), `activeSource: "najmovi"` i `liveSpawns` (taskId, agent, pid, startedAt), kad
  bar jedna mapa najmova postoji: paketova (`stanje/spawn_leases`) i/ili `TM_IZVORNI_NAJMOVI`
  (daemon sustava domaćina — komplet izvornog sustava na čvoru). Bez ijedne mape ostaje
  `activeSource: "in_progress"` (kao prije).
- Ploča: stupac „In Progress” nosi značku `(aktivno/strop aktivna)`, a zadatak `in_progress` bez
  živog najma oznaku ⚠ BEZ PROCESA — samo uz izvor „najmovi” (inače bi bila lažna uzbuna).
  Modul `src/core/TaskCloser.ts` (`izvoriNajmova`, `ziviNajmovi`, `stanjeSpawnova`).

## 2026-10-07 — „prebaci sve na model" i kvota samo za Anthropic razgovor (TASK-5305)

- Novo: Config kartica „Model sustava — prebaci sve na jedan model" i `GET/PUT /api/models/svi`
  (`{ model: "openrouter:z-ai/glm-5.2" }`, `""`/`"vrati"` = natrag). Prekidač samo PIŠE postojeća
  polja `model-config.json` (`defaults`, `agentOverrides` + `razgovor`, `componentOverrides`); ne
  dira `embeddings` ni `classifier`. Stanje prije prvog prebacivanja čuva se u `_prebaciSvePrije`.
  Modul `src/core/models/PrebaciSve.ts`.
- Razgovor: `provider:model` ide istim `claude -p` uz `ANTHROPIC_BASE_URL` (Anthropic-kompatibilni
  `baseUrl` providera; OpenRouter `https://openrouter.ai/api`, ključ iz `credentials.env`), bez
  prijave pretplate. Vrata kvote (Anthropic sesija) pitaju se samo kad razgovor ide preko Anthropica.
  Dok je prekidač uključen, `agentOverrides.razgovor` ima prednost i pred `razgovor.model`.

## 2026-10-06 — glasovne poruke u razgovoru: lokalni STT i odgovor glasom (TASK-5294)

- Novo: postavke `razgovor.glasPrepoznavanje` (zadano false), `razgovor.glas` = off |
  na-glasovno | uvijek (zadano off), `razgovor.glasUrl` (prazno = `http://127.0.0.1:8899`),
  `razgovor.glasGlas` (ime glasa servisa; prazno = zadani), `razgovor.glasRokSek` (10–600,
  zadano 120) — Config → Razgovor, blok 🎙️, vrijede odmah. Config prikazuje stanje servisa i
  dostupne glasove (`GET /api/config/razgovor` → `glas`). Modul `src/razgovor/Glas.ts`.
- Glasovna, zvučna i video-krug (`video_note`, nova vrsta privitka) poruka od dopuštenog
  pošiljatelja → privitak → lokalni STT → u ulaz i razgovor kao `[GLAS] <transkript>` uz
  `[PRIVITAK: …]`; transkript se sprema uz privitak (`<datoteka>.txt`, 0600). Traži uključene
  privitke (`telegram.privitci`). Lažna oznaka `[GLAS]` u tuđem tekstu postaje `(GLAS]`.
- Odgovor glasom: TTS → `sendVoice` (ogg/opus) kao odgovor na pitanje, NAKON teksta; izgovara se
  odgovor bez markdowna, koda, poveznica, emojija i oznake memorije (≤1200 znakova).
- Fail-open s vidljivom oznakom: `🎙️🚫 transkript nije uspio: <razlog>` (u chat i u tekst
  poruke), `🔊🚫 glasovni odgovor nije uspio: <razlog>`. Rok STT/TTS je tvrd.
- ADR-0002 §20. Test: `tests/razgovor-glas.test.ts` (36).

## 2026-10-06 — privitci iz Telegrama spremaju se lokalno (TASK-5282)

- Novo: postavka `telegram.privitci` `{ukljucen (zadano false), mapa (prazno = $TM_HOME/privitci),
  maxMB (1–20, zadano 20), vrste: photo/document/voice/audio/video}` na Config stranici (kartica
  Telegram, blok „Privitci"), vrijedi odmah bez restarta. Modul `src/TelegramPrivitci.ts`.
- Kad je uključeno: `getFile` → preuzimanje (fotografija u najvećoj rezoluciji) u
  `<mapa>/<chatId>/<datum>_<message_id>_<izvorno ime>`, a ulaz (`/api/ingest`) i razgovor dobivaju
  putanju u tekstu: `[PRIVITAK: /putanja]` (ili `[PRIVITAK nije spremljen: razlog]`). Poruka samo
  s privitkom više se NE preskače. Isključeno = ponašanje kao prije.
- Sigurnost: preuzima se samo u dopuštenim chatovima (`ulaz.dopusteniChatovi`) i od korisnika s
  popisa ulaza ili razgovora (id ili korisničko ime); bez ikakvog izričitog popisa ništa.
  Ime sanitizirano (samo osnovno ime, bez `..`, kose crte i vodeće točke) uz provjeru da odredište
  ostaje u mapi; strop veličine prema poruci, `getFile`, `Content-Length` i pročitanim bajtovima;
  datoteka 0600, nikad izvršna. Token se iz teksta greške briše (`bezTajne`).
- Oba smjera (uputa vlasnika #187): dokument koji bot pošalje u chat (SEND_DOC, `Kanal.posaljiDokument`)
  kopira se u istu mapu chata (`<datum>_<message_id>_<ime>`, 0600), a svaki privitak — primljen ili
  poslan, spremljen ili ne (s razlogom) — upisuje se u `<mapa>/<chatId>/evidencija.jsonl`
  (`smjer`, `kad`, `tkoId`, `tko`, `putanja`, `izvor`, `greska`).
- Pošiljatelj ne može glumiti oznaku: `[PRIVITAK` u njegovu tekstu postaje `(PRIVITAK` (kao `Ciscenje.ts`).
- Test: `tests/telegram-privitci.test.ts` (26).

## 2026-10-04 — /api/odlucitelj/config više ne visi kad OpenRouter nije dostupan (TASK-5233)

- Ispravak: na nodu bez izlaza prema openrouter.ai `GET /api/odlucitelj/config` (i
  `/api/dezurni/config` s davateljem `openrouter`) vraćao je PRAZAN odgovor nakon 11–15 s —
  dohvat kataloga čekao je 15 s, a Bun.serve prekida zahtjev nakon 10 s (`idleTimeout`). Rok
  vanjskog kataloga je sada `KATALOG_ROK_MS` = 3 s (Ollamin `/api/tags` zadržava 4 s), a
  katalog se pamti: uspješan 10 min, nedostupan 5 min. Odgovor je 200 s `dostupno: false` i
  greškom, kao na nodu s izlazom.
- Novo: `TM_OPENROUTER_KATALOG_URL` — adresa kataloga modela (zadano
  `https://openrouter.ai/api/v1/models`); za proxy i za test koji glumi spori katalog.
- `/api/gita/health` dobio isti rok (prije bez roka).
- Ploča kao autora upisa (`by`) šalje neutralno `vlasnik`, ne ime — to se ime upisivalo u
  audit postavki na tuđem nodu. Brana `bez-nasih-vrijednosti` dobila pravilo koje to hvata.
- Test: `tests/vanjski-katalog-rok.test.ts` (katalog koji šuti 15 s → 200 prije 5 s, drugi
  poziv iz keša ispod 1 s, dežurni isto).

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
