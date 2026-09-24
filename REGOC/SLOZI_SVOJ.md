# Složi svoj — najmanji recept

[English](SLOZI_SVOJ.en.md) · [Natrag na pregled](README.md)

Ne treba ti jedanaest uloga, tri baze i mreža čvorova da bi sustav radio. Treba ti ploča, jedan
model, dvije do tri uloge i jedan ulaz. Ostalo se dodaje kad se izmjeri da nedostaje.

Ovaj recept ima jedno pravilo redoslijeda: **prvo sve što samo gleda, tek onda sve što djeluje.**

---

## Sastojci

| Sastojak | Najmanja izvedba | Gdje |
|---|---|---|
| **paket** | ploča i baza | `bash scripts/install.sh`, zatim `bun src/TaskWebUI.ts` |
| **jedan CLI modela** | `claude` ili bilo koji poslužitelj s OpenAI-kompatibilnim HTTP sučeljem | `executors` u `config/orchestrator.json` |
| **registar s 2–3 uloge** | izvršitelj + provjeritelj (+ istraživač) | `config/agents.json` |
| **jedan kanal** | sama ploča; zatim `POST /api/ingest` ili Telegram | `config/ingest-gate.json` |

Provjera da ploča radi: `bash scripts/health.sh`. Mjesto podataka: `$TM_HOME` (zadano
`~/.taskmanager`).

### Registar za početak

```json
{
  "agents": [
    { "id": "izvrsitelj", "ime": "Izvršitelj",
      "uloga": "Piše i mijenja kod. Test prvo. Svaka tvrdnja uz naredbu koja je dokazuje.",
      "keywords": ["*"] },
    { "id": "provjeritelj", "ime": "Provjeritelj",
      "uloga": "Sumnja u tuđi rad. Ponavlja naredbe iz dokaza i javlja razliku.",
      "keywords": ["provjeri", "pregledaj", "test"] }
  ]
}
```

Dvije uloge su dovoljne da proizvođač ne ocjenjuje sam sebe. Koordinator ima smisla tek kad je
izvršitelja više i treba ih usmjeravati — ne prije (v. [TIM.md](TIM.md)).

---

## Faza 1 — samo gledaj (prvi tjedan)

1. **Ploča i ručni zadatci.** Otvaraj zadatke ručno i zatvaraj ih ručno. Vidjet ćeš kakav ti
   tijek posla stvarno treba, umjesto da ga pogađaš.
2. **Svi vratari u sjeni.** To je zadano stanje paketa — samo provjeri da je tako:

| Vratar | Postavka | Zadano |
|---|---|---|
| vratar zatvaranja | `config/completion-gate.json` → `live` | `false` (sjena) |
| strukturirani izlaz | `config/step-schema.json` → `nacin` | `shadow` |
| kritičar | `config/features.json` → `criticGate` / `criticGateLive` | isključeno — upali `criticGate` (sjena) |
| strop stvaranja | `taskCreateBreaker` / `taskCreateBreakerLive` | isključeno — upali prvi (sjena) |
| najam spawna | `spawnCloseGuard` / `spawnCloseGuardLive` | isključeno — upali prvi (sjena) |
| čistači | `watchdog.*.mode` u `orchestrator.json` | `shadow` |
| ulaz poruka | `perSource` u `ingest-gate.json` | `"*": "off"` — tvoj izvor na `shadow` |

3. **Mjerilo potrošnje prije ikakve autonomije.** Bez brojke nemaš kočnicu, a bez kočnice je
   autonomija pitanje vremena. `tools/session_usage.py` mora raditi i davati svježe brojke —
   inače vrata autonomije moraju ostati zatvorena (v.
   [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md)).

---

## Faza 2 — jedan agent, na nalog

4. **Orkestrator jednim prolazom.** `bun scripts/orchestrator.ts --stanje` pokaže što je
   podešeno; `--jednom` napravi točno jedan prolaz. Pokreni ga ručno nad jednim zadatkom i
   pročitaj ishod na ploči.
5. **Strop usporednih agenata na 1** (Config → Usporedni agenti). Povisuje se kad je jedan
   agent dosadan, ne kad je uzbudljiv.

---

## Faza 3 — što se pali tek nakon mjerenja

Svaki od ovih koraka ima isti uvjet: **zapis sjene pokazuje koliko bi vrata odbila i koliko od
toga pogrešno** — i taj je drugi broj nula ili ga razumiješ.

| Korak | Uključuje se | Što izmjeriti prije |
|---|---|---|
| **automatsko izvršavanje** | `enabled: true` u `orchestrator.json` | mjerilo potrošnje radi; nijedan zadatak u redu nije ostatak testa; pauza je isprobana |
| **kritičar uživo** | `criticGateLive` | u sjeni nema presude „pada" nad poslom koji je stvarno dobar |
| **zatvaranje kroz orkestrator** | `spawnCloseGuardLive` | u sjeni se vidi da agent zatvara tijekom rada; nijedan čovjekov PUT ne bi bio odbijen |
| **strukturirani izlaz** | `nacin: "on"`, kasnije `provodiNedostajuci` | nevaljanih blokova nema; nedostajući su samo s putova koji blok ne nose |
| **strop stvaranja** | `taskCreateBreakerLive` | prag iznad najgoreg sata u tvojoj povijesti |
| **čistači** | `watchdog.*.mode: "live"` | nijedan „zombi" u sjeni nije bio živ agent |
| **ulaz poruka** | tvoj izvor na `on` | koliko bi zadataka nastalo iz tjedna poruka, i jesu li trebali |

Povratak svakog koraka je jedna riječ u postavci, bez ponovnog pokretanja.

---

## Što namjerno ne dirati na početku

- **Stupnjevana autonomija i buđenje na obnovu kvote** — tek kad ima posla koji čeka kvotu.
- **Lanci uloga** (arhitekt → inženjer → QA → sigurnost) — tek kad jedan izvršitelj
  vidljivo ne stiže; lanac od četiri koraka za posao od deset minuta košta više nego donosi.
- **RAG** — kad te prvi put zaboli što sustav ne pamti prošli tjedan; od prvog upisa s
  projektom i vrstom (v. [BAZE.md](BAZE.md)).
- **Procjena energije** — to je pretvorba troška, ne novo mjerilo
  (v. [TROSAK_I_ENERGIJA.md](TROSAK_I_ENERGIJA.md)).

---

## Zašto baš ovim redom

Izvorni sustav neke je od ovih koraka napravio obrnuto i svaki ga je vratio natrag: autonomija
prije mjerila potrošnje, vratar uživo prije sjene, orkestrator koji je radio umjesto da
dijeli posao. Skupe lekcije su u [LEKCIJE.md](LEKCIJE.md); ovaj recept je njihov redoslijed.

Više o sastavljanju cijelog sustava: `docs/SUSTAV.md`, `docs/AGENTI.md`, `docs/INSTALL.md`.
