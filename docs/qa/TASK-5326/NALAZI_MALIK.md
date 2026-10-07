# TASK-5326 — sigurnosni pregled P5 kompleta izvornog sustava na node-A (TASK-5323)

Pregledao: Malik (Security), 07.10.2026. Opseg: ADR-0004 §13.9, tablica P5 (Jelena komplet + Malik pregled).
Pregledano bez izmjena u pregledanim datotekama; nalazi idu Jeleni na popravak.

## Što je izmjereno (dokaz)

| Provjera | Ishod |
|---|---|
| `payload/` prema `MANIFEST.sha256` (lokalno) | 200 datoteka = 200 redaka, `sha256sum -c` OK, popis se poklapa |
| `docs/qa/TASK-5323/MANIFEST_komplet.sha256` prema MANIFEST-u kompleta | isti hashevi |
| Na node-A: `sha256sum -c` za MANIFEST kompleta (`~` kao korijen) | 172 OK; 4 FAILED (`Nalog/TaskBrief/TijekPosla/WorkflowGate.test.ts`, mijenja ih korak 5 skripte `sed`); 24 `config.novo/*` ne postoje (to je namjerno: `cp -n`, pa `rm`) |
| 5 poveznica na node-A | sve relativne `tools/<ime>.ts → <mapa>/<ime>.ts` |
| Proširena pretraga tajni u teretu (sk-or-v1, ghp_/gho_, hf_, AIza, xox, sk-…32, dodjele token/secret/key) | 0 pogodaka |
| Pretraga tajni u `docs/qa/TASK-5323/` | 1 pogodak, lažno pozitivan (regex brane same u diffu, redak 568) |
| node-A: datoteke/mape u `~/.claude/regoc` i `~/app/regoc_system` s dozvolom pisanja za sve | nema ih |
| node-A: `features.json` C6 | `revizijaBlokiranih`, `revizijaBlokiranihLive`, `zatvaranjeKrozDaemon` = true |
| node-A: `config/stale-watchdog.json` | `klaseUzivo: ["deploy"]`, `maxRedrive: 3` |
| node-A: drop-in `regoc-taskmanager.service.d/najmovi.conf` | `TM_IZVORNI_NAJMOVI=%h/.claude/regoc/data/spawn_leases` |
| node-A: sigurnosna kopija | `~/backup/task4777_20261007_135746/prije.tgz` 14.7 MB, 5966 unosa |

## Nalazi (od najozbiljnijeg)

