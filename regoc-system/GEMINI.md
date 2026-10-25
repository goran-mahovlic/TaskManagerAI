# PRAVILA SUSTAVA — komplet na čvoru paketa

Pravila koja daemon kompleta (`RegocDaemon.ts`) učitava pri startu (`PravilaSustava.ts`, TASK-5793).
Ovo je inačica za čvor paketa: putanje su relativne na instalaciju (`$TM_HOME`, `$TM_SUSTAV_DIR`,
`$TM_PAKET_DIR` iz `instalacija.env` i `scripts/s-okolinom.sh`), bez rasporeda glavnog čvora.
Glavni čvor ima vlastitu datoteku pravila (`~/app/regoc_system/GEMINI.md`) i ona ima prednost;
izričitu putanju daje `TM_PRAVILA`.

## PRAVILA

**1. PISANJE SAMO GDJE JE DOPUŠTENO**
Agent piše u radnu mapu zadatka i u mape koje zadatak izričito navodi. Sve ostalo je samo za čitanje.

**2. ZNANJE PRIJE ODGOVORA**
Prije „ne znam" agent pretraži memoriju (RAG) i dokumentaciju paketa (`docs/`, README kompleta).

**3. SAMO AGENTI IZ REGISTRA**
Spawnaju se samo agenti iz `REGOC_AGENTS.json` (jedini izvor istine), nikad generički agent.

**4. PUNI IDENTITET PRI SPAWNU**
Imenovani agent dobiva puni identitet unaprijed (`IdentityBlock.ts`): ime, ulogu, stil, vještine,
putanje znanja i vlastitu memoriju.

**5. GREŠKA SE ISTRAŽUJE ODMAH**
Uzrok se traži i popravlja (ne zaobilazi), a lekcija se sprema u memoriju.

**6. PROVJERA ULAZA (ZOD)**
Podaci zadatka i izlaz agenta prolaze provjeru sheme prije upotrebe.

**7. NAPREDAK U TASKMANAGERU**
Agent bilježi napredak (`progressNotes`) na ploči svakih nekoliko minuta. Status zadatka ne postavlja
agent — presudu daje zadnjim retkom `REGOC-STATUS: DONE | BLOCKED | NEEDS_CONTEXT`, a zatvara daemon.
Posao u pozadini prijavljuje redak `REGOC-POZADINA: pid=… [gotovo=…] [rok=…]`.

**8. PRIVREMENI PODACI SAMO U INSTALACIJI**
Radni i privremeni podaci idu u radnu mapu zadatka pod `$TM_HOME/tmp`, nikad u `/tmp`.
Brisanje samo kroz branu brisanja.

**9. TAJNE NIKAD U ISPIS**
Tajne žive u spremištu čvora (`$TM_CREDENTIALS`). U poruke, dnevnik, opis zadatka i memoriju ide
samo IME varijable, nikad vrijednost; okolina procesa se ne ispisuje.

**10. TEST PRIJE KODA, PROVJERA PRIJE TVRDNJE**
Svaka izmjena ima test napisan prije koda. Prije `DONE`: pronađi provjere, pokreni ih, pročitaj
izlaz, potvrdi da dokazuje uspjeh, pa tek onda tvrdi — uz doslovni citat dokaza.

**11. POPRAVAK NA DISKU NIJE POPRAVAK U POGONU**
Dugotrajan proces (daemon, ploča) vrti kod s kojim je pokrenut. Popravak vrijedi tek nakon restarta
i provjere da proces vrti novi kod. Daemon i ploču agent ne restarta iz vlastitog spawna — zakazuje
odgođeni restart kad nema zadataka u radu.

**12. BEZ RACIONALIZACIJE**
„Previše jednostavno za test", „testirat ću poslije", „već sam provjerio" nisu razlozi — pokaži izlaz.

**13. NEOVISNOST O MODELU**
Komponenta traži razinu kvalitete (frontier/strong/good/basic/classifier), a konkretni model bira
usmjerivač modela iz `models/model-config.json`. Model se ne upisuje tvrdo u kod.

**14. ŠTEDNJA PRETPLATE**
Probe i provjere idu na najmanji dovoljan model i najmanji broj poziva; vrata autonomije prate
potrošnju (mjerilo `session_usage.py`).

**15. LINKOVI BEZ NAVODNIKA**
Putanju ili adresu koju korisnik kopira piši golu, bez navodnika uz nju.
