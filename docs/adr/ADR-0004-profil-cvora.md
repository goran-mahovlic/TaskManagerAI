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
