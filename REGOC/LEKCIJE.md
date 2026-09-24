# Lekcije — šest skupih kvarova

[English](LEKCIJE.en.md) · [Natrag na pregled](README.md)

Proširenje odjeljka „Naučene lekcije" iz [README.md](README.md). Svaka lekcija ima isti oblik:
**simptom** (što se vidjelo), **uzrok** (što se stvarno dogodilo), **lijek** (što je
promijenjeno) i **brana** (što sprječava da se vrati). Lijek bez brane traje do sljedeće
izmjene koda.

---

## 1. Jeka delegiranja — izvještaj koji postaje novi zadatak

**Simptom.** U dva sata nastalo je **686 zadataka** iz jednog izvora. Svaki je dobio spawn koji
je pao za četiri sekunde bez ijednog koraka. Taj jedan dan nosio je 77 % svih neuspjeha u
cijelom zapisu.

**Uzrok.** Agentov izvještaj — s uobičajenim odjeljcima sažetka, analize i rezultata — vratio
se kroz ulaz kao opis novog zadatka. Novi zadatak proizveo je novi izvještaj, taj novi zadatak,
i tako dalje. Straža koja je trebala prepoznati izvještaj tražila je oznake odjeljaka u
običnom obliku, a agenti su ih pisali podebljano: u dnevniku je bilo 16 podebljanih naspram 5
običnih. Promašivan je **većinski** oblik.

**Lijek.** Straža jeke (`src/core/DispatchGuard.ts`) prepoznaje izvještaj i u podebljanom i u
skraćenom obliku, i odbija isti sadržaj poslan dvama agentima u kratkom razmaku.

**Brana.** Strop na **stvaranju** zadataka, ne na pokretanju: 30 na sat po autoru, 90 globalno,
višak ide u red čekanja, jedna dojava po epizodi (`src/core/TaskCreateBreaker.ts`, v.
[VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md)). Osigurač na pokretanju agenata vidio je rafal tek kad
je svaki zadatak već bio u bazi — jedan korak prekasno.

---

## 2. Lažni ✅ — utrka agenta i kritičara

**Simptom.** Zadatci stoje na ploči kao `completed`, a korisnik istodobno dobiva poruku da posao
**nije** izvršen. Dnevnik kritičara uredno piše „blokiram".

**Uzrok.** Kritičar se pokreće tek kad agentov proces izađe, a agent je zadatak zatvarao
pozivom API-ja **dok je proces još radio**. Agent tu utrku ne dobiva ponekad nego **uvijek**:
**6 od 6** zadataka koje je kritičar oborio bilo je zatvoreno 5 do 80 sekundi prije presude.
Kasni sud nije se mogao upisati jer iz `completed` ne vodi put u `blocked`, a pogreška zapisa
bila je omotana u prazan `catch {}` — kvar je bio i nevidljiv.

**Lijek.** Stanje završetka postavlja samo orkestrator nakon suda; agent ishod javlja jedino
retkom `REGOC-STATUS:` (v. [ZIVOTNI_CIKLUS_ZADATKA.md](ZIVOTNI_CIKLUS_ZADATKA.md)).

**Brana.** Najam spawna: dok proces radi, ploča odbija `completed` izvana (`409 SPAWN_ACTIVE`).
Zatvaranje ide kroz jednu funkciju koja provjerava odgovor, jednom ponavlja mrežne pogreške i
**glasno** zapisuje svaki neuspjeh (`src/core/TaskCloser.ts`). Jedina točka istine ne smije
tiho pasti.

---

## 3. Test koji piše u živu bazu

**Simptom.** Na ploči su se pojavili zadatci „Full Task", „Task 1", „Pending 2". Orkestrator je
nad njima pokrenuo **tri skupe sesije** modela, a ispitni zadatak s prioritetom 1 okidač je
gurnuo u red izvršavanja.

**Uzrok.** Testovi su sloj baze stvarali bez izričite putanje, a zadana putanja bila je —
pogonska baza. Postojeće zaštite bile su po pozivatelju i po dogovoru, pa ih je svaki novi test
mogao zaboraviti.

**Lijek.** Svaki test stvara vlastitu privremenu bazu.

**Brana.** Strukturna provjera u samom sloju baze (`src/core/LiveDbGuard.ts`): pada ako su
**oba** uvjeta istinita — proces je u ispitnom okruženju **i** putanja je živa baza. Pravi kućni
direktorij čita se iz sustavske baze korisnika, a ne iz `$HOME`, jer ga e2e testovi namjerno
podmeću. Izlaz za nuždu je izričit i vidljiv (`REGOC_ALLOW_LIVE_DB_IN_TEST`).

