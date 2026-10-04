# Što je u paketu, a što samo u izvornom sustavu

TaskManagerAI je izdvojen iz živog sustava agenata (REGOČ, opisan u [REGOC/](../REGOC/README.md)).
Izvorni sustav se mijenja svaki dan, a u paket ulazi samo ono što radi **bez** njegovog daemona,
mosta prema Telegramu i interne memorije. Ovaj dokument nabraja razlike stanjem od
**04.10.2026.** Ne skriva ih: ako nešto piše u dnevniku izvornog sustava, a ovdje stoji
„samo u izvornom sustavu", u paketu toga **nema** i ne treba ga tražiti.

Svaka stavka ima naredbu kojom se tvrdnja provjerava u ovom repozitoriju. Pokreće se iz korijena
paketa.

---

## 1. Ušlo u paket

| Novost | Gdje je u paketu | Provjera |
|---|---|---|
| **Uređivač rasporeda Config stranice**: jedan gumb ✎ Uredi ↔ 💾 Spremi, premještanje unutar skupine, promjena veličine, Esc/Odustani, Zadano, Sažmi | `src/core/ConfigRaspored.ts`, `src/ConfigRasporedUredivac.js`, `GET/PUT /api/config/raspored` | `bun test tests/config-raspored-logika.test.ts tests/config-raspored-postavka.test.ts tests/config-raspored-api.test.ts` |
| **Config stranica u pet skupina** (Strop i vrata · Agenti i modeli · Integracije · RAG · Sustav), skok na skupinu | `src/TaskWebUI.ts` (`cfg-skupina-1` … `cfg-skupina-5`) | `grep -c 'class="info-skupina" id="cfg-skupina-' src/TaskWebUI.ts` → 5 |
| **Pragovi vrata autonomije** kao postavka, promjenjivi uživo | `src/core/AutonomyThresholdSetting.ts`, `GET/PUT /api/config/autonomy` | `bun test tests/autonomy-threshold-setting.test.ts` |
| **Strop usporednih agenata (1–10)** | `src/core/ConcurrencySetting.ts`, `GET/PUT /api/config/concurrency` | `bun test tests/concurrency-setting.test.ts` |
| **Katalog tijekova 1.3.0** — 11 tijekova, među njima novi `dorada-isporuke` i `izrada-dokumenta` | `agents/workflows.json` | `python3 tools/odaberi_workflow.py --popis` |
| **Vrata tijeka (workflow-gate) s pravilima I1–I7**: korak lanca ne dobiva vlastiti tijek (`u-lancu`), okidači u naslovu ili naslovu+opisu (`trazi_u`), `iskljucuje`, `prioritet` | `src/core/WorkflowGate.ts`, `src/core/WorkflowMaterializer.ts` | `grep -c "trazi_u\|razlaganje" src/core/WorkflowGate.ts` > 0 |
| **Ploča na mobitelu**: `GET /api/tasks?view=board`, br/gzip, WS bez punog popisa | `src/PlocaPromet.ts`, `src/TaskWebUI.ts` | `bun test tests/ploca-promet.test.ts` |
| **Traka „Čeka odluku"** u tri skupine, isti filtar kao odlučitelj | `src/core/OdlukeRazvrstaj.ts`, `tools/odlucitelj.py` | `bun test tests/odluke-razvrstaj.test.ts tests/odlucitelj-isti-filtar.test.ts` |
| **Ulazna vrata v1** za generički ulaz `POST /api/ingest` (težina, pragovi 16/36/81, položaj po izvoru) | `src/core/Ingest.ts`, `src/core/IngestConfig.ts`, `src/core/WeightScore.ts` | `bun test tests/ingest.test.ts` |

Katalog `agents/workflows.json` je **zajednički**: izvorni sustav ga čita iz ovog paketa, pa je
tijek dodan ovdje odmah vidljiv i ondje. Tijekovi se mijenjaju samo u toj datoteci.

## 2. Samo u izvornom sustavu (nije u paketu)

