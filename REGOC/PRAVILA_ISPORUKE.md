# Pravila isporuke — kada je „gotovo" stvarno gotovo

[English](PRAVILA_ISPORUKE.en.md) · [Natrag na pregled](README.md)

Najveći problem u radu s agentima nije pogrešan odgovor nego **uvjeren pogrešan odgovor**.
Agent koji kaže „gotovo, testovi prolaze" zvuči jednako i kad je to istina i kad nije. Ovaj
dokument opisuje tri mehanizma koji tvrdnju pretvaraju u nešto što se može provjeriti.

---

## 1. Vrata provjere: pet koraka prije tvrdnje

```
IDENTIFY  →  RUN  →  READ  →  VERIFY  →  CLAIM
```

| Korak | Pitanje |
|---|---|
| **IDENTIFY** | Što točno tvrdim? Koja naredba to dokazuje? |
| **RUN** | Jesam li je pokrenuo — sada, nad ovim kodom? |
| **READ** | Jesam li pročitao cijeli ispis, uključujući izlazni kod? |
| **VERIFY** | Slaže li se ispis s tvrdnjom? |
| **CLAIM** | Tek sada tvrdim — i navodim dokaz. |

Preskakanje trećeg koraka najčešći je uzrok lažnog „radi": naredba je pokrenuta, ali nitko nije
pročitao da je pala.

### RUN uključuje ponovno pokretanje dugotrajnog procesa

**Spremljena datoteka mijenja samo disk.** Poslužitelj, demon ili radnik koji je pokrenut prije
izmjene i dalje vrti stari kod — većina okruženja kod ne učitava ponovno sama od sebe.

Primjer iz izvornog sustava: popravak demona spremljen je dvadesetak minuta nakon što je proces
pokrenut. Zadatak popravka zatvoren je kao gotov, a par minuta kasnije dva su nova zadatka
zatvorena s točno onim kvarom koji je popravak trebao spriječiti — jer popravak nije bio u
pogonu. Otad pravilo glasi: ako si dirao kod dugotrajnog procesa, restartaj ga i u rezultat
upiši **novi PID i vrijeme pokretanja**. Bez toga je „gotovo" netočno.

U paketu ovaj blok ulazi u svaki prompt (`prompt.includeVerificationGate` u
`orchestrator.json`, zadano uključeno).

---

## 2. Strukturirani status: jedan kanal za ishod

Zadnji redak odgovora agenta **mora** biti jedna od tri deklaracije:

```
REGOC-STATUS: DONE — <što je isporučeno>
REGOC-STATUS: BLOCKED — <koji alat ili pristup nedostaje>
REGOC-STATUS: NEEDS_CONTEXT — <koji opis ili kontekst nedostaje>
```

Zašto zatvoren skup, a ne slobodan opis: slobodan opis dopušta „uglavnom je gotovo", što ne
znači ništa. Tri riječi stroj čita doslovno (`CompletionGuard.parseDeclaredStatus` podnosi
markdown, crtice i podvlake oko njih).

Zašto **jedini** kanal: kad je agent ishod javljao i tekstom i pozivom API-ja, dva su se kanala
natjecala — i API je pobjeđivao prije suda kritičara (v.
[ZIVOTNI_CIKLUS_ZADATKA.md](ZIVOTNI_CIKLUS_ZADATKA.md)). Jedan kanal nema utrku.

**Agentova izjava ima prednost.** `BLOCKED` ili `NEEDS_CONTEXT` pobjeđuje i besprijekoran blok
dokaza: tko sam kaže da nije gotov, nije gotov. Takav sud smije blokirati i dok je ostatak
vratara u sjeni (`deterministicLive` u `config/completion-gate.example.json`), jer nije
heuristika. Nedovršen posao prijavljen kao `BLOCKED` uredan je ishod; lažni `DONE` je kvar.

---

## 3. Strukturirani izlaz koraka: `REGOC-IZLAZ`

Uz status agent ostavlja JSON blok s pet polja, najavljen retkom `REGOC-IZLAZ`:

```json
{
  "napravljeno": "Dodana provjera prijelaza stanja u rukovatelj PUT-a.",
  "dokaz": [
    {"vrsta": "test", "naredba": "bun test tests/prijelazi.test.ts", "izlaz": "24 pass, 0 fail"},
    {"vrsta": "http", "naredba": "curl -s -o /dev/null -w '%{http_code}' …", "izlaz": "409"}
  ],
  "datoteke": ["src/TaskWebUI.ts"],
  "sljedeci_korak": null,
  "nesigurnosti": ["nije provjereno uz stvarni kanal poruka"]
}
```

