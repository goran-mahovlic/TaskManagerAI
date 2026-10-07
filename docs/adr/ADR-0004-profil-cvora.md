# ADR-0004 — Profil čvora: sve postavke osim tajni u paketu, ponovljivo na sljedećem čvoru

| | |
|---|---|
| **Status** | Prihvaćeno (dizajn). Izvedba: Jelena; proba: Potjeh (v. §10) |
| **Datum** | 06.10.2026. |
| **Autorica** | Kosjenka (Architect), TASK-5295 |
| **Zahtjev** | Goran, 06.10.2026. 19:19: „kad node-A bude podešen, SVE osim tajnih podataka mora ući u modularni TaskManagerAI, cilj: lako ponoviti na sljedećem čvoru (node-B, …)" |
| **Veze** | ADR-0001 §8 (brana „bez naših vrijednosti"), ADR-0002 (razgovorni način), ADR-0003 (kanal bot↔bot), ADR-0010 izvornog sustava (vlasništvo usluge 17781 na čvoru) |

---

## 1. Problem

node-A je složen **rukom**, kroz najmanje sedam zasebnih isporuka u jednom danu, svaka sa svojom
skriptom na glavnom stroju (`deploy/node-a-{samostalnost,home,memorija,izlaz,upravitelj}`,
`tm-cvor-azuriraj.sh`, `tunel-nodea.sh`) i s postavkama upisanim s ploče. Nigdje ne postoji
popis onoga što node-A **jest**. Izmjereno 06.10.2026., samo čitanje:

| Što | node-A | node-B |
|---|---|---|
| kod paketa | `db161f77` (grana isporuke TASK-5290 + 2 commita napravljena **na čvoru**, TASK-194) | `8d52710` |
| razgovorni modul / kanal bot↔bot / glas | da / da / da | ne / ne / ne |
| `config/telegram.json` | da (ulaz, privitci, stil `kratko`) | **nema** |
| `settings` `razgovor.*` / `memorija.*` | 24 / 7 ključeva | 0 / 0 |
| `TM_RAZGOVOR_PUNO`, `TM_RAZGOVOR_UPUTE`, `TM_BOT_KANAL_TOKEN` u okolini ploče | da | nema |
| Claude CLI / prijava | 2.1.215 / postoji | 2.1.215 / **nema** |
| `~/.claude/settings.json` + SecurityValidator | da (sha256 `42cfd891…`, isti kao na glavnom) | **nema** / **nema** |
| `~/CLAUDE.md` (vodič upravitelja) | 5 122 B | **nema** |
| capguard `allow_messaging` / `allow_root` | on / on | **off** / **off** |
| tunel memorije 127.0.0.1:17792 | sluša | **ne** |
| tuđi HOME u `RegocDaemon.ts` izvornog sustava | 0 | **1** |
| RAG (`TM_CHROMA_*`) | isključen | isključen |
| disk | 71 % | **89 % (2,0 GB slobodno)** |

Dva nalaza su preduvjeti, ne detalji:

* **Kod node-A nije u `main`.** `d6a79fc` (isporuka TASK-5290 + TASK-5294) nije predak `main`
  (`git merge-base --is-ancestor d6a79fc main` → ne; 9 commita). Iz `main` se node-A danas ne
  može ponoviti — ni jednim profilom.
* **Na čvoru postoje commiti koje nitko drugi nema** (`30084bde`, `80996e4e`, TASK-194), iako
  vodič čvora kaže „ovdje ne raditi `git commit`". Sljedeći `tm-cvor-azuriraj.sh` (`checkout -f`)
  bi ih tiho odbacio.

## 2. Odluka u jednoj rečenici

Postavke čvora žive u **tri sloja s tri različita pravila** — *profil* (u paketu, u gitu),
*instanca* (po čvoru, izvan gita, nije tajna) i *tajne* (po čvoru, nikad se ne izvoze, unosi ih
čovjek) — a jedan alat paketa, `scripts/profil-cvora.ts`, zna profil **izvesti** s čvora,
**provjeriti** čvor prema njemu i **primijeniti** ga idempotentno, modul po modul.

## 3. Tri sloja

| Sloj | Gdje | Što | Tko piše | Ide li u git paketa |
|---|---|---|---|---|
| **Profil** | `profili/<ime>/profil.json` | način rada: prekidači, rokovi, stil, ovlasti, željene sposobnosti, oblik `settings.json`, popis značajki koje kod mora imati | arhitekt / `izvezi` | **da** — i mora proći branu ADR-0001 §8 |
| **Instanca** | `$TM_HOME/config/profil.instanca.env` na čvoru; kopija na stroju s kojeg se čvorovi postavljaju | identiteti koji se razlikuju po čvoru: chat id, dopušteni korisnici, ime bota, banka memorije, adrese, `SUSTAV_DIR` | čovjek / `izvezi` | **ne** (primjer: `profili/<ime>/instanca.primjer.env`) |
| **Tajne** | gdje već žive: datoteka vjerodajnica (`TM_CREDENTIALS`), `config/postavke.env` (0600), `~/.claude` prijava, capguard odobrenja | bot token, tajna kanala bot↔bot, Claude prijava, Tier-2 odobrenja | **samo čovjek** | **nikad**; u profilu samo **ime** |

Zašto instanca nije u profilu: brana ADR-0001 §8 ne pušta u paket naše chat id-eve, IP-ove ni
imena, a sljedeći čvor ionako ima **drugi** bot, drugu grupu i drugu banku memorije. Profil bez
instance je ono što se ponavlja; instanca je ono po čemu se čvorovi razlikuju. Vrijednost u
profilu koja ovisi o čvoru piše se `${IME}` (niz) ili `${IME:json}` (popis/objekt).

Referentna instanca node-A spremljena je na glavnom stroju:
`~/.claude/regoc/deploy/profili/node-A.instanca.env` (izvan paketa; v. §8 za dokaz da profil +
ta instanca točno daju node-A).

## 4. Moduli

Profil je podijeljen na module. Svaki ima **vlasnika**, a vlasnik određuje smije li alat
modul *primijeniti* ili ga samo *provjerava*:

| Vlasnik | Alat smije | Primjer |
|---|---|---|
| `paket` | provjeriti **i** primijeniti | `telegram.json`, `razgovor.*`, `memorija.*`, netajni retci `postavke.env` |
| `izvorni-sustav` | samo provjeriti; javlja koji komplet to donosi | servis glasa, kuka SecurityValidator, HOME u datotekama daemona |
| `stroj-root` | provjeriti i **upisati namjeru** (pending) kroz API ploče | capguard sposobnosti |
| `glavni-stroj` | provjeriti s čvora; postupak je na glavnom stroju | tunel memorije 17792 |
| `covjek` | ništa — samo stavka kontrolnog popisa | tajne, Claude prijava, Tier-2 odobrenja, `TM_RAZGOVOR_PUNO=1` |

Moduli profila `upravitelj-cvora` (pokrivaju cijeli opseg iz grupe node-A, 06.10.):

| Modul | Obuhvat iz zahtjeva | Vlasnik | Primjena | Provjera |
|---|---|---|---|---|
| `paket` | — (preduvjet) | paket | **ne** (ažuriranje koda ostaje `tm-cvor-azuriraj.sh`) | sve značajke iz `paketSadrzi` prisutne; bun/claude/python3 verzije; unit `regoc-taskmanager` aktivan |
| `okolina` | HOME umjesto `/home/klaudio`, RAG isključen | paket | dopiše/ispravi samo retke s bijele liste; tajne retke ne dira | svaki ključ = profil; `TM_CHROMA_*` ne postoji; tajni ključevi samo „postoji" |
| `telegram` | Telegram ulaz, privitci oba smjera, stil kratko | paket | spoji JSON (`botToken` se nikad ne piše) | svako polje = profil; uživo `getMe` vraća username (ne token) |
| `razgovor` | razgovorni način: odgovaraNa, preskociAkoSadrzi, dopušteni, ovlasti/puno, radniDir; typing i konzola | paket | `PUT /api/config/razgovor`, `changedBy=profil-cvora` | svaki ključ = profil; `ovlasti=puno` samo uz `TM_RAZGOVOR_PUNO=1` |
| `glas` | glas STT/TTS | paket + izvorni-sustav | postavke da; servis ne | `razgovor.glas*`; unit `regoc-voice` aktivan, 127.0.0.1:8899 sluša, `WHISPER_MODEL` |
| `memorija` | Hindsight: banka, rok 20 s, 🧠🚫 | paket | `PUT` kroz API | ključevi; `memorija.url` odgovara (`/health`) |
| `tunel-memorije` | tunel 17792 (strana glavnog stroja) | glavni-stroj | ne | 127.0.0.1:17792 sluša na čvoru |
| `bot-kanal` | kanal bot↔bot + „Prekini komunikaciju" | paket | `PUT` kroz API, samo ako instanca ima `BOTKANAL_ADRESE` | ključevi; `TM_BOT_KANAL_TOKEN` postoji (samo ime) |
| `capguard` | kartica Sigurnost + postupak odobrenja (internet/root) | stroj-root | za razliku upiše zahtjev `pending` | stanje iz `/etc/regoc/capabilities.state` = `zeljeno` |
| `claude` | prijava (auth login), settings.json + SecurityValidator | paket + izvorni-sustav + čovjek | `settings.json`: spoji samo `hooks` (ne briše tuđe ključeve), uz kopiju prije | hooks = profil; kuka postoji i sha256 = instanca; prijava postoji (bez čitanja sadržaja) |
| `upravitelj` | CLAUDE.md / identitet upravitelja čvora | paket | napiši `~/CLAUDE.md` iz predloška + instance (≤ 16 000 zn.) | datoteka postoji, `TM_RAZGOVOR_UPUTE` pokazuje na nju |
| `home` | HOME umjesto `/home/klaudio` | izvorni-sustav | ne (komplet `isporuka_home_*`) | `grep -c "${TUDI_HOME}"` u datotekama daemona = 0 |
| `rag` | RAG isključen | paket | ne | nema `TM_CHROMA_*` |

„Typing" i „Konzola razgovora" (ADR-0002 §18.6) nemaju postavku — to je ponašanje koda, pa
ih pokriva modul `paket` (značajka mora biti u kodu), ne vrijednost u profilu.

## 5. Alat `scripts/profil-cvora.ts`

```
bun scripts/profil-cvora.ts provjeri  [--profil upravitelj-cvora] [--instanca <env>] [--json]
bun scripts/profil-cvora.ts primijeni [--profil …] [--instanca …] [--modul a,b] (--suho | --pisi)
bun scripts/profil-cvora.ts izvezi    [--profil …] --instanca-van <env>   # s postojećeg čvora
```

**Pravila (svako je mjerilo u §10):**

1. **Bijela lista, ne crna.** Izvoz piše samo ključeve koje profil imenuje. Ključ koji profil
   ne poznaje (npr. novi tajni redak u `postavke.env`) **ne izvozi se nikad** — nepoznato je tajno
   dok se ne dokaže suprotno. Polja `nikadNeIzvozi` (`botToken`, `razgovor.botKanal.stanje`) i
   `tajneImenom` izvoz preskače i kad bi ih bijela lista slučajno obuhvatila.
2. **Tajna se nikad ne čita u izlaz.** Za tajnu se smije reći samo `postoji` / `nema` (i, gdje
   ima smisla, uživo provjera koja vraća javni podatak: `getMe` → username). Nijedan način rada
   alata ne ispisuje vrijednost, ni djelomično.
3. **`provjeri` i `primijeni --suho` ne mijenjaju ništa.** Baza se otvara `mode=ro`; nijedna
   datoteka, unit ni redak `settings_history` ne nastaje. Dokaz u probi: otisak čvora prije =
   poslije (§8).
4. **`--suho` je zadano.** Bez `--pisi` alat ništa ne piše. Pisanje na čvor koji nije lokalni
   (node-B …) traži Goranovo odobrenje u zadatku — alat to ne može provjeriti, pa je to stavka
   procedure, ne koda.
5. **Idempotentno.** Primjena uspoređuje pa piše samo razliku; drugi `--pisi` zaredom mora
   javiti „0 promjena". Postavke ploče idu **kroz API** (`PUT /api/config/razgovor`, …), ne
   izravno u SQLite — da validacija paketa vrijedi i da svaka promjena ima redak u
   `settings_history` s `changedBy=profil-cvora`.
6. **Kopija prije pisanja datoteke.** `telegram.json`, `postavke.env`, `settings.json`,
   `CLAUDE.md`: kopija u `$TM_HOME/backup/profil-<vrijeme>/` prije prve izmjene, prava 0600
   zadržana.
7. **Ovlast se ne podiže alatom.** `razgovor.ovlasti=puno` alat upisuje samo ako je
   `TM_RAZGOVOR_PUNO=1` **već** postavio čovjek; inače upiše `citanje` i javi upozorenje.
   Capguard Tier-2 alat samo **traži** (pending), nikad ne odobrava.
8. **Ne restartaj ploču ni daemon iz alata.** Postavke razgovora vrijede uživo (keš ≤ 5 s);
   promjena `postavke.env` traži restart `regoc-taskmanager`, koji alat samo **javi**
   („potreban restart: da") — izvodi ga postupak čvora kad je 0 zadataka `in_progress`.
9. **Vlasnik modula određuje dubinu.** Moduli `izvorni-sustav`, `stroj-root`, `glavni-stroj`
   i `covjek` u `primijeni` daju samo „što nedostaje i čime se donosi".

**Izlaz** po modulu: `OK` · `RAZLIKA <ključ>: profil=… čvor=…` · `NEDOSTAJE` · `TAJNA-NEDOSTAJE <ime>`
· `ČOVJEK <stavka>` · `PRESKOČENO (uvjet)`, pa zbroj. `--json` daje isto strojno.
**Izlazni kodovi:** `0` sve OK · `1` ima razlika koje alat zna primijeniti · `2` nedostaju
tajne ili ljudske stavke (ostalo OK) · `3` preduvjet pao (kod bez značajke, nema baze, profil
neispravan) · `4` alat odbio (npr. `--pisi` bez `--modul` na tuđem čvoru).

## 6. Postupak za novi čvor (redoslijed)

1. **Kod:** `tm-cvor-azuriraj.sh <čvor>` na commit koji sadrži sve iz `paket.paketSadrzi`
   (preduvjet P1, §9).
2. **Instanca:** kopiraj `instanca.primjer.env` → `$TM_HOME/config/profil.instanca.env`, upiši
   vrijednosti čvora.
3. **Provjera:** `profil-cvora.ts provjeri` → popis razlika.
4. **Tajne i ljudske stavke:** [PROFIL_CVORA_TAJNE.md](../PROFIL_CVORA_TAJNE.md), redom.
5. **Primjena:** `primijeni --suho` → pregled → `primijeni --pisi` (uz odobrenje).
6. **Restart ploče** ako je alat to javio, kad je 0 zadataka `in_progress`.
7. **Ponovna provjera** → izlazni kod `0`; drugi `primijeni --pisi` → „0 promjena".

## 7. Što ne radimo (i zašto)

* **Ne kopiramo bazu** s node-A na novi čvor: `settings` nose i stanje (`botKanal.stanje`,
  povijest), a ne samo postavke. Profil nosi samo ono što je odluka.
* **Ne stavljamo instancu node-A u paket**, ni u `docs/`: paket je javan, a uid vlasnika i chat
  id grupe nisu podatak paketa.
* **Ne nosimo SecurityValidator ni servis glasa u paketu** u ovom koraku: to je kod izvornog
  sustava s njegovim putanjama. Profil ih **provjerava** (postoji + sha256). Prijenos u paket je
  zasebna odluka (otvoreno pitanje O1, §11).
* **Ne zamjenjujemo `tm-cvor-azuriraj.sh`:** on prenosi **kod**, profil prenosi **postavke**.
  Dva alata, dvije odgovornosti.

## 8. Dokaz dizajna (izmjereno 06.10.2026., prije izvedbe)

Proba dizajna (ne alat iz §5): `stanje_cvora.py` na čvoru skuplja **samo netajne** ključeve
(bijela lista, baza `mode=ro`), `usporedi.py` na glavnom stroju supstituira instancu u profil i
uspoređuje vrijednost po vrijednost. Skripte i izlaz suhog prolaza na node-B: `docs/qa/TASK-5295/`.

* **node-A, profil + `node-A.instanca.env` → 73 iste, 0 razlika** (exit 0). Prvi prolaz je
  pokazao 1 razliku (`timeout: 15` na kukama u `settings.json`), profil je ispravljen pa
  ponovljen. Profil dakle **potpuno opisuje** živi node-A u svim modulima koje alat smije
  primijeniti ili provjeriti.
* **node-B, suhi prolaz, profil + `instanca.primjer.env` → 10 istih, 63 razlike** (exit 1):
  `telegram` 21, `settings` 29, `okolina` 9, `capguard` 2 (`allow_messaging`, `allow_root`),
  `claude` 2 (nema `settings.json`, nema kuke). Uz to modul `paket`: na `8d52710` nema
  razgovornog modula, kanala bot↔bot ni glasa → izlazni kod bi bio **3** (preduvjet).
* **node-B nije promijenjen:** otisak (hash `ls -l` konfiguracije i `~/.claude`, `git
  rev-parse`, `git status`, broj redaka `settings` i `settings_history`) prije = poslije =
  `f5cb881623fae8a0`.

## 9. Preduvjeti (prije prve primjene na node-B)

| # | Preduvjet | Zašto | Tko |
|---|---|---|---|
| P1 | Isporuka TASK-5290 + TASK-5294 (grana `isporuka/TASK-5290-nodea`, `d6a79fc`) spojena u `main` | inače profil traži značajke koje `main` nema; node-A vrti kod koji nitko ne može ponoviti | REGOČ / vrata spajanja |
| P2 | Commiti `30084bde`, `80996e4e` s node-A preuzeti ili svjesno odbačeni | sljedeći `checkout -f` ih briše bez traga | Goran odlučuje |
| P3 | Na node-B oslobođen disk (89 %, 2,0 GB) | `install.sh` + `bun` + sesije razgovora | Goran / čvor |
| P4 | Drugi bot (BotFather) i grupa za node-B | Telegram dopušta jedan `getUpdates` po tokenu — node-B ne smije dijeliti token s node-A | Goran |

## 10. Mjerila prihvaćanja

**Jelena — izvedba** (`bun test`, bez mreže i bez pravog modela):

| # | Mjerilo |
|---|---|
| J1 | `profili/upravitelj-cvora/profil.json` validira se shemom (zod); neispravan profil → izlaz 3 s porukom koja imenuje polje |
| J2 | `${IME}` / `${IME:json}` supstitucija; nedostaje obavezna varijabla instance → izlaz 3; nepoznata varijabla u profilu → izlaz 3 |
| J3 | `izvezi` na čvoru-dvojniku s ubačenim nepoznatim ključem `TM_NESTO_TAJNO=x` i `botToken` u JSON-u → izvoz ih **ne sadrži** (bijela lista) |
| J4 | ni u jednom načinu izlaz ne sadrži vrijednost kanarinca postavljenog kao tajna (`TELEGRAM_BOT_TOKEN`, `TM_BOT_KANAL_TOKEN`) |
| J5 | `provjeri` i `primijeni --suho`: hash svih datoteka i broj redaka `settings_history` prije = poslije |
| J6 | `primijeni --pisi` dvaput zaredom: drugi put „0 promjena", `settings_history` ne raste |
| J7 | `ovlasti=puno` bez `TM_RAZGOVOR_PUNO=1` → upisano `citanje` + upozorenje; s njim → `puno` |
| J8 | capguard razlika → zahtjev `pending` u `capability_requests`, nikad `approved`/`applied` |
| J9 | `settings.json`: postojeći tuđi ključevi i kuke ostaju, dodaje se samo ono iz profila; kopija prije |
| J10 | `profil-cvora.ts izvezi` na node-A (samo čitanje) + `usporedi` s predanim profilom → 0 razlika |
| J11 | `CLAUDE.md.predlozak` iz kanona `deploy/node-a-upravitelj/CLAUDE.md` s `{{…}}` mjestima; brana ADR-0001 §8 zelena |
| J12 | `docs/INSTALL.md` dobiva odjeljak „Novi čvor iz profila" (§6 ovog ADR-a) |

**Potjeh — proba** (stvarni čvorovi):

| # | Mjerilo |
|---|---|
| P1 | node-A: `provjeri` → izlaz 0 (ili samo stavke `covjek`) |
| P2 | node-B: `provjeri` i `primijeni --suho` → popis razlika ≈ §8 (63 + preduvjet), otisak prije = poslije |
| P3 | grep izlaza oba prolaza: nijedna tajna (token, tajna kanala, sadržaj prijave) |
| P4 | `primijeni --pisi` na node-B **tek uz Goranovo odobrenje** i nakon P1–P4 iz §9; zatim `provjeri` → 0/2 i drugi `--pisi` → 0 promjena |

## 11. Otvorena pitanja

* **O1** — Ulaze li SecurityValidator i servis glasa u paket (kao neobavezni moduli) ili ostaju
  u kompletu izvornog sustava? Za ponovljivost je dovoljno ovo drugo + sha256 provjera.
* **O2** — Tunel 17792 je danas jedna petlja za jedan čvor (`tunel-nodea.sh`). Za node-B treba
  isti obrazac s parametrom cilja; je li to druga petlja ili jedna s popisom čvorova, odluka je
  izvornog sustava.
* **O3** — `TG_DOPUSTENI_CHATOVI` na node-A sadrži korisnički ID (nalaz TASK-5278). Profil to
  bilježi kako jest; ispravak je vlasnikova odluka.

## 12. Posljedice

**Dobro:** node-A je prvi put opisan u jednoj datoteci, provjerljivo (73/73). Novi čvor je
postupak od 7 koraka umjesto sedam isporuka. Odstupanje čvora od profila postaje mjerljivo
(`provjeri` u petlji ili prije isporuke).

**Cijena:** profil mora pratiti paket — novi ključ u `razgovor.*` koji treba ponoviti mora ući i
u profil, inače ga izvoz (bijela lista) neće vidjeti. To je namjerno: radije propušten ključ
koji `provjeri` prijavi nego iscurjela tajna.

---

## 13. Dopuna (TASK-5307, 07.10.2026.) — paritet s glavnim sustavom: kuke, značajke, konzola, oporavak

**Zahtjev** (Goran, 07.10., grupa node-A): „na node-A su ugašeni hookovi, izlazi u konzolu i
značajke sustava; mora biti kao na glavnom sustavu i dio portabilnog TaskManagerAI-ja, novi nod
u par koraka." Neposredan povod: TASK-212 (Jelena) bio je siroče 23:38 → 10:15 jer oporavak na
čvoru nije radio, a uputa #2 nije stigla jer kuka `TaskInstructionsInject` nije spojena.

### 13.1 Izmjereno (samo čitanje; ponovljivo: `python3 docs/qa/TASK-5307/paritet.py regoc@192.168.10.20 --tsv`)

Izlaz: `docs/qa/TASK-5307/mjerenje_2026-10-07.txt` (izlazni kod 1, 99 razlika).

| Os | Glavni | node-A | Razlika |
|---|---|---|---|
| kuke u `~/.claude/settings.json` | 32 (SessionStart 5, PreToolUse 4, UserPromptSubmit 10, Stop 7, SubagentStop 2, Notification 2, PostToolUse 2) | 2 (samo SecurityValidator ×2) | 30 nespojenih; od toga **3 datoteke kuka ni ne postoje** na čvoru: `TaskInstructionsInject`, `RadBezZadatka`, `KatalogCuvar` |
| `features.json` | 75 ključeva, 53 ON | 39 ključeva, 24 ON | 37 različito uključenih (36 ključeva fali na čvoru → `isEnabled` = `false`) |
| kod izvornog sustava `~/.claude/regoc/*.ts` | 139 modula, `RegocDaemon.ts` 8 339 redaka | 111 modula, 7 433 redaka | **28 modula fali** (među njima `OrphanRecovery`, `TaskInstructions`, `PozadinaPovrat`, `ZatvaranjeKrozDaemon`, `Sudac`, `TaskCloser`, `AutonomyThresholdSetting`, `DaemonSingleton`) |
| prekidači s kodom samo na glavnom | — | — | 8: `siroceOporavak`, `pozadinaPovrat`, `revizijaBlokiranih(+Live)`, `zatvaranjeKrozDaemon(+Live)`, `sequentialHelpers`, `r2IzricitaDodjela` |
| izvori konzole ploče | `regoc_daemon.log`, `regoc.log`, `klaudio.log`, `voiceserver.log`, `taskwebui.log` — svi svježi | samo `regoc_daemon.log` svjež; `regoc.log` i `voiceserver.log` **nema**, `klaudio.log` star 27 d | servisi na čvoru pišu u journal (`StandardOutput=journal`), kuka konzole nije spojena |
| mjerilo potrošnje (`daemon.log`) | povremeni 401 (81 redak ukupno, zadnji 05.10.), samo-oporavak buđenjem CLI-a | 401 od ≈06:41 do 06:57 UTC 07.10., nakon buđenja CLI-a nema novog 401 | isti mehanizam na oba; nije kvar pariteta nego uvjet za `autonomyGate` (§13.2.1) |

**Tri ispravka Goranove slike** (važno za odluke):

1. Od 13 prekidača s popisa „OFF na node-A" njih **8 je OFF i na glavnom**, namjerno:
   `verificationGate`, `modeClassifyLive`, `tierRouting`, `staleReaperLive`, `sendBreakerLive`,
   `fileScopeGate(+Live)`, `reviewCheckpoint(+Live)`, `userFlushBacklog`. Paritet znači
   „kao glavni", ne „sve upaljeno". Stvarno ugašeni samo na čvoru: `autonomyGate`,
   `zombieRecoveryLive`, `deadAgentReaperLive`, `staleWatchdogLive`, `ollamaClassifier`.
2. Čvor je u četiri prekidača **agresivniji** od glavnog: `staleReaper` ON (na glavnom
   **TRAJNO ugašen** odlukom Gorana 02.09. — sudi suprotno od staleWatchdoga), `teamChainLive`,
   `autoResumeLive`, `projectGitInit` ON. `teamChainLive` + nečuvani `createSequentialHelpers`
   su put kojim je nastala kaskada `regoc-chain` (TASK-255).
3. **Prekidač bez koda ne radi ništa.** `siroceOporavak` (oporavak koji bi spasio TASK-212) na
   node-A nema `OrphanRecovery.ts`. Paritet se zato ne može postići samo kroz `features.json`:
   kod izvornog sustava na čvoru je stariji od glavnog. To je **preduvjet P5** (§13.4).

### 13.2 Odluka

Paritet ima **četiri osi**, a profil čvora ih pokriva s **tri nova modula** i proširenjem dva
postojeća. Načelo: **glavni sustav je mjerilo; čvor smije biti jednak ili oprezniji, nikad
agresivniji.** Odstupanje od glavnog je dopušteno samo kao stavka u profilu s razlogom.

| Modul profila | Vlasnik | Primjena | Provjera |
|---|---|---|---|
| `znacajke` (**novo**) | paket | spoji samo `enabled` ključeva koje profil imenuje u `~/.claude/regoc/features.json` (+ `config/features.json` paketa); `note`/`since` i nepoznati ključevi ostaju; kopija prije. **Bez restarta** — `FeatureFlags` čita datoteku uživo (TTL keš) | svaki ključ = profil; ključ ON bez koda na čvoru → `NEDOSTAJE kod <modul>` (izlaz 3) |
| `kuke` (**novo**; zamjenjuje `claude.settingsJson.hooks`) | paket + izvorni-sustav | spoji kuke iz profila u `settings.json` (tuđe ostaju, J9); putanje `${HOME}`/`${TM_HOME}`, nikad `/home/klaudio` | kuka spojena **i** datoteka postoji; kuka izvornog sustava bez datoteke → `NEDOSTAJE` |
| `konzola` (**novo**) | paket + stroj | user-unit drop-in `StandardOutput=append:%h/.tmp/regoc_logs/<izvor>.log` za `regoc-taskmanager`, `regoc-voice`; kuka `RegocConsoleLog` (modul `kuke`) | svaki izvor iz `logSources` ploče postoji i mlađi je od 24 h (ili servis ne radi) |
| `paket` (prošireno) | paket | ne | + `izvorniSustavSadrzi`: popis modula `~/.claude/regoc` koje profil traži (iz tablice §13.3) → izlaz 3 ako fali |
| `oporavak` (**novo**, samo provjera) | paket | ne (to su prekidači u `znacajke`) | zajednička provjera: `siroceOporavak`, `zombieRecoveryLive`, `deadAgentReaperLive`, `staleWatchdogLive` ON **i** kod postoji **i** u `daemon.log` u zadnjih 30 min ima redak njihova kruga; `staleReaper` OFF |

#### 13.2.1 Značajke (75 ključeva glavnog) — odluka po stavci

Pravilo zadanog: **u paket** = `enabled` kao na glavnom; **uvjetno** = profil ga drži OFF/sjena
dok uvjet nije ispunjen (alat provjerava uvjet); **van** = OFF i u paketu, s razlogom.

| Skupina | Ključevi | Glavni | node-A danas | Odluka | Razlog / uvjet |
|---|---|---|---|---|---|
| Isporuka korisniku | `userFlush`, `userFlushLive` | ON | ON | **u paket** | jednako |
| | `userFlushBacklog` | off | off | **van** | Goranova potvrda za stare poruke |
| Klasifikacija | `modeClassify` (sjena) | ON | ON | **u paket** | — |
| | `modeClassifyLive`, `tierRouting` | off | off | **van** | čeka golden-set prag na glavnom |
| | `ollamaClassifier` (sjena) | ON | off | **uvjetno** | Ollama dohvatljiva s čvora (`OLLAMA_URL/api/tags` → 200) |
| | `ollamaClassifierLive`, `ollamaProjectDetect` | off | — | **van** | off na glavnom |
| Verifikacija / kritičar | `criticGate(+Live)`, `criticUnverifiedAlert`, `verificationGateShadow`, `criticRepairLoop` (sjena), `spawnVerificationBlock(+Live)`, `agentIdentityBlock(+Live)`, `tierRecipesEnabled` | ON | criticGate ON, ostalo fali | **u paket** | jezgra „DONE samo s dokazom"; bez njih agent na čvoru ne dobiva blok identiteta ni verifikacije |
| | `verificationGate`, `verificationGateLive`, `criticRepairLoopLive` | off | off/— | **van** | off na glavnom (Ollama advisory nije prošla mjerenje) |
| | `zatvaranjeKrozDaemon` (sjena), `pozadinaPovrat`, `r2IzricitaDodjela` | ON | — (nema koda) | **u paket** | traži P5 (kod) |
| | `zatvaranjeKrozDaemonLive`, `ponovnoOtvaranjeRutaLive` | off | — | **van** | off na glavnom |
| | `ponovnoOtvaranjeRuta` (sjena) | ON | — | **u paket** | kao glavni |
| Reaperi i oporavak | `staleWatchdog(+Live)`, `deadAgentReaper(+Live)`, `zombieRecovery(+Live)`, `siroceOporavak`, `revizijaBlokiranih(+Live)`, `failRequeue(+Live)`, `shutdownResume(+Live)`, `staleInboxGuard` | ON | Live svi off; `siroceOporavak`/`revizija` nema koda | **u paket — ali uvjetno do čišćenja** | uključiti **tek kad je kaskada TASK-255 deployana i 46 blokiranih smeće-zadataka zatvoreno**: reaper koji vrati smeće u red ponovno pali kaskadu. `siroceOporavak` i `revizijaBlokiranih` traže P5 |
| | `staleReaper`, `staleReaperLive` | off | **ON**/off | **van — ispraviti na čvoru ODMAH** | TRAJNO ugašeno 02.09. (sudi suprotno od staleWatchdoga) |
| Kočnice | `spawnBreaker(+Live)`, `taskCreateBreaker(+Live)`, `sendBreaker` (sjena), `earlyWorkGuard` (sjena), `spawnCloseGuard` | ON | fale | **u paket** | `taskCreateBreakerLive` je izravna kočnica kaskade (30/h po izvoru) — na čvoru koji je upravo imao kaskadu najvažniji pojedinačni prekidač |
| | `sendBreakerLive`, `earlyWorkGuardLive`, `spawnCloseGuardLive` | off | — | **van** | canary na glavnom |
| Tim i lanac | `teamChain`, `teamPilot`, `taskTier(+Live)`, `taskDecompose(+Live)`, `quotaWakeup`, `autoResume` (sjena) | ON | djelomično | **u paket** | — |
| | `teamChainLive`, `autoResumeLive` | off | **ON** | **van — ugasiti na čvoru** | čvor ne smije biti agresivniji od glavnog; `teamChainLive` je dio puta kaskade TASK-255 |
| | `sequentialHelpers` | ON | — (bez prekidača, uvijek uključeno) | **uvjetno** | ON tek s kodom koji ima anti-kaskadni čuvar TASK-255 (marker u `izvorniSustavSadrzi`) |
| | `projectGitInit` | off | ON | **uvjetno (instanca)** | smije ostati ON na čvoru koji projekte drži u gitu; vrijednost ide u instancu, zadano off |
| Izolacija i spajanje | `worktreeIsolation(+Live)`, `mergeGate(+Live)` | ON | ON | **u paket** | jednako |
| | `fileScopeGate(+Live)`, `reviewCheckpoint(+Live)` | off | off | **van** | off na glavnom |
| Autonomija | `autonomyGate` | ON | off | **uvjetno** | ON samo dok mjerilo potrošnje vraća 200 (uvjet alata: zadnji `[usage]` redak u `daemon.log` bez 401 u 30 min); inače sjena. Na slijepom mjerilu vrata stoje na zadnjoj razini |

#### 13.2.2 Kuke (32 na glavnom) — odluka po stavci

| Događaj : kuka | Odluka | Razlog |
|---|---|---|
| PreToolUse + UserPromptSubmit : `SecurityValidator` | **u paket** (već u profilu) | sigurnost; izvorni-sustav, sha256 provjera |
| SessionStart + PostToolUse : `TaskInstructionsInject` | **u paket — `${TM_HOME}/hooks/`** | paket ga već ima (TASK-5013); daemon na čvoru već predaje `REGOC_TASK_ID` (3 mjesta u `RegocDaemon.ts` čvora) → spajanje odmah dostavlja upute. Ovo je kvar TASK-212 |
| PostToolUse : `RegocConsoleLog` | **u paket — prenijeti u `${TM_HOME}/hooks/`** | izvor `regoc` konzole ploče; danas na čvoru prazan |
| UserPromptSubmit + Stop : `session_usage.py --hook` | **u paket — `${TM_HOME}/tools/session_usage.py`** (već u paketu) | hrani mjerilo potrošnje → vrata autonomije |
| PreToolUse : `RadBezZadatka` | **uvjetno** | radi samo uz `REGOC_SESIJA=telegram`; ulazi kad razgovorni modul paketa postavlja tu varijablu; datoteka prenijeti u paket (danas tvrda putanja `/home/klaudio`) |
| PreToolUse Task + SubagentStop : `AgentMemoryRead/Write` | **uvjetno (modul `rag`)** | RAG je na čvoru isključen; uključuje se zajedno s `TM_CHROMA_*` |
| SessionStart : `LoadContext` | **uvjetno** | samo ako je komplet `skills/CORE` na čvoru; upravitelj čvora identitet dobiva iz `~/CLAUDE.md` (`TM_RAZGOVOR_UPUTE`) |
| Stop/Notification/SubagentStop/UPS : `ContextCapture`×2, `ContextExport`, `SessionSummary`, `WorkCompletionLearning`, `ImplicitSentimentCapture`, `ExplicitRatingCapture`, `AgentOutputCapture` | **uvjetno — paket „pai-ucenje"** | pišu u `~/.claude/MEMORY`, na čvoru nemaju potrošača; datoteke postoje na node-A, pa ih **instanca node-A uključuje** (Goran: „kao na glavnom"), zadano za novi čvor off |
| SessionStart : `EnsureRegocDaemon` | **van** | na čvoru daemon drži systemd (`regoc-daemon.service`); kuka bi dizala drugi |
| SessionStart : `StartupGreeting`, `CheckVersion`; UPS : `UpdateTabTitle`, `SetQuestionTab` | **van** | terminal/PAI kozmetika; čvor nema interaktivni terminal |
| UPS : `CheckTelegramRelay`, `CheckVoiceRelay`, `CheckRegocQueue`, `LoadDomainContext`, `AutoWorkCreation` | **van** | releji interaktivne REGOČ sesije glavnog stroja; na čvoru Telegram ide razgovornim modulom (ADR-0002) |
| Stop : `FormatEnforcer`, `QuestionAnswered` | **van** | format PAI odgovora sukobio bi se sa stilom `kratko` (ADR-0002) |
| PreToolUse Write : `KatalogCuvar` | **van** | katalog alata je glavnog stroja |

Zbroj: **u paket 7 kuka** (SecurityValidator ×2, TaskInstructionsInject ×2, RegocConsoleLog, session_usage ×2), **uvjetno 12**, **van 13**. Na node-A
(s paketom „pai-ucenje") to je **15 spojenih kuka** umjesto 2.

#### 13.2.3 Konzola i `daemon.log`

| Izvor ploče | Danas na čvoru | Odluka |
|---|---|---|
| `daemon` (`~/.tmp/regoc_daemon.log` → `daemon.log`) | svjež | u paket (jednako) |
| `regoc` (`regoc_logs/regoc.log`) | nema | u paket — kuka `RegocConsoleLog` |
| `voiceserver` | nema (journal) | u paket kad je modul `glas` ON — drop-in `StandardOutput=append:` |
| `taskwebui` | nema (journal) | u paket — drop-in na `regoc-taskmanager` |
| `klaudio` | star 27 d | **van na čvoru** — Klaudio (bot glavnog stroja) ne radi na čvoru; razgovorni modul piše u `daemon`/`taskwebui`. Ploča treba izvor bez datoteke prikazati kao „nije u pogonu", ne kao tišinu |

### 13.3 `izvorniSustavSadrzi` (preduvjet koda za `znacajke`)

`OrphanRecovery.ts`, `PozadinaPovrat.ts`, `ZatvaranjeKrozDaemon.ts`, `TaskInstructions.ts`,
`TaskCloser.ts`, `Sudac.ts`, `AutonomyThresholdSetting.ts`, `DaemonSingleton.ts`,
`SpawnFinalizer.ts`, `SpawnSlotRules.ts`, `TaskDorada.ts`, `RadBezZadatka.ts` + marker
anti-kaskade TASK-255 u `AgentRouting.ts`. Puni popis 28 modula: `mjerenje_2026-10-07.txt`.

### 13.4 Novi preduvjet

| # | Preduvjet | Zašto | Tko |
|---|---|---|---|
| P5 | Komplet izvornog sustava na čvoru = isti graf kao glavni (`deploy_node_a.sh` s `MANIFEST.sha256`, ponovno izmjeren), uključivo popravak TASK-255 | 8 prekidača i 28 modula nemaju koda; paljenje bez koda je lažni paritet | Jelena (komplet) + Malik (pregled) |
| P6 | Na node-A u `~/TaskManagerAI` 5 izmijenjenih, nepredanih datoteka (`src/razgovor/*`, `tests/razgovor-dijelovi.test.ts`) preuzeti ili odbaciti | isti kvar kao P2: `checkout -f` bi ih brisao | Goran odlučuje |

### 13.5 Novi čvor u 5 koraka + tajne (zamjenjuje §6)

```
0. TAJNE  (čovjek, PROFIL_CVORA_TAJNE.md): bot token, tajna kanala, `claude auth login`, capguard odobrenja
1. KOD    tm-cvor-azuriraj.sh <čvor> --s-kompletom      # paket + komplet izvornog sustava po MANIFEST-u (P1, P5)
2. INSTANCA  cp profili/<profil>/instanca.primjer.env $TM_HOME/config/profil.instanca.env  &&  uredi
3. PRIMIJENI bun scripts/profil-cvora.ts primijeni --suho  →  pregled  →  --pisi        # okolina…kuke, znacajke, konzola
4. RESTART   restart_kad_mirno (čvor: in_progress = 0) — samo ako je alat javio „potreban restart: da"
5. PROVJERI  bun scripts/profil-cvora.ts provjeri  → izlaz 0 (ili 2 = samo ljudske stavke)
            + python3 docs/qa/TASK-5307/paritet.py <čvor> → razlike samo one s odlukom „van/uvjetno"
```

Koraci 3 i 5 nose sve tri nove osi (kuke, značajke, konzola), pa paritet više nije zaseban
posao nego dio istog `primijeni`/`provjeri`.

### 13.6 Mjerila (dodatak §10)

| # | Mjerilo |
|---|---|
| J13 | modul `znacajke`: `primijeni --pisi` mijenja samo `enabled` imenovanih ključeva; `note`/`since` i nepoznati ključevi bajt-jednaki; drugi `--pisi` → 0 promjena |
| J14 | ključ ON u profilu, a čvor nema modul iz `izvorniSustavSadrzi` → `provjeri` izlaz 3 s imenom modula |
| J15 | modul `kuke`: nijedna spojena naredba ne sadrži `/home/klaudio`; tuđe kuke ostaju; kuka bez datoteke → `NEDOSTAJE` |
| J16 | `staleReaper` ON na čvoru → `provjeri` javlja `RAZLIKA` (profil off) čak i kad je `staleReaperLive` off |
| J17 | modul `konzola`: drop-in postoji, svi izvori iz `logSources` svježi < 24 h; `klaudio` na čvoru bez Klaudija = `PRESKOČENO` |
| P5 | Potjeh: na node-A nakon koraka 1–5 `paritet.py` → razlike = samo stavke „van/uvjetno" iz §13.2 (nijedna „u paket") |
| P6 | Potjeh: E2E uputa — zadatak na čvoru, `POST /api/tasks/<id>/upute` dok agent radi → agent je potvrdi u sljedećem koraku |
| P7 | Potjeh: siroče — ubijen proces agenta → zadatak se vrati u red (`siroceOporavak`) u ≤ 15 min, bez ručnog `/reclaim` |
