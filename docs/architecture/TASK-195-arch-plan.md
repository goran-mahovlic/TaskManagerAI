# Arhitektura i plan izvedbe — TASK-195

**Zadatak:** Provjeri koliko je RAM-a slobodno na node-A (`free -h`) i javi kratko
**Projekt:** PRJ-033 (Pretinac — zadatci bez projekta)
**Težina:** 26/100 · prag B: 36 · grill: preskače se · oznaka: samo-tekst
**Izvor:** Telegram, pošiljatelj Goran, chat -5112799687, primljeno 2026-10-06T21:40:58Z
**Arhitektica:** Kosjenka Vuković
**Prethodni korak:** Jelena (TASK-195, completed) — `free -h` izvršeno, rezultat zabilježen, commit + merge gotovi, dojava stvorena

---

## 1. Kontekst i opis zadatka

Korisnik Goran šalje iz Telegrama kratki zahtjev: provjeriti slobodni RAM na node-A pomoću `free -h` i javiti rezultat. Zadatak je niskotežinski (26/100), jednokorakni operativni upit — nema kodnih izmjena, nema testova, nema arhitektonskih odluka. Cijeli tijek je već proveden od strane Jelene (TASK-195, status completed).

Ovaj dokument (TASK-196) je arhitektonski nadzor — dokumentira komponente, tok podataka, rizike i redoslijed koraka za ovaj tip zadatka, nadograđujući se na Jelenin rezultat.

---

## 2. Komponente sustava uključene u tijek

| # | Komponenta | Uloga u tijeku | Status |
|---|---|---|---|
| C1 | **Telegram ingest** | Prima poruku Gorana, stvara zadatak u TaskManageru s izvorom i tagovima | ✅ izvršeno (TASK-195 stvoren, tag `izvor:telegram`) |
| C2 | **TaskManager (REST API)** | Središnji registar zadataka; GET/POST /api/tasks, ploča, dodjele, blokade | ✅ izvršeno (TASK-195 → completed, TASK-196 → in_progress) |
| C3 | **IngestTemplate / koraci.json** | Fiksni popis od 10 koraka (0–9) koji zadatak nosi u opisu | ✅ učitano iz `templates/koraci.json` |
| C4 | **Registarski vrataši** | GrillGate (prag B), ResearchRagGate, TaskDecomposer/normalizePlan, CriticGate, GitCommitGate, MergeGate | ✅ svi procijenjeni; grill/istraživanje/razlaganje preskočeni ispod praga B |
| C5 | **Izvršitelj (Jelena, Engineer)** | Izvršava `free -h` na node-A, bilježi rezultat, commita | ✅ commit `2ab4d06e` |
| C6 | **Git** | Grana `zadatak/TASK-195`, commit, merge u main | ✅ grana postoji, merge `4595acf3` |
| C7 | **Dojava (Klaudio, Telegram agent)** | Prima report-back zadatak (TASK-195-DOJAVA), šalje sažetak Goranu | ✅ stvoren, pending (assignee: klaudio) |
| C8 | **node-A (ciljni stroj)** | Izvršno okruženje — `free -h` daje stanje RAM-a | ✅ 15Gi total, 13Gi available |

---

## 3. Tok podataka

```
Telegram (Goran, chat -5112799687)
    │
    ▼
[Ingest] ── POST /api/ingest ──► TaskManager: TASK-195
    │                              │  tagovi: ulaz, izvor:telegram, tezina:26, nalog, samo-tekst
    │                              │  projectId: PRJ-033
    │
    ▼
[Ocjena korak 4] ── težina 26 < 36 ──► grill ⏭️, istraživanje ⏭️, razlaganje ⏭️
    │                              │  oznaka: samo-tekst (nema kodnih izmjena)
    │
    ▼
[Grana korak 5] ── git checkout -b zadatak/TASK-195
    │
    ▼
[Izvedba korak 6] ── Jelena: free -h na node-A
    │                   │
    │                   ▼
    │              total 15Gi | used 1.3Gi | free 11Gi | buff/cache 3.1Gi | available 13Gi
    │              Swap 1.0Gi | 0B korišteno
    │                   │
    │                   ▼
    │              commit 2ab4d06e: "TASK-195 korak 6: free -h provjera RAM-a..."
    │
    ▼
[Provjera korak 7] ── os A: nema koda → N/A | os B: sukladnost s zahtjevom ✅
    │
    ▼
[Spajanje korak 8] ── merge 4595acf3 u main ── lanac zelen
    │
    ▼
[Dojava korak 9] ── stvara TASK-195-DOJAVA (report-back, assignee: klaudio)
    │                   │  replyTo: -5112799687
    │                   ▼
    │              Klaudio šalje sažetak Goranu u Telegram
    │
    ▼
DONE — niz zatvoren
```

**Ulazi:**
- Poruka korisnika (Telegram, tekst)
- `templates/koraci.json` (fiksni popis koraka)
- `config/agents.json` (registar izvršitelja)

**Izlazi:**
- Rezultat `free -h` (tekstualna tablica, zapisana u result_summary i task_log)
- Git commit + merge
- Dojava korisniku (preko Klaudija)

---

## 4. Rizici i mjere

