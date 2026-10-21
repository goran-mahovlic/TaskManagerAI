# TASK-5660 — Mac K6: QA svježe instalacije po README-u (Debian) i regresija node-A (21.10.2026.)

> Kandidat za K7 push: `main` **306c442** (spoj K4a + K5 dorada). GitHub je u trenutku
> mjerenja na 26b79a4, pa je klon uzet iz git bundlea kandidata, a `origin` je zatim
> postavljen na GitHub adresu iz README-a. Sve ostalo je **doslovno README „Install on a
> new machine"** (EN), bez pitanja.
> Popravci nalaza: **TASK-5693** (Jelena). Agent ne pusha.

## 1. Okolina i odstupanja od README-a

| Što | Kako | Zašto |
|---|---|---|
| „Debian VM" | Debian 13 (trixie) x86_64, **prazan `HOME`**, `env -i` (nijedna `TM_*` varijabla) | Stroj za QA je kontejner bez Docker daemona i bez korisničkih namespacea (`unshare -r` → `Operation not permitted`). node-A ima 4,8 GB slobodno, a README za `--baze` traži 8 GB. |
| §1 preduvjeti | `dpkg -l`: git, curl, unzip, ca-certificates, python3, python3-venv — svi `ii` | nema roota (`sudo apt-get` nije potreban) |
| systemd usluga | nema korisničke sesije systemd-a → K2.23 pada (vidi R1) | kontejner, ne paket |
| vrata | `TM_PORT=27781` u lokalnom `postavke.env` (kako sama datoteka nalaže: „odkomentiraj") | na istom stroju 17781 drži živa ploča izvornog sustava |

## 2. Krugovi

| Krug | Naredba (README §2) | Ishod |
|---|---|---|
| **R1** | `install.sh --cvor qa-debian --profil upravitelj-cvora --baze` | K2.1–K2.21 ✓ (bun, ovisnosti, pdf, baza, uv, venv pg0 0.15.2 + hindsight-api 0.10.2, pgvector 0.8.5, bge-m3 + reranker), **K2.23 izlaz 7** — „nema systemd korisničke sesije (pokreni s --bez-servisa ili uključi lingering)". Poruka i izlazni kod su točno kako README §3 kaže. |
| R1b | ista naredba + `--bez-servisa` (README: „fix the cause and run the same command again") | **izlaz 0**, `install-rezultat.json` → `"ishod":"uspjeh"`, `paket_commit` 306c442, K2.24 `/health → 200 (privremeni proces)`, ponavljanje ne mijenja ništa (24 preskočeno). |
| R1 §6 | `deinstaliraj.sh --do-nule` | izlaz 0, `provjeri-cisto` „0 ostataka" — **ali u HOME ostaje 6,5 GB** (B3) |
| R2 | novi prazan HOME, **bez buna na PATH-u**, bez `--baze` | K2.4 sam skine bun 1.4.3 ✓; K2.23 izlaz 7 (kao R1); R2b `--bez-servisa` izlaz 0; `--do-nule` ostavi `~/.bun` 137 MB i `~/.local` 35 MB, `provjeri-cisto` izlaz 0 (B3 ponovljen) |
| **R3** | novi prazan HOME, bez buna, `--bez-servisa` od prvog pokretanja | izlaz 0, manifest 10 stavki; §3–§5 vidi niže; `--do-nule` **izlaz 8** (ostatak `~/.cache`, B7) |

### README §3–§5 na R3

| Korak | Rezultat |
|---|---|
| §3 `install-rezultat.json` | `uspjeh`, izlaz 0 |
| §3 `curl /health` | 200 (ploča dignuta s okolinom čvora) |
| §3 `bootcheck.sh` | M3 PASS, M6 PASS, M7 PASS, M8 PASS; M1/M2/M4 FAIL — nema usluge (kontejner); M5 UPOZORENJE dok se ne odabere AI servis (README to najavljuje) |
| §4 `prijava-ai.ts popis` | izlaz 0, 14 servisa, „prijavljeno 0 — to je tvoj izbor (instalacija ga ne pretpostavlja)" ✓ odluka 6 |
| §5 `profil.instanca.env` | samo izmišljeni primjeri (`100000001`, `-1000000000000`, `banka_cvor_b`) — nijedna naša vrijednost ✓ |
| §5 `tajna.ts postavi` / `popis` | izlaz 0, ali tajna završi u mapi paketa i usluga je ne vidi (B4) |

## 3. Nalazi

| # | Težina | Nalaz | Dokaz |
|---|---|---|---|
| **B1** | **kritično** | `scripts/start.sh` ubija **bilo koji** proces na vratima (`kill`, pa `kill -9`) i ne provjerava je li to ploča iz ovog paketa. `install.sh` (K2.24) i `deinstaliraj.sh` (D2) tu provjeru imaju. | Probna instalacija na istom stroju ugasila je živu ploču izvornog sustava (13:13:30). Probna ploča zatim je 2 min posluživala 17781 s praznom bazom (primila samo ponavljane `PUT status` za 5 starih zadataka → 404; novih zadataka ni napomena nije bilo). Živa ploča vraćena u 13:16:04 (PID 3294786, `/health` 200). |
| **B2** | visoko | `start.sh` čita `<paket>/config/postavke.env`; instalacija i README §5 pišu `~/.taskmanager/config/postavke.env`. `TM_PORT`, `TM_BIND`, `TM_ALLOWED_HOSTS` čvora se ignoriraju. | `TM_PORT=27781` u postavkama čvora → `start.sh` je ipak krenuo na 17781 (to je i okinulo B1). |
| **B3** | visoko | Manifest `instalirano.json` piše se samo u K2.25 iz memorije. Ako instalacija padne ranije (README to predviđa: „run the same command again"), ponovni prolaz alatne mape vidi kao da su postojale prije → manifest ne nastane → `--do-nule` ih ne briše, a `provjeri-cisto` javi **čisto**. Izravno pogađa K8a petlju na Macu (pad → ponovi → do nule). | R1: nakon `--do-nule` HOME 15 GB → **6,6 GB**, `provjeri-cisto` izlaz 0. R2: ostao `~/.bun`, izlaz 0. |
| **B4** | visoko | `tajna.ts` (i prijava) bez `TM_HOME` u okolini pišu u `<paket>/config/` (`konfigPutanjaZaPisanje` pada na mapu paketa), a usluga (`s-okolinom.sh`, `TM_HOME=~/.taskmanager`) čita `~/.taskmanager/config/`. Uz to `config/tajne-otisak.kljuc` nastaje u git stablu i **nije u `.gitignore`**. | `tajna.ts postavi QA_PROBA_K6` → izlaz 0, redak u `<paket>/config/`, `tajnaPostavljena` kroz okolinu usluge = **false**; `git status --porcelain` = 1 (`?? config/tajne-otisak.kljuc`) → K8 kriterij „prazno" pada. |
| **B5** | srednje | `--baze` na Linux x86_64 povuče CUDA torch: `nvidia` 3,2 GB + `torch` 1,1 GB + `triton` 0,9 GB. README: „8 GB slobodno, oko 2,3 GB preuzimanja". | HOME nakon R1 = **15 GB**. Mac (arm64) nema CUDA kotače, pa ga ovo vjerojatno manje pogađa (nije izmjereno). |
| **B6** | nisko | Testovi ovisni o okolini (padaju na node-A **i u bazi 26b79a4**): `install-sh.test.ts --suho` s `--baze` traži ≥ 8 GB slobodnog diska; `platforma.test.ts` lstart: `bun test` računa u UTC-u, a `ps` ispisuje lokalno vrijeme → pomak 4 h na svakom stroju koji nije u UTC-u (i na Macu). U pogonu (bez test runnera) obje strane su lokalne. | node-A: `disk: 4894 MiB slobodno … nedostaje: disk≥8192MiB` (izlaz 3); razlika 14 401 126 ms = 4 h (America/New_York); `bun test` → `TZ env=undefined`, zona `UTC`. |
| **B7** | srednje | `instaliraj-pdf.sh` stavlja probu u `~/app/tmp/pdf-proba` (raspored izvornog sustava, i na Macu) i fontconfig predmemoriju u `~/.cache/fontconfig`; ništa od toga nije u manifestu. | R3 (čisti put): `--do-nule` **izlaz 8** („1 ostataka: ~/.cache"), `~/app/tmp/pdf-proba` ostaje, a `provjeri-cisto` ga ne vidi. |
| N1 | info | `K2.22-linger` bez `loginctl` javlja „bez promjene" umjesto upozorenja. | R1 |
| N2 | info | README/K8 naredba nema `--komplet`, a odluka D2 = B kaže da Mac vrti paket uz komplet izvornog sustava. Naredba u README-u i u planu K8 je ista, pa je to pitanje plana, a ne README-a. | — |

## 4. Regresija

| Gdje | Commit | `bun test` |
|---|---|---|
| QA stroj (UTC), svježi klon | **306c442** | **2448 pass / 2 skip / 0 fail** (2450 testova, 140 datoteka), izlaz 0 |
| QA stroj, svježi klon | 26b79a4 (baza = GitHub) | 2395 pass / 2 skip / 0 fail, izlaz 0 |
| node-A, privremeni klon | **306c442** | 2443 pass / 3 skip / **4 fail** |
| node-A, privremeni klon | 26b79a4 (baza) | 2391 pass / 3 skip / **3 fail** |

Tri pada na node-A ista su u bazi i u kandidatu (B6: disk i vremenska zona). Četvrti
(`sigurnost-4801` rok ProbeGuarda: 6829 ms naspram < 6500 ms, pod `nice -n 10`) samostalno
prolazi **3/3** (23 pass, 0 fail) — vremenski flake. **Novih padova u odnosu na postojeće
testove: 0.**

Ponovljeno 21.10. 15:45 (nakon siroče-oporavka) u worktreeu node-A na 12f419d: puni
`bun test` → 2444 pass / 2 skip / **1 fail** (`files-download.test.ts` „živa ploča se nije
podigla u 10 s", load average 3–5). Ta datoteka samostalno prolazi **34/34 u dva pokušaja**:
to je flake pod opterećenjem, a ne regresija. Ranije pokretanje u istom prolazu dalo je
4 fail i 4 errors uz 2357 testova (datoteke nisu dovršile pod opterećenjem), pa je broj na
node-A nestabilan, ali ni u jednom pokretanju nema pada koji se ponavlja samostalno.

Živi node-A (f50408fb) nije diran. `bootcheck.sh` kandidata nad njegovom instalacijom
(`--paket ~/TaskManagerAI --bez-zapisa`): **PASS**, izlaz 0 (M1–M7 PASS, M8 upozorenje:
neograničen sudo).

## 5. Sud za K7

Kandidat 306c442 **ne uvodi regresiju** i instalacija po README-u na Debianu **prolazi**
(izlaz 0, `uspjeh`, `/health` 200), uz okolinom uvjetovan `--bez-servisa`. Prije K8 na Macu
treba riješiti **B3, B4 i B7**, jer ruše upravo kriterije K8/K8a (`git status` prazan,
`--do-nule` → `provjeri-cisto` = 0). **B1** treba riješiti odmah: ugrožava svaki stroj na
kojem paket dijeli vrata s drugom pločom. Sve je u TASK-5693.