| Novost (zadatak) | Što radi ondje | Zašto nije u paketu | Provjera da ga nema |
|---|---|---|---|
| **Puni kontekst zadatka** (TASK-5158/5159): modul `TaskBrief` puni svaki novi zadatak sa šest odjeljaka (cilj, kontekst, zadaće, vještine i alati, tijek i korak, kriterij gotovosti) | `POST /api/tasks` vraća upozorenje kad odjeljak fali | vezan uz registar imenovanih agenata i njihove vještine | `grep -rl TaskBrief src` → prazno |
| **Odabir tijeka po nalogu** (TASK-5159): `POST /api/nalozi` bira tijek za cijeli nalog i razrješava korake `agent: "izvorni"` i `mehanizam: "report-back"` | koraci `dorada-isporuke` dobivaju izvršitelja izvornog zadatka | ulaz naloga je Telegram most izvornog sustava | `grep -c "api/nalozi" src/TaskWebUI.ts` → 0 |
| **Javljanje tijeka pri završetku** (TASK-5159): poruka o završetku nosi odjeljak „🧭 Tijek posla" (tijek, koraci, tko je radio, vještine i alati izmjereni iz transkripta) | prekidač `tijekPosla` u konfiguraciji dojave | mjeri se iz transkripata agenata, kojih paket nema | `grep -c "Tijek posla" src/core/ReportBackTask.ts` → 0 |
| **Ulazna vrata v2** (TASK-5161/5162): ocjena po nalogu i broju struka, odrezan zalijepljeni ispis | razred iz naloga i struka; i dalje u sjeni | umjerena na porukama jedne grupe; QA je preporučio da ostane u sjeni | `grep -rl "brojStruka" src` → prazno |
| **Nesukladnost B — zatvaranje kroz daemon** (TASK-5163..5165, 5210): `PUT completed` od agenta dobiva `202` i oznaku `ceka-kriticara`; daemon zatvara nakon kritičara | prekidač `zatvaranjeKrozDaemon` (sjena) | treba daemon izvornog sustava; QA je našao da „neprovjereno" još prolazi kao `completed` | `grep -rl "ceka-kriticara" src` → prazno |
| **Nesukladnost C — rad bez zadatka**: kuka odbija pisanje Telegram sesije koja nema otvoren zadatak | `rad-bez-zadatka.json`, `nacin: shadow` | kuka je dio Claude Code okoline izvornog sustava | `grep -rl RadBezZadatka hooks src` → prazno |
| **Nesukladnost D — dorada zatvorenog zadatka**: `POST /api/tasks/<ID>/dorada`, `/ponovno-otvori`, `/biljeska` | dorada je novi zadatak povezan s izvornim | dio iste izmjene kao B; čeka QA popravka | `grep -c "/dorada'" src/TaskWebUI.ts` → 0 |
| **Obnova popisa sustava** (prekidač `popis-obnova`, TASK-5152/5166): petlja svakih 10 min obnavlja kartu sustava i RAG zbirku popisa | `popis-obnova.json`: `ukljuceno`, `dopunaHindsighta` | opisuje agente i alate izvornog sustava | `grep -rl "popis-obnova" src tools config scripts` → prazno |
| **Memorija (Hindsight)**: kartice „Memorija (test)", „Hindsight model" i „Usporedni pozivi Hindsighta (1–10)", `GET/PUT /api/config/memorija` | prekidač po potrošaču (`globalno`, `telegram_sesija`, `agenti`), `on` traži odobrenje | Hindsight je zaseban servis izvornog sustava | `grep -c "api/config/memorija" src/TaskWebUI.ts` → 0 |
| **Revizija blokiranih** (TASK-5204): kartica i `/api/blokirani/revizija` | prekidač `revizijaBlokiranih` (sjena) | presude čita iz daemona | `grep -c "blokirani/revizija" src/TaskWebUI.ts` → 0 |
| **Petlje i sitnice** (TASK-5166/5167): petlje `mjere-cron` i `transkript-arhiv` pod nadzornikom, autor RAG upisa iz okoline | pomoćni procesi izvornog sustava | paket nema daemon ni petlje | — |

**Što to znači za tebe kao korisnika paketa:**

- `dorada-isporuke` i `izrada-dokumenta` su u katalogu, ali u paketu nema `POST /api/nalozi`.
  Korak `agent: "izvorni"` i korak `mehanizam: "report-back"` paketni materijalizator ne
  razrješava, zato **`materijalizacija` u `config/workflow-gate.json` neka ostane `shadow`**
  dok koristiš ta dva tijeka. Isto stoji u `agents/workflows.json` → `_meta.povijest`.
- Javljanje tijeka pri završetku u paketu ne postoji. Dojava o završetku (`ReportBackTask`) šalje
  rezultat bez odjeljka „Tijek posla".
- Ulazna vrata u paketu ocjenjuju težinu starom formulom (v1). Pragovi su isti (16/36/81).
  Bez datoteke postavki ulaz je za sve izvore `on` (`ZADANE_POSTAVKE` u
  `src/core/IngestConfig.ts`), jer iza njega u paketu stoji samo zapis na ploči; primjer
  `config/ingest-gate.example.json` stavlja `"*": "off"`.

## 3. Druge instalacije izvornog sustava

Paket nije alat kojim se izvorni sustav prenosi na druge strojeve. Dva čvora izvornog sustava
izmjerena su 04.10.2026. Oba vrte znatno stariju ploču i daemon, a kopija paketa na njima je
iz rujna (najnoviji unos u njezinu `CHANGELOG.md` je od 05.09.2026.; nema uređivača rasporeda). Čvorove treba
nadograditi zasebno. Ovaj dokument ih ne nadograđuje.

## 4. Kako se ovaj popis održava

Kad novost iz izvornog sustava uđe u paket, redak iz §2 se seli u §1 u istom commitu kao i
kod, a u [CHANGELOG.md](../CHANGELOG.md) se upisuje zašto. Novost koja ne ulazi dobiva redak
u §2 s razlogom.