| # | Ozbiljnost | Mjesto | Nalaz | Preporuka |
|---|---|---|---|---|
| S1 | SREDNJA | `deploy_node_a.sh:83-85` | `sha256sum -c MANIFEST.sha256` provjerava samo navedene datoteke. Datoteka koja je u teretu, a nije u MANIFEST-u, prođe provjeru i `tar xf - -C ~` je raspakira u HOME. Poveznice uopće nisu u MANIFEST-u (`gradi_komplet.sh:70` uzima samo `-type f`): poveznica u teretu s ciljem `../../.ssh/…` ili apsolutnim ciljem ne bi se primijetila. MANIFEST i teret stižu istim kanalom, pa MANIFEST štiti od oštećenja, a ne od podmetanja. | Na čvoru prije raspakiranja: (a) `find payload -type f \| sort` mora biti točno popis iz MANIFEST-a, (b) svaka poveznica mora biti s popisa (dodati `L <putanja> <cilj>` retke u MANIFEST), a cilj relativan i bez `..`. Inače izlaz ≠ 0 i bez raspakiranja. |
| S2 | SREDNJA | `IzlazniKanal.ts:47-50` (zove ga `~/.claude/regoc/PaketKanal.ts:31`) | `kanalZaDaemon()` piše `TM_HOME`, `TM_CREDENTIALS` i `TM_TELEGRAM_CONFIG` u `process.env` **procesa RegocDaemon**. Daemon okolinu daje svakom spawnu (`RegocDaemon.ts:8330` `daemonEnv = { ...process.env }`, i `:1233`). Nakon prvog čitanja kanala svaki LLM agent na čvoru dobiva putanju do spremišta tajni paketa. Poziv koji bi trebao samo čitati ima nevidljivu posljedicu. | Putanje predati izravno `izlazniKanal()`/`TelegramConfig` kao argument i ne mijenjati globalni `process.env`. Ako to nije moguće, u `PaketKanal.ucitajKanalPaketa` spremiti i vratiti stare vrijednosti ili ih maknuti iz `daemonEnv`. Test: nakon `paketKanal()` je `process.env.TM_CREDENTIALS` nepromijenjen. |
| S3 | SREDNJA | `gradi_komplet.sh:65` | Brana tajni prepoznaje samo `sk-ant-`, Telegram bot token, AWS `AKIA` i PEM. Ne prepoznaje OpenRouter `sk-or-v1-` (a komplet sadrži `openrouter-agent.ts`), GitHub `ghp_/gho_`, HF `hf_`, Google `AIza`, Slack `xox*`, ni dodjele `"token": "…"`. Danas je teret čist (0 pogodaka, vidi tablicu), ali zaštita je preuska. | Proširiti regex na gornje oblike i dodati heuristiku ključ = vrijednost (`(token\|secret\|api_?key\|password)\s*[:=]\s*["'][^"']{16,}`) za `config.novo/`. |
| S4 | SREDNJA | `gradi_komplet.sh:56-60` | Postavke se filtriraju popisom zabrana (`daemon.env`, `telegram-identity.json`, sadrži li datoteka `/home/klaudio`). Sve ostalo vezano uz glavni stroj prolazi. Primjer: `config.novo/ingest-gate.json` nosi chat grupe glavnog `-5161938429`. `cp -n` štiti samo kad čvor datoteku već ima. Novi `config/*.json` na glavnom tiho odlazi na čvor. | Popis dopuštenih postavki (`CONFIG_DOPUSTENI=…`) umjesto popisa zabrana. Uz to provjera na ID-jeve chatova/IP-ove glavnog (`-5161938429`, `adminId`). |
| S5 | NISKA | `deploy_node_a.sh:69-73` | Sigurnosna kopija: `tar czf … 2>/dev/null; ls …`. Greška `tar`-a je skrivena i progutana (`;`), a `set -e` je ne vidi. Isporuka može krenuti bez valjane kopije. (Ovaj put je kopija nastala: 14.7 MB.) | `tar --ignore-failed-read czf … \|\| exit 6` pa `test -s prije.tgz \|\| exit 6`. U kopiju dodati i `~/.config/systemd/user/*.d` (C6/drop-ini se mijenjaju ručno). |
| S6 | NISKA | `deploy_node_a.sh:95-96` | Korak 5 radi `sed -i` nad isporučenim datotekama nakon provjere MANIFEST-a. Zato se MANIFEST na čvoru više ne može ponovno provjeriti (izmjereno: 4 FAILED). Svaki budući modul s `\|\| '/home/klaudio'` tiho će se razlikovati od MANIFEST-a. `$DALJINA_HOME` ulazi u `sed` izraz bez escapiranja. | Normalizaciju napraviti pri gradnji ili je izostaviti, jer su to samo rezerve. Uz to (vidi S7) ne slati `*.test.ts`. |
| S7 | NISKA | `gradi_komplet.sh:44` | `ls *.ts` šalje i `*.test.ts` (testovi s putanjama i chat ID-jevima glavnog: `Nalog.test.ts`, `WorkflowGate.test.ts` …) na pogonski čvor. | `ls *.ts \| grep -vE '\.bak\|\.test\.ts$'`, ako `paritet.py` ne traži testove. Ako ih traži, neka paritet izuzme testove. |
| S8 | NISKA | `PaketKanal.ts:28-31` | `require()` s putanje iz `TM_PAKET_DIR` ili `~/TaskManagerAI` izvršava kod u procesu daemona. Na glavnom do toga ne dolazi (`RegocDaemon.ts:700`: postoji `telegram.json`). Ipak, ako čitanje `telegram.json` jednom ne uspije, daemon na glavnom učita `~/TaskManagerAI/src/IzlazniKanal.ts`. | Prije `require` provjeriti `realpath`, vlasnika (uid procesa) i da mapa nije pisljiva za grupu/sve. Kad je `HOME` stroja glavni, `ucitaj` neka vrati null bez require. |
| S9 | NISKA | `deploy_node_a.sh:18` | `KLJUC=$HOME/.ssh/regocmobile_ed25519` ne postoji na glavnom (izmjereno: `Identity file … not accessible`). SSH tiho koristi zadani ključ. | Ispraviti putanju ili javiti grešku kad ključa nema (`test -r "$KLJUC" \|\| exit 2`). |
| S10 | NISKA | `deploy_node_a.sh:122-123` | `bun build --outfile=/tmp/_rd.js`: predvidljiva putanja u `/tmp` na čvoru. | `mktemp -d` pod `~/.tmp` i brisanje nakon gradnje. |
| I1 | INFO | `deploy_node_a.sh:76-83` | U `~/.tmp/task4777_*` na čvoru ostaju kopije tereta (4.4 MB i 2.4 MB). | Na kraju `rm -rf ~/.tmp/task4777_$ZIG`. |
| I2 | INFO | node-A `0.0.0.0:17781` | Ploča sluša na LAN-u. `liveSpawns` (taskId/agent/pid) se vidi bez autentikacije. To nije uveo P5. | Samo zabilješka: vezati na 127.0.0.1 ili autentikacija (zaseban zadatak). |

## Što je u redu (pozitivno)

- `TaskCloser.ts:247-307`: `TM_IZVORNI_NAJMOVI` se samo čita (`ziviNajmovi`). `pocistiNajmove` briše samo vlastitu mapu paketa, nikad mapu daemona domaćina. Živost se provjerava preko `/proc/<pid>` i starosti zapisa, pa pokvaren zapis ne zaključava ništa.
- `StaleWatchdog.ts:583-597`: `klaseUzivo` ne propušta ništa kad je neispravan (neispravno = `[]`), a klase odluka/čovjek/sigurnost/novac se uvijek izbacuju. `[deploy]` + `maxRedrive 3` je ograničen opseg.
- `RegocDaemon.ts:700`: kanal paketa vrijedi samo kad stroj nema vlastitog bota. Na glavnom se paket ni ne pita. Token se drži samo u memoriji i ne ispisuje se (greška se reže na 120 znakova i ne sadrži token).
- `deploy_node_a.sh:55`: `in_progress = "?"` znači da restarta nema.
- `PaketKanal.chatZaPoruku`: poruka namijenjena grupi glavnog ne ide kroz bota paketa u tu grupu, nego u chat vlasnika čvora.

## Nije provjereno

- Dozvole datoteka spremišta tajni paketa na node-A (`~/TaskManagerAI/config`, `data/`): sigurnosna kuka (SecurityValidator) blokira svaku naredbu koja dira te putanje, pa i `stat`. Treba ih provjeriti ručno: `stat -c %a` mora dati 600.