| # | Rizik | Vjerojatnost | Utjecaj | Mjera | Status |
|---|---|---|---|---|---|
| R1 | `free -h` ne uspije (node-A nedostupan, SSH prekid) | Niska | Srednji | Jelena bilježi grešku u result_summary; zadatak prelazi u blocked | Nije se dogodilo — ✅ prošlo |
| R2 | Dojava ne stigne do Gorana (Klaudio ne šalje, Telegram API greška) | Niska | Visoki | TASK-195-DOJAVA u statusu pending; vratar provjerava zatvaranje report-back zadatka | ⚠️ pending — čeka Klaudija |
| R3 | Zadatak bez projectId padne u pretinac i nestane iz izvještaja | — | Srednji | Sustav automatski dodjeljuje PRJ-033 | ✅ projectId: PRJ-033 dodijeljen |
| R4 | Krivo čitanje `free -h` (confused: "free" kolona vs "available") | Niska | Niski | Jelena izvještava "available" kao mjerodavnu metriku | ✅ ispravno — 13Gi available |
| R5 | Git commit izostane → GitCommitGate blokira completed | Niska | Visoki | Obvezan commit po koraku; oznaka samo-tekst omogućuje completed bez kodnih izmjena, ali commit je svejedno obvezan | ✅ commit 2ab4d06e postoji |
| R6 | Grill preskok pogrešan (zadatak ipak složeniji) | Vrlo niska | Niski | Težina 26 daleko ispod praga 36; `free -h` je trivijalni upit | ✅ preskok opravdan |

---

## 5. Redoslijed koraka (fiksni popis iz templates/koraci.json)

| Korak | Naziv | Obvezno? | Izvršitelj | Stanje | Dokaz |
|---|---|---|---|---|---|
| 0 | **PRIJEM** | ✅ obvezno | automatika | ✅ gotovo | TASK-195 postoji, tagovi: ulaz, izvor:telegram, tezina:26, nalog, samo-tekst; projectId: PRJ-033 |
| 1 | **GRILL** | preskače se | arhitekt | ⏭️ preskočeno | Težina 26 < 36; zapis "nema značajne odluke" u `data/task_logs/TASK-195.md` |
| 2 | **ISTRAŽIVANJE** | neobvezno | istraživač | ⏭️ preskočeno | Ispod praga B; jednostavan jednokorakni zadatak; odluka zabilježena u task logu |
| 3 | **RAZLAGANJE** | neobvezno | orkestrator | ⏭️ preskočeno | Ispod praga B; jedan korak (`free -h`), nema što razložiti; odluka u task logu |
| 4 | **OCJENA** | ✅ obvezno | automatika + planer | ✅ gotovo | Težina 26; oznaka `samo-tekst` dodana u tagove |
| 5 | **GRANA** | ✅ obvezno | izvršitelj (git) | ✅ gotovo | `git checkout -b zadatak/TASK-195`; grana postoji |
| 6 | **IZVEDBA** | ✅ obvezno | Jelena (TDD/DiagnosingBugs) | ✅ gotovo | `free -h` izvršeno; commit `2ab4d06e` |
| 7 | **PROVJERA** | ✅ obvezno | QA + sigurnost | ✅ gotovo | Os A: nema kodnih izmjena (samo-tekst) → N/A; Os B: sukladnost s zahtjevom potvrđena |
| 8 | **SPAJANJE** | ✅ obvezno | orkestrator (MergeGate) | ✅ gotovo | Merge `4595acf3` u main; lanac provjera zelen |
| 9 | **DOJAVA** | ✅ obvezno | dojavljivač (Klaudio) | ✅ stvoreno | TASK-195-DOJAVA (report-back, assignee: klaudio, replyTo: -5112799687); status pending |

---

## 6. Plan izvedbe (dekompozicija)

Zadatak je ispod praga B (26 < 36) — razlaganje je neobvezno i preskočeno je s opravdanjem. Ipak, za arhitektonsku dokumentaciju, evo logičke dekompozicije na 3 elementarne korake:

| Podzadatak | Ulaz | Izlaz | Izvršitelj | Ovisnost | Status |
|---|---|---|---|---|---|
| P1: Izvrši `free -h` na node-A | SSH pristup node-A | Tekstualna tablica (total/used/free/available/swap) | Jelena | — | ✅ gotovo |
| P2: Zabilježi rezultat i commitaj | Izlaz P1 | Git commit + result_summary | Jelena | P1 | ✅ gotovo (commit 2ab4d06e) |
| P3: Stvori dojavu korisniku | Izlaz P1 + replyTo adresa | TASK-195-DOJAVA (report-back) | Orkestrator → Klaudio | P2 | ✅ stvoreno (pending) |

**normalizePlan provjera:** Nema ciklusa (P1 → P2 → P3, linearno). Izvršitelji poznati (jelena, klaudio). ✅ prolazi.

---

## 7. Arhitektonske odluke

**ADR nije potreban.** Ovaj zadatak ne donosi značajnu arhitektonsku odluku — to je trivijalni operativni upit (težina 26, samo-tekst). Sve odluke su već donesene u ranijim ADR-ovima (ADR-0002 za Telegram ingest, ADR za fiksni popis koraka).

Zapis: **"Nema značajne odluke."**

---

## 8. Zaključak arhitektice

Tijek je ispravno proveden. Svi obvezni koraci (0, 4, 5, 6, 7, 8, 9) su završeni. Neobvezni koraci (1, 2, 3) su opravdano preskočeni (težina 26 < prag B 36). Rezultat `free -h` je točno pročitan i zabilježen. Git commit i merge postoje. Dojava je stvorena i čeka Klaudija za slanje.

**Jedini preostali rizik (R2):** TASK-195-DOJAVA je u statusu pending — Klaudio mora poslati poruku Goranu da niz bude potpuno zatvoren. To je izvan mog opsega (dojava je dodijeljena Klaudiju, a sustav automatski pokreće sljedećeg agenta).

**REGOC-STATUS: ARCHITECTURE DONE — arhitektura i plan izvedbe dokumentirani.**