Vratar sudi o **poljima**, ne o prozi (`src/core/StepSchema.ts`).

### Zatvoren rječnik dokaza

Svaka vrsta nosi ono čime se ponavlja. Izmišljena vrsta je greška, ne tiho propuštanje — inače
bi se rječnik razvodnio prvim agentom koji smisli `{"vrsta": "osjećaj"}`.

| Vrsta | Što mora imati |
|---|---|
| `naredba` | naredbu i njezin izlaz |
| `test` | naredbu i **brojčani** izlaz (npr. „24 pass, 0 fail") |
| `datoteka` | putanju koja se može otvoriti |
| `mjerenje` | broj |
| `http` | statusni **kod** („200", ne „OK") |
| `commit` | sha (7–40 heksadekadskih znakova) |
| `url` | http(s) adresu |
| `rag` | ID upisanog dokumenta, ne samo ime zbirke |

Vrsta `rag` dodana je nakon mjerenja, a ne po ukusu: upis u RAG jest ponovljiv, ali su ga agenti
prijavljivali kao `datoteka`, a ID dokumenta nije putanja — pa je rupa bila u rječniku, ne u
agentu.

### Zašto je prozni brojač mjerio rječnik

Prije sheme vratar je brojao „dokazne riječi" u sažetku: spomen `bun`, putanja s nastavkom,
broj uz riječ „test", statusni kod. Na 50 zadnjih dovršenih zadataka:

| Mjera | Rezultat |
|---|---|
| prozni brojač (≥ 2 vrste riječi) | **42 / 50 = 84 %** |
| ponovljiv dokaz (naredba + njezin izlaz, provjerljiva putanja…) | **0 / 50 = 0 %** |

Prvi broj izgleda kao zdravlje, a mjeri rječnik. Rečenica „pokrenuo sam `bun test` i sve prolazi
u `X.ts`" ima dvije vrste riječi i prolazi, a ne sadrži nijedan podatak koji bi itko mogao
ponoviti. Nakon uvođenja sheme klasa „blok postoji, ali dokaz ne valja" pala je sa 7 od 50 na
**0 u svih 56** sljedećih zadataka.

### Načini rada i dvije grane

Postavka `config/step-schema.json` (primjer: `config/step-schema.example.json`; nedostajuća ili
neispravna datoteka znači `shadow`):

| `nacin` | Ponašanje |
|---|---|
| `off` | blok se ne traži, sud se ne donosi; prompt je bajt-identičan onome bez sheme |
| `shadow` | sud se donosi i zapisuje, ništa se ne odbija |
| `on` | **nevaljan** blok (`schema_invalid`) odbija zatvaranje |

Blok koji **nedostaje** (`schema_missing`) odbija se samo uz `on` **i**
`provodiNedostajuci: true`, i to izvan izuzeća: knjigovodstveno zatvaranje kraće od 2 s,
oznaka `bez-bloka` ili zaglavlje `X-REGOC-Zatvara: covjek|orkestrator`. Izvor `agent` ne smije
sam sebi napisati izuzeće.

Zašto dvije grane, a ne jedan prekidač: mjerenje je pokazalo da bi globalni `on` odbio 7 od 50
zatvaranja (14 %) u kojima je posao **stvarno obavljen** — a pet od tih sedam sažetaka nije
napisao agent koji je blok uopće vidio, nego orkestrator ili čovjek. Kažnjava se samo pravilo
koje je izvršitelj vidio: tko je napisao blok, vidio je pravilo, pa lažno odbijanje nevaljanog
bloka nije moguće. Zato `schema_invalid` smije uživo, a `schema_missing` čeka mjerenje.

`provodiNedostajuci` je **zastavica, ne četvrti način**: `nacin` ostaje `off`/`shadow`/`on`, pa
je povratak i dalje jedna riječ. Promjena vrijedi bez ponovnog pokretanja.

---

## Kako se tri mehanizma slažu

```
agent radi ──► vrata provjere (u promptu) ──► REGOC-IZLAZ + REGOC-STATUS
                                                   │
                         ┌─────────────────────────┴──────────────────────┐
                         ▼                                                ▼
              vratar ploče sudi o poljima                  kritičar sam pokreće provjere
                         └─────────────────────────┬──────────────────────┘
                                                   ▼
                                        completed  ili  blocked
```

Vidi i: [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md) · [LEKCIJE.md](LEKCIJE.md)
