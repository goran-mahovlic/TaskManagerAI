# E2E razgovornog načina na node-A nakon Malikova pregleda (TASK-5281, 06.10.2026.)

Predmet: ADR-0002 §11, mjerila P1–P8. Bot @regoc_saban_bot, grupa node-A (-5112799687). Izveo: Potjeh.

## Isporuka prije probe
Malikov popravak `6ac0ab6` (TASK-5280, `--setting-sources "" --strict-mcp-config`) nije bio u `main` ni na node-A.
Na node-A je u pogonu bio `bfeeb7b`, a razgovor je bio uključen na razini `rad`.
- `main` je fast-forwardan `bfeeb7b → d58777b` (Malik 6ac0ab6 + QA TASK-5284). `bun test`: 1206 pass, 1 skip, 0 fail.
- `tm-cvor-azuriraj.sh node-A`: `bfeeb7b → d58777b`, MainPID `542948 → 547535`, StaleCodeCheck svjež, M1–M4 PASS, zadataka 160 = 160.

## Način
Kao čovjek ne možemo pisati u grupu, pa je proba vrtjela **isporučeni kod** na node-A (`~/TaskManagerAI/src`).
Poruke su prolazile pravim putem pollera (`jedanProlaz`); lažni su bili samo `getUpdates` (izvor poruke) i `ingest` (da se na ploči ne otvaraju probni zadaci).
Pravi su bili izvršitelj `claude`, Hindsight (tunel 17792), ploča 127.0.0.1:17781 (PUT razgovor, pauza) i Telegram prema grupi, s oznakom `[x-regoc-proba]` na svakom odgovoru.
Pošiljatelj probe nije među dopuštenima, pa su potezi išli na razini `citanje`.
Sesije i zapis išli su u zaseban korijen `~/.tmp/TASK-5281/razgovor` na node-A.
Skripte: `/home/klaudio/app/tmp/TASK-5281/{proba.ts,run.sh,javi.ts}`, izlaz u `proba.log`.

## Rezultati
| Mjerilo | Ishod | Dokaz |
|---|---|---|
| P8 isključivanje | PASS | PUT 200, čitač `ukljucen=false`, predano 0, poziva 0, odgovora 0; `settings_history` `true→false`, changedBy potjeh, source ploca, 17:00:57Z |
| P1 uključivanje + broj | PASS | PUT 200, odgovor „Otvoren je samo 1 zadatak…” = GET /api/tasks (1), 39,7 s ≤ 300, PID 547535 = 547535 |
| P2 samo Klaudiju | PASS | poziva 0, odgovora 0, potvrda 0 |
| P3 nastavak | PASS | `--resume 348ddd30…` = `sesije.json`, zapis `novaSesija:false`, „0 blokiranih” = ploča |
| P4 nalog | PASS | jedna potvrda „📋 Otvoren zadatak …”, izvršitelj 0 poziva |
| P5 pauza / nastavi | PASS | POST /api/pause 200 → „⏸ Sustav je pauziran s ploče.”, 0 poziva; nastavi 200 → „Tu sam.” |
| P6a memorija iz banke | PASS | `regoc_opus_nodea`: 18 činjenica, 6981 ms; odgovor „-5404006386” (chat ID IntergalaktikSportAI postoji samo u banci) |
| P6b Hindsight nedostupan | PASS | url 127.0.0.1:1 → odgovor stiže; dnevnik `memorija …: Unable to connect` |
| P7a token ne izlazi | PASS | odbijanje, tajni dio tokena nije ni u jednoj poruci, nema dokumenta; argv nosi `--setting-sources` i `--strict-mcp-config` |
| P7b dopuštena datoteka | PASS | `DOK …/razgovor/radni/izvjestaj-proba.txt` poslan |
| Kraj | PASS | `ukljucen=true`, `paused=false`, PID nepromijenjen |

Zapis ima 7 ulaza, 7 izlaza i 7 poziva. Trošak je 0,53 USD.
Razgovor je ostao uključen, a rezultat je javljen u grupu node-A.

## Nalazi (bez kvara)
1. P6b je izveden lažnim URL-om (`127.0.0.1:1`), a tunel nije zaustavljen. Ugašen obrnuti tunel daje isti „connection refused”, a nismo htjeli prekidati živu memoriju vlasniku.
2. U odgovoru na P7b model je dodao podnožje „Napravljeno: … Preostalo/blokirano: ništa.”. To je kozmetika.
3. U P7a model spominje „SecurityValidator”. Argv je izoliran, pa pojam najvjerojatnije dolazi iz bloka memorije (banka `regoc_opus_nodea` sadrži pravila sustava). To nije posebno provjereno.
