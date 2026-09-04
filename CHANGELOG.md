
## 2026-09-04 — potrošnja, vrijednost rada i RAG

**Potrošnja po projektu**
- `GET /api/projects/trosak` — ukupna potrošnja po projektu iz `cost_log` (SQL, bez pokretanja
  vanjskih alata), uz prozor od 30 dana te datume prvog i zadnjeg rada (iz zadataka, ne iz
  `projects.created_at` koji često nastane naknadno).
- Kartica projekta prikazuje UKUPNU potrošnju, ne prozor — projekt bez izvođenja u zadnjih
  30 dana više ne pokazuje „—".
- Automatsko osvježavanje: Potrošnja 120 s, Projects 60 s, samo dok je kartica otvorena i
  prozor preglednika vidljiv.
- Pregled uz brojku vraća `kontrola` — kontrolni zbroj iz `cost_log` za isto razdoblje; ploča
  ispisuje „✔ slaže se" ili razliku. Zadano razdoblje pregleda je „svo vrijeme".

**Vrijednost rada po cjeniku S1–S6**
- `tools/vrijednost_inputa.py` — segmentira transkripte (žive i arhivirane) po korisničkoj
  poruci, razvrstava upit u S1–S6 iz zabilježenog rada (koraci, broj i vrsta poziva alata) i
  zbraja po korisniku, projektu i razredu. Trošak modela NIJE mjerilo složenosti.
- `GET /api/vrijednost-inputa` (keš 10 min) i odjeljak u kartici Potrošnja: tablica po
  korisnicima i tablica po projektima s punim nazivom projekta.
- Kartica projekta ima drugi chip — vrijednost (zeleno) uz trošak (plavo); hover pokazuje tko
  je radio. Panel projekta ima odjeljak „Tko je radio" s udjelima po osobama.

**Popis projekata**
- Sortiranje po zadnjem radu, potrošnji, imenu, početku rada i broju zadataka, uz obrtanje smjera.

**RAG**
- `tools/rag_audit.py` (pregled + tagiranje `project_id`), `tools/rag_tipovi.py` (vrsta
  dokumenta `tip_regoc` + oznaka `zasticeno` za pravila, lekcije i pogreške),
  `tools/rag_archive.py` (izvoz/uklanjanje/vraćanje uz zaštitu), `tools/rag_izdvoji.py`
  (izdvajanje znanja iz naslijeđenih kolekcija).
- Filtar po vrsti dokumenta u kartici RAG (`?tip=`), uz postojeći filtar po projektu.
- Brisanje kolekcije odbija se ako sadrži zaštićene dokumente ili ako se kolekcija čita pri
  pokretanju sjednice.

**Uvoz i razvrstavanje**
- `tools/uvoz_telegram_zadataka.py` (zahtjevi iz transkripata u zadatke, segment kao jedinica),
  `tools/razvrstaj_prijave.py` (svaka prijava svoj projekt), `tools/razvrstaj_pretinac.py`
  (tema s tri ili više zadataka dobiva projekt).

**Održavanje paketa**
- `scripts/uskladi_s_regocem.sh` — prijenos izmjena iz žive instalacije uz prepisivanje putanja
  uvoza; dosad se radilo rukom, pa je paket zaostajao.