---

## 4. Blokada kuke s izlaznim kodom 0

**Simptom.** Zadatci zatvoreni kao gotovi, a u rezultatu doslovno piše poruka o blokadi zbog
potrošnje. Agent nije napisao nijedan token.

**Uzrok.** Kuka koja čuva kvotu odbila je prompt. CLI modela tada **ne pokrene model**: ispiše
poruku blokade i izađe s kodom **0**. Pozivatelj je izlazni kod 0 shvatio kao uspjeh i upisao
poruku kao rezultat. Dodatna opasnost: CLI na kraj ispisa vraća **cijeli izvorni prompt** — da
je proslijeđen dalje u kanal, bio bi i novi izvor jeke.

**Lijek.** Ispis se razvrstava **prije** upisa rezultata: potpis blokade traži se na početku
retka (izvještaj koji samo *spominje* tu frazu ne smije pasti pod filtar), blokada postaje
`BLOCKED`, nikad `DONE`, a rep s promptom se odsijeca.

**Brana.** Izlazni kod nije dokaz. Ishod se čita iz retka `REGOC-STATUS:` i iz polja dokaza
(v. [PRAVILA_ISPORUKE.md](PRAVILA_ISPORUKE.md)); ispis bez statusa nije uspjeh. Testovi rade nad
doslovnim, arhiviranim ispisom blokade, ne nad izmišljenim primjerom.

---

## 5. Zastarjeli kod u živom procesu

**Simptom.** Zadatak popravka zatvoren je kao gotov — uz vlastitu napomenu „još nije u pogonu".
Nekoliko minuta kasnije dva nova zadatka zatvorena su s točno onim kvarom koji je popravak
trebao ukloniti.

**Uzrok.** Datoteka je spremljena petnaestak minuta nakon što je proces pokrenut, a okruženje
kod ne učitava ponovno. Popravak je bio na disku, ne u pogonu.

**Lijek.** Nakon izmjene koda dugotrajnog procesa — restart, i u rezultat novi PID i vrijeme.

**Brana.** Dvije. U svakom promptu je vrata provjere s pravilom „RUN uključuje restart"
(`PromptBuilder.ts`, `prompt.includeVerificationGate`). U izvornom sustavu uz to postoji alat
koji za zadani proces razriješi ulaznu datoteku i sve njezine lokalne uvoze i usporedi njihovo
vrijeme izmjene s vremenom pokretanja procesa; novija datoteka znači glasan alarm i izlazni kod
različit od nule.

---

## 6. Preslike pravila na više mjesta

**Simptom.** Pravilo „agent ne postavlja stanje" promijenjeno je, a ponašanje agenata nije.
Drugdje: propis o tome što prompt mora sadržavati imao je deset stavki, a mjerenje je pokazalo
da se tri ispunjavaju, a tri nikako. Ploča je pritom dva napuštena mehanizma prikazivala kao
aktivna.

**Uzrok.** Isti tekst živio je u **dva** graditelja prompta i u **osam** zamrznutih kopija —
paketi za druge čvorove, mobilna izvedba, ispitni kostur, dokumentacija. Ispravak jedne kopije
nije uskladio propis. Datoteka s pravilima za koju se vjerovalo da ulazi u svaki prompt uopće se
nije učitavala: agenti su pokretani iz druge radne mape.

**Lijek.** Jedan izvor istine po pravilu: registar agenata za identitet, predložak za prompt,
jedna tablica prijelaza stanja, jedna funkcija za putanje konfiguracije (`konfigPutanja` u
`src/core/paths.ts`). Kopije se generiraju iz izvora, ne održavaju rukom.

**Brana.** Prije izmjene pravila pretraži **sve** njegove kopije i nabroji ih u zapisu odluke.
Strukturni test sa zaporom broji pojave i smije samo padati — primjer je
`tests/bez-nasih-vrijednosti.test.ts`: test s tvrdom nulom padao bi od prvog dana i bio bi
isključen, a zapor pada samo kad broj **naraste** ili se pojava javi u **novoj** datoteci.
Empirijska provjera je jača od čitanja koda: pogledaj što agent stvarno dobije u promptu.

---

## Što je zajedničko

Svih šest kvarova ima isti oblik: **sustav je vjerovao signalu koji ne mjeri ono što se
tvrdi** — izlaznom kodu, postojanju datoteke, zapisu u jednoj od više kopija, pozivu API-ja
umjesto suda. Brana je u svakom slučaju ista vrsta stvari: provjera koju radi netko drugi, nad
onim što je stvarno u pogonu.

Vidi i: [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md) · [SLOZI_SVOJ.md](SLOZI_SVOJ.md)
