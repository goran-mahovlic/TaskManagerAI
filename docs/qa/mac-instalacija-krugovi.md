# Mac — krugovi instalacije s GitHuba (K8 / K8a)

Petlja popravka iz plana Mac v3 (§4 K8a, P3.3). Svaki krug kreće od nule: `deinstaliraj.sh --do-nule`
i `rm -rf ~/TaskManagerAI`, zatim `provjeri-cisto.sh` = 0. Nakon toga se izvode **doslovno** naredbe
iz README-a („Install on a new machine"). Ništa se ne krpa na Macu. Svaki pad dobiva popravak u
paketu i test koji ga hvata, a na GitHub ga pusha samo vlasnik repozitorija. Kočnica: ako 5 krugova zaredom padne na istom
koraku, petlja staje i javlja se vlasniku.

Čvor: Mac (macOS 27.0.1, arm64, Command Line Tools, Homebrew drugog korisnika bez `openssl@3`).
Instalaciju izvodi korisnik usluge `regoc` preko SSH-a. Log se čita ovako:
`cat ~/.taskmanager/log/install/zadnji/install-rezultat.json` i
`grep -v '"izlaz":0' ~/.taskmanager/log/install/zadnji/koraci.jsonl`.

| Krug | Datum | Commit (GitHub) | Naredba | Ishod | Korak koji je pao | Izlaz | Trajanje | Popravak (commit) |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-21 19:58 | `894bddd` | README korak 2, bez `--komplet` (README ga ne navodi; `config/komplet.lock` na GitHubu ne postoji) | pad | `K2.18-baze-pgvector` | 6 | 35,6 s | grana `zadatak/TASK-5662` (vidi niže) |
| 2 | 2026-10-22 02:59 | `1172fa2` | README korak 2, bez `--komplet` (isti razlog) | **uspjeh** | — | 0 | 76,0 s | — |
| 3 | 2026-10-22 17:04 | `a5e4257` | README korak 2, **s `--komplet`** (D3 = B, komplet je `regoc-system/`) | instalacija **uspjeh**, daemon u pogonu **pad** | — (`hr.regoc.daemon`: glavna petlja) | 0 | 109,9 s | `~/.claude/regoc` `b1434df` + grana `zadatak/TASK-5662` (vidi niže) |
| 4 | 2026-10-22 20:50 | `c8e9b5d` | README korak 2, s `--komplet` | **uspjeh**; daemon u pogonu radi (0× `no such table`) | — (čišćenje prije kruga: `D10-provjera` izlaz 8; u pogonu: `./tools/decompose`, CPU daemona u mirovanju ≈ 8 %) | 0 | 149,3 s | grana `zadatak/TASK-5662` `428e8cb` + `~/.claude/regoc` `4d57427` (vidi niže) |

## Krug 1 — 2026-10-21

**Prije:** Mac je čist (`~/TaskManagerAI`, `~/.taskmanager` i plistovi `hr.regoc.*` ne postoje).
`origin/main` = `894bddd`.

**Izvedeno:** `git clone https://github.com/goran-mahovlic/TaskManagerAI.git ~/TaskManagerAI` →
`bash scripts/install.sh --cvor <ime-čvora> --profil upravitelj-cvora --baze`. README-ov
`sudo -v` je zamijenjen sa `sudo -n true`, jer `regoc` ima NOPASSWD, a `sudo -v` bez terminala
ipak traži lozinku (zbog unosa `(ALL) ALL` iz grupe admin). Isto provjerava i sam install.sh.
`xcode-select --install` nije pokrenut jer su Command Line Tools već instalirani.

**Pad:** `K2.18-baze-pgvector`, izlaz 6, `install-rezultat.json` → `"ishod":"pad"`.
Koraci K2.1–K2.17 imaju izlaz 0. `git status --porcelain` na Macu je prazan.

```
Error: PostgreSQL error: … dyld: Library not loaded: /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib
  Referenced from: …/.taskmanager/rag/home/.pg0/installation/18.1.0/lib/libpq.5.dylib
GREŠKA: pg0 start nije uspio (…/.taskmanager/rag/pg0-start.log)
```

**Uzrok (izmjereno `otool -L`):** pg0 0.15.2 (najnovija verzija na PyPI-ju) raspakira PostgreSQL 18.1
čiji su `bin/postgres` i `lib/libpq.5.dylib` vezani uz Homebrewov `openssl@3`. Pogođeno je 10 Mach-O
datoteka. Na Macu Homebrew nije obavezan, a i kad postoji, ne pripada nužno korisniku.
`DYLD_FALLBACK_LIBRARY_PATH` ne pomaže: `postgres --version` s njim radi, ali initdb poziva
`postgres -V` kroz `/bin/sh`, a SIP tom procesu briše DYLD_* varijable. Izmjereno: „program postgres
is needed by initdb but was not found".

**Popravak 1 (pad):** `scripts/macos/pg0-openssl.sh` čini instalaciju pg0 samostalnom:
- `libssl.3.dylib` i `libcrypto.3.dylib` (OpenSSL 3.5.8) dolaze iz javnog wheela `psycopg-binary 3.3.6`
  s PyPI-ja, s pinanim sha256 (arm64 i x86_64), i idu u `installation/<v>/lib`;
- reference `…/opt/openssl@3/lib/…` prepisuju se na `@loader_path` (`install_name_tool`), a zatim
  slijedi ad-hoc potpis (`codesign -s -`).

`install.sh` u pgvector koraku na macOS-u radi tri stvari prije pravog starta: binarke raspakira
jednokratnim `pg0 start`, poziva `pg0 drop -f` i pokreće popravak. Hindsight na macOS-u dijeli tu
instalaciju preko veze `hindsight/home/.pg0/installation`, jer bi njegov vlastiti pg0 HOME raspakirao
pokvarenu.
Pokus na Macu u `/tmp` (instalacija nije dirana, pokus je obrisan) dao je: 10 datoteka popravljeno →
`pg0 start` OK → `CREATE EXTENSION vector` → 0.8.5 → `pg0 stop`.
Test: `tests/pg0-openssl-macos.test.ts` (5) i lažni darwin u `tests/install-sh.test.ts`.

**Popravak 2 (upozorenje, ne pad):** `K2.7-pdf` je javio „naredba pdf nije spremna". Uzrok je
`python3 -m pip --python …`: pip iz Command Line Tools Pythona 3.9 (pip 21.2) tu zastavicu nema
(„no such option: --python"). Novi `scripts/instalacija/pip-u-venv.sh` prvo koristi pip samog venva
(`ensurepip`, bez `-q`, koji ensurepip ne prima). Pip sustava s `--python` ostaje rezerva za Debian.
Na Macu (`/tmp`) to daje reportlab 4.4.4 i pypdf 6.1.1. Test: `tests/pip-u-venv.test.ts` (3).

**Čišćenje nakon kruga 1 (L4) — popravak 3:** `deinstaliraj.sh --do-nule` je završio s izlazom 0, ali
s korakom `D10-provjera` izlaz 8 (`provjeri-cisto`: 3 ostatka). Na Macu su ostale stvari koje je
napravila instalacija, a manifest `instalirano.json` ih nije poznavao:
- `~/.config/uv/uv-receipt.json`, koji piše službeni instalator uv-a,
- veza `~/.local/bin/python3.13` (stvara je `uv python install`; nakon brisanja Pythona visi),
- `~/Library/Fonts/DejaVu*.ttf` (5 fontova iz `instaliraj-pdf.sh`); `provjeri-cisto` ih nije vidio,
- `~/Library/Caches/bun` (nastao u 19:58:50; bun na macOS-u predmemoriju drži izvan `~/.bun`).

`~/Library/Caches/com.apple.python` je nastao 20.10., prije instalacije, i ostaje.

Popravci:
- `install.sh`: `ALATNE_MAPE` (opći mehanizam iz B3: upisuje se samo ono čega prije nije bilo) dobiva
  `~/.config/uv`, `~/.local/bin/python3.13`, `~/Library/Caches/bun` i `~/Library/Caches/pip`, uz
  ispravnu obradu veza;
- `instaliraj-pdf.sh` kroz `TM_PDF_STVORENO` javlja fontove i mapu koje je sam stvorio;
- `pip_u_venv` dobiva `--no-cache-dir`.

Testovi: lažni uv u `tests/deinstalacija-do-nule.test.ts` sada radi isto što i pravi (HOME = snimka
prije). Novi test „fontovi naredbe pdf" (lažni darwin) prolazi cijeli put install → `--do-nule` →
`provjeri-cisto` = 0. Na Macu su ostaci kruga 1 maknuti tek u čišćenju prije kruga 2.

**Otvoreno za K8 (nije pad instalacije):** D2 = B traži `--komplet`, a `config/komplet.lock` ni javni
modul `regoc-komplet` (K3a, odluka D3) na GitHubu ne postoje, pa `install.sh --komplet` staje s
izlazom 5. README ga zato ne navodi. Usluga `daemon` (RegocDaemon) na Macu za sada ne postoji.

**Sljedeće:** vlasnik pusha granu → `deinstaliraj.sh --do-nule` + `rm -rf ~/TaskManagerAI` →
`provjeri-cisto.sh` = 0 → krug 2.

## Krug 2 — 2026-10-22

**Prije:** vlasnik je pushao granu (TASK-5697), `origin/main` = `1172fa2` (`git ls-remote` na Macu).
`provjeri-cisto.sh` (pokrenut sa stroja REGOČ-a kroz `ssh … 'bash -s' <`) → „čisto (0 ostataka)", izlaz 0.
Na Macu su ostali samo `~/.taskmanager-log-arhiva/` i `~/taskmanager-backup-20261021-201848.tgz`, a njih
provjera namjerno ne broji.

**Izvedeno:** isto kao u krugu 1: `git clone …` → `bash scripts/install.sh --cvor <čvor> --profil upravitelj-cvora --baze`
(`sudo -n true` umjesto `sudo -v`).

**Ishod:** `install-rezultat.json` → `"ishod":"uspjeh"`, `"izlaz":0`, 28 koraka (promijenjeno 18,
preskočeno 10), 76,0 s, `paket_commit` = `1172fa2`. Nijedan korak u `koraci.jsonl` nema izlaz ≠ 0.
`K2.18-baze-pgvector` (pad kruga 1) je prošao za 3,5 s, a `K2.7-pdf` više ne upozorava.
Jedino upozorenje je `K2.3-preduvjeti`: `regoc` ima neograničen sudo (vidi K9/Malik, `sudoers.primjer`).

**Provjere K8 (sve na Macu ili preko tailneta):**

| Kriterij | Izmjereno |
|---|---|
| ishod instalacije | `uspjeh`, 0 koraka s izlazom ≠ 0, iz prvog pokušaja nakon čišćenja |
| `launchctl print system/hr.regoc.taskmanager` | `state = running`; `pgvector` i `hindsight` su učitani i ugašeni (instaliraju se ugašeni, troše 0 RAM-a) |
| HTTP preko tailneta | `http://<tailnet-IP>:17781/health` → 200; tuđi `Host` → 403 |
| vrata s LAN-a | ploča sluša samo na `127.0.0.1` i `<tailnet-IP>` (`lsof`); `curl <LAN-IP>:{17781,15432,15433,17792,17796,17797}` → odbijeno (rc 7) |
| bootcheck | `VERDIKT: PASS` (M1–M4, M6 PASS; upozorenja M5 bez AI prijave, M7 memorija `nasa` bez tunela, M8 sudo) |
| `git -C ~/TaskManagerAI status --porcelain` | prazno |
| preživi restart | `launchctl bootout` + `bootstrap` → 200; zatim pravi restart Maca (`shutdown -r`, boottime 20.10. 14:54 → 22.10. 03:04:53): 25 s nakon podizanja `state = running` (PID 426), tailnet 200, tuđi Host 403, bootcheck `vrsta=POST-BOOT` PASS, `git status` prazan, vrata s LAN-a odbijena |

U mirovanju na Macu radi samo ploča: jedan `bun`, RSS oko 64 MB, CPU ≈ 0.

**Napomena o restartu:** sesija vlasnice stroja na konzoli je prije restarta mirovala 29,6 h, a od programa je
bio otvoren samo Chrome. Restart ju je odjavio (`who` = 0 korisnika).

**Otvoreno, nije pad instalacije:**
1. **D2 = B (komplet):** plan v3 K8 traži `--komplet` i `hr.regoc.daemon` u stanju `state = running`.
   `config/komplet.lock` i javni modul `regoc-komplet` (K3a) još ne postoje, a odluka D3 (zaseban
   repozitorij ili mapa u paketu) nije donesena. Zato README `--komplet` ne navodi, a `K2.14-komplet`
   javlja „nije traženo". Kad K3a bude objavljen, isti krug se ponavlja s `--komplet`.
2. **Ime MagicDNS:** ime MagicDNS čvora (port 17781) daje 403, jer instalacija u
   `TM_ALLOWED_HOSTS` upisuje samo tailnet IP. README kaže da ostala imena dodaje vlasnik čvora
   (lokalno, `postavke.env`). Moguće poboljšanje: `install.sh` uzima i `Self.DNSName` iz `tailscale status --json`.

**Sljedeće:** K3a + D3 → krug 3 s `--komplet`. Za paket bez kompleta K8 je prošao čisto.

## Krug 3 — 2026-10-22 (s `--komplet`)

**Prije:** vlasnik je pushao komplet (`origin/main` = `a5e4257`, TASK-5705/5706, uputa #446).
`deinstaliraj.sh --do-nule --da --bez-kopije` → izlaz 0, `D10-provjera` „čisto (0 ostataka)";
`rm -rf ~/TaskManagerAI`; `provjeri-cisto.sh` (sa stroja REGOČ-a kroz `ssh … 'bash -s' <`) → 0.

**Izvedeno:** `git clone …` → `bash scripts/install.sh --cvor <čvor> --profil upravitelj-cvora --baze --komplet`.

**Ishod instalacije:** `install-rezultat.json` → `"ishod":"uspjeh"`, `"izlaz":0`, 30 koraka (promijenjeno 22,
preskočeno 8), 109,9 s, `paket_commit` = `a5e4257`. `K2.14-komplet` je prošao za 4,2 s (provjera
`regoc-system/MANIFEST.sha256` → kopija u `~/.claude/regoc`). Jedino upozorenje je opet `K2.3-preduvjeti` (sudo).

**Provjere K8:**

| Kriterij | Izmjereno |
|---|---|
| ishod instalacije | `uspjeh`, 0 koraka s izlazom ≠ 0, iz prvog pokušaja nakon čišćenja |
| `launchctl print system/hr.regoc.taskmanager` | `state = running` |
| `launchctl print system/hr.regoc.daemon` | `state = running` (RunAtLoad, KeepAlive kod pada: `kill -9` → novi PID za < 15 s, `runs = 2`) |
| HTTP preko tailneta | `<tailnet-IP>` → 200; ime MagicDNS → 200 (nakon lokalnog dopisivanja imena u `postavke.env`, uputa #444); tuđi `Host` → 403 |
| vrata s LAN-a | ploča sluša samo na `127.0.0.1` i `<tailnet-IP>`; `curl <LAN-IP>:{17781,15432,15433,17792,17796,17797}` → rc 7 |
| bootcheck | `VERDIKT: PASS` (upozorenja M5 bez AI prijave, M7 memorija, M8 sudo, M9 tajne kompleta — očekivano, upisuje ih vlasnik čvora, K9) |
| `git status --porcelain` | prazno |
| preživi restart | `launchctl bootout` + `bootstrap` obje usluge → `state = running`, 200. Pravi restart Maca **nije** napravljen: vlasnica stroja je bila prijavljena na konzoli (otvoren preglednik), a restart je odjavljuje (krug 2) |
| mirovanje | ploča RSS ≈ 63 MB, daemon ≈ 57–76 MB, CPU 0,0 % |

**Pad (pogon daemona, ne instalacije):** u `~/.taskmanager/log/daemon.log` glavna petlja svake sekunde:

```
Error in main loop: SQLiteError: no such table: messages
⚠️ [autonomija] postavka pragova nečitljiva (SQLiteError: unable to open database file)
```

**Uzroci (izmjereno):**
1. `RegocDaemon` otvara `~/.claude/regoc/messages.db` izravno (`getDb`) i ne pokreće shemu. Tablice
   stvara `MessageQueue` iz `schema.sql`, a ni nje nema: izvoz kompleta prati samo graf uvoza `.ts`,
   a `initSchema()` bez datoteke tiho preskače. Na stroju REGOČ-a baza je stara, pa se to nije vidjelo.
2. Komplet ploču čita iz `~/.claude/regoc/data/regoc.db` (TaskManagerSQL, pragovi autonomije, strop),
   a paket je drži u `$TM_HOME/data/tasks.db`. Na čvorovima Linuxa paket i daemon dijele istu bazu.

Ista slika ponovljena je lokalno: komplet iz `a5e4257` u privremenom HOME-u, baza iz `init-db`,
daemon 25 s → 25× `no such table: messages`.

**Popravak:**
- izvoz (`gradi_komplet.sh`): `PODACI=(schema.sql)`, datoteke koje kod čita u pogonu, a nisu u grafu uvoza;
- `regoc-system/instalacija.sh`: korak 5, uz `--tm-home` veza `data/regoc.db → $TM_HOME/data/tasks.db`
  (postojeća baza kompleta se ne dira); korak 6, `schema.sql` → `messages.db` ako nema tablice `messages`.
  Oba koraka su idempotentna (drugo pokretanje: `ISTO`).
- test `regoc-system/tests/pogon.test.ts` (5): na `a5e4257` crveno (4/4, pa 1/1 za korak 6), nakon
  popravka zeleno; testovi kompleta 33 pass, 0 fail; brane izvoza 0 pogodaka.
- ista lokalna proba nakon popravka: 0× `no such table: messages`, 0× `unable to open database`,
  0× `Error in main loop`. Ostaje jedno upozorenje pri prvom pokretanju, `[staleWatchdog] no such
  table: agent_checkpoints` (tablicu stvara `AgentDaemon` kad prvi put radi), i to nije petlja.

Do kruga 4 je `hr.regoc.daemon` na Macu ugašen (`launchctl bootout`), da dnevnik ne raste retkom u sekundi.

**Otvoreno, nije pad instalacije (K9):**
1. **Registar agenata:** daemon javlja „Agent registry not loaded" jer `REGOC_AGENTS.json` (tim i
   uloge) namjerno nije u javnom kompletu. Koje agente čvor ima lokalne su postavke čvora.
2. **`GEMINI.md`** (pravila sustava za daemon) se traži u `~/app/regoc_system/`, kojeg na čvoru nema.
   Daemon radi i bez toga, uz upozorenje.

**Sljedeće:** vlasnik pusha granu `zadatak/TASK-5662` → `deinstaliraj.sh --do-nule` + `rm -rf ~/TaskManagerAI`
→ `provjeri-cisto.sh` = 0 → krug 4 s `--komplet`, zatim pravi restart Maca u dogovoru s vlasnicom stroja.

## Krug 4 — 2026-10-22 (s `--komplet`, `c8e9b5d`)

**Prije:** vlasnik je pushao `c8e9b5d` (TASK-5718), `git ls-remote` na Macu → `refs/heads/main` = `c8e9b5d`.
Na konzoli je bila prijavljena vlasnica stroja.

**Čišćenje (pad, nije instalacija):** `deinstaliraj.sh --do-nule --da --bez-kopije` (iz klona kruga 3) → izlaz 8,
`D10-provjera` „1 ostatak": `~/.cache` nije prazna (`~/.cache/claude/staging`, prazna mapa Claude instalatora),
a `~/.tmp` (`regoc_daemon.log`, `regoc_status.json`, `regoc_mode.json` daemona kompleta) provjera nije ni
vidjela. Ni jedno nije bilo u manifestu: `~/.cache/claude` nije bila na popisu `ALATNE_MAPE`, a `~/.tmp`
stvara tek daemon kompleta.
Popravak `428e8cb`: `ALATNE_MAPE` += `~/.cache/claude`, `~/.tmp`; `k_komplet` stvara `~/.tmp` prije upisa
manifesta. `~/.tmp` koja je postojala prije instalacije ostaje vlasniku. Test `install-sh` „--komplet → daemon
piše u ~/.tmp → --do-nule → provjeri-cisto = 0" je crven na `c8e9b5d`, a s popravkom zelen.
Ostatke kruga 3 (stara inačica ih nije upisala u manifest) uklonila sam ručno: 3 datoteke u `~/.tmp`, prazne
mape `~/.cache/claude/staging`, `~/.cache/claude` i `~/.cache`. Zatim `rm -rf ~/TaskManagerAI` i
`provjeri-cisto.sh` → „čisto (0 ostataka)", izlaz 0.

**Izvedeno:** `git clone …` → `bash scripts/install.sh --cvor <čvor> --profil upravitelj-cvora --baze --komplet`
(`sudo -n true` umjesto `sudo -v`).

**Ishod instalacije:** `install-rezultat.json` → `"ishod":"uspjeh"`, `"izlaz":0`, 30 koraka (promijenjeno 22,
preskočeno 8), 149,3 s, `paket_commit` = `c8e9b5d`. Jedino upozorenje je `K2.3-preduvjeti` (sudo).

**Provjere K8:**

| Kriterij | Izmjereno |
|---|---|
| ishod instalacije | `uspjeh`, 0 koraka s izlazom ≠ 0, iz prvog pokušaja nakon čišćenja |
| `launchctl print system/hr.regoc.{taskmanager,daemon}` | oba `state = running`; `pgvector`, `hindsight`, `znanje` učitani i ugašeni |
| pogon daemona (popravak kruga 3) | `daemon.log`: 0× `no such table: messages`, 0× `unable to open database`, 0× `Error in main loop`; `messages.db` ima tablicu `messages`; `data/regoc.db → $TM_HOME/data/tasks.db`; „Vrata autonomije: sesija 70/85/95 %, tjedan 90 %" (postavka pročitana) |
| HTTP preko tailneta | `<tailnet-IP>` → 200; ime MagicDNS → 403 dok ga vlasnik ne upiše, pa 200 nakon lokalnog dopisivanja u `postavke.env` (uputa #448, isto kao u krugu 3); tuđi `Host` → 403 |
| vrata s LAN-a | ploča sluša samo na `127.0.0.1` i `<tailnet-IP>`; `curl <LAN-IP>:{17781,15432,15433,17792,17796,17797}` → rc 7 |
| bootcheck | `VERDIKT: PASS (upozorenja: M5, M7, M8, M9)`, ista očekivana upozorenja kao u krugu 3 (K9) |
| `git status --porcelain` | prazno |
| preživi restart | `launchctl bootout` + `bootstrap` obje usluge → `state = running` (novi PID-ovi), tailnet 200, MagicDNS 200, tuđi Host 403. Pravi restart Maca **nije** napravljen: vlasnica stroja je bila prijavljena na konzoli (uputa #448) |

**Nalazi u pogonu (nisu pad instalacije, popravljeni za krug 5):**
1. **`./tools/decompose`:** `[razlaganje] pump pao: Cannot find module './tools/decompose'` svake minute.
   Na stroju REGOČ-a `tools/decompose.ts` je poveznica na `orkestracija/decompose.ts`. Izvoz je uzimao samo
   cilj iz metafilea, pa `bun build` prolazi (bun nerazriješen dinamički `import()` označi kao `external`, ne kao
   grešku), a u pogonu modula nema. Popravak u izvozu (`gradi_komplet.sh`, `~/.claude/regoc` `4d57427`):
   poveznice kroz koje kod uvozi (polje `original` u metafileu) ulaze u komplet same, bez ručnog popisa.
   Test kompleta `pogon.test.ts` („every relative import reachable from ULAZI.txt names an existing file")
   je crven na kompletu iz `c8e9b5d` (`RegocDaemon.ts → ./tools/decompose`), a zelen na novom kompletu (34 pass, 0 fail).
2. **CPU u mirovanju:** daemon je trošio 9,1 s CPU-a u 120 s (≈ 7,6 %). `sample` pokazuje `__posix_spawn`, a
   u stablu procesa vidi se `ps -o command= -p <pid>` za svaki PID na stroju. Uzrok je watchdog Klaudija:
   kad nema pid-datoteke, svake minute provjerava naredbu svakog procesa. Na Linuxu je to čitanje `/proc`,
   na macOS-u jedan `ps` po procesu (≈ 400). Klaudija na čvoru nema (`telegram_agent.ts` nije u kompletu), pa je
   watchdog uz to svaki put restartao modul koji ne postoji. Popravak (`~/.claude/regoc` `4d57427`): watchdog
   miruje kad `telegram_agent.ts` nije instaliran; sken procesa ide jednim pozivom (`platforma.procesi()`,
   na macOS-u jedan `ps -A`). Testovi `klaudio-liveness` (2 nova, crveno → zeleno).
3. **Otvoreno (K9 / komplet):** `[odlucitelj] alat tools/odlucitelj.py nije pronađen` (Python alati daemona nisu
   dio kompleta), `REGOC_AGENTS.json` i `GEMINI.md` kao u krugu 3. Ne ruše petlju, a postavke su čvora.

Do kruga 5 je `hr.regoc.daemon` na Macu ugašen (`launchctl bootout`), da ne troši CPU dok vlasnica radi.

**Sljedeće:** vlasnik pusha granu `zadatak/TASK-5662` → `deinstaliraj.sh --do-nule` + `rm -rf ~/TaskManagerAI`
→ `provjeri-cisto.sh` = 0 → krug 5 s `--komplet` (provjera: 0× `tools/decompose`, CPU daemona u mirovanju),
pravi restart Maca kad vlasnica stroja nije prijavljena.
