# QA razgovornog načina na node-A (TASK-5278, 06.10.2026.)

Predmet: ADR-0002 (razgovorni način bota), isporuka 0e25b17 na node-A (PID 532202), bot @regoc_saban_bot, grupa node-A (-1001234567890).
Izvela: Potjeh. Probe: `/home/klaudio/app/tmp/TASK-5278/{proba.ts,p8.ts,rok.ts}` (kopije na node-A u `~/.tmp/TASK-5278/`).

## Način
Kao čovjek u grupu nije bilo moguće pisati, jer nemamo korisnički Telegram klijent, a bot ne prima poruke drugih botova.
Zato je `proba.ts` vrtio **isporučeni kod na node-A** (`~/TaskManagerAI/src`). Pravi su bili: `claude` izvršitelj, Hindsight (tunel 17792), ploča 127.0.0.1:17781 i Telegram kanal prema grupi node-A, uz oznaku `[x-regoc-proba]` na svakom odgovoru.
Sesije i zapisi išli su u zaseban korijen (`~/.tmp/TASK-5278/razgovor`), pa produkcijski `sesije.json` nije diran.
Poller put (`jedanProlaz`) testiran je s lažnim `getUpdates`/`ingest`, pa na ploči nije otvoren nijedan probni zadatak.

## Rezultati
| Mjerilo | Ishod | Dokaz |
|---|---|---|
| Prekidač s ploče uživo (P1/P8) | PASS | PUT ukljucen false→true: HTTP 200/200, PID 532202 prije = poslije, `settings_history` 2 retka (changedBy potjeh, source ploca), dnevnik `[RAZGOVOR] postavke promijenjene` |
| Kratka poruka → odgovor u grupi (P1) | PASS | „36 otvorenih (31 blocked + 5 pending)” = GET /api/tasks; 62,7 s ≤ rokSek 300 |
| Nastavak razgovora `--resume` (P3) | PASS | drugi potez resume=efdaa126…, bez identiteta, „31 blokirano” = ploča |
| Nova sesija nakon neaktivnosti | PASS | zadnjiMs −31 min → bez resume, identitet poslan, `[PRETHODNI KONTEKST`, sesija efdaa126→beadc8cb |
| Burst merge | PASS | 3 poruke u 0,6 s → 1 poziv, prompt `jedan\ndva\ntri`, 1 odgovor |
| Nalog → zadatak + potvrda (P4) | PASS | potvrda „📋 Otvoren zadatak …”, izvršitelj 0 poziva |
| Poruka samo Klaudiju (P2) | PASS | 0 poziva, 0 odgovora; isti tekst Šabanu → točno 1 |
| Ručna kočnica (P5) | PASS | POST /api/pause → „⏸ Sustav je pauziran s ploče.”, 0 poziva; nastavak → 1 poziv „Tu sam.” |
| Hindsight nedostupan (P6) | PASS | url 127.0.0.1:1 → odgovor stiže, dnevnik `memorija …: Unable to connect` |
| Memorija on (P6) | PASS uz nalaz | 5/7 poteza dobilo 19–22 činjenice; 2/7 istekla na rokMs 9000 |
| Nema dvostrukih odgovora | PASS | zapis 7 ulaza = 7 izlaza = 7 poziva |
| Isključen razgovor → bez odgovora (P8) | PASS | `p8.ts`: ukljucen=false → 0 predano, true → 1 |

## Nalazi
1. **Konfiguracija node-A (vlasnik, nije diran):** u 12:32:21 EDT s ploče je upisano `telegram.ulaz.dopusteniChatovi=["100000011"]`, a to je vlasnikov korisnički ID, ne ID chata. Filtar vrijedi za ingest i za razgovor, pa se grupa -1001234567890 od tada ignorira. Javljeno u grupu.
2. **Rok memorije nije tvrd** (TASK-5286). U zapisu je potez od 20 191 ms s istekom i potez od 15 917 ms bez greške, uz rokMs 9000. Repro `rok.ts` (Bun 1.3.14): rok 2000 ms → stvarno 2022, 2003 i 13 831 ms.
3. **Obavijest „completed” se šalje dvaput** (TASK-5287): TASK-163..166, completed → completed.
4. TASK-5283 (`dopusteni-sve` + `preskociAkoSpominje`) u vrijeme probe nije bio isporučen, pa njegov pregled ostaje otvoren.

Trošak probe: 7 poziva modela, ukupno ≈1,08 USD (zapis po potezu).
