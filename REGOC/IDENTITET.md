# Identitet agenta pri pokretanju

[English](IDENTITET.en.md) · [Natrag na pregled](README.md)

Agent je CLI modela pokrenut za jedan zadatak. Sam od sebe ne zna ni tko je ni što smije.
Sve što ga čini arhitektom, a ne generičkim pomoćnikom, mora mu se dati **pri svakom
pokretanju** — i to iz jednog izvora.

---

## Jedno pravilo: identitet se gradi iz jednog registra, svaki put

Pri svakom spawnu orkestrator iz registra agenata slaže **blok identiteta** i predaje ga
modelu zajedno sa zadatkom. Nema drugog mjesta s kojeg agent smije saznati tko je:

- ni iz prethodne sjednice (mogla je biti drugog agenta),
- ni iz datoteke s pravilima u radnoj mapi (CLI je možda ne učita — ovisi o mapi iz koje je
  proces pokrenut),
- ni iz ručno održavane kopije teksta u kodu.

Zašto baš jedan izvor: u izvornom sustavu isti propis o tome što prompt mora sadržavati bio je
zapisan u registru, u dva graditelja prompta i u nekoliko zamrznutih kopija za druge čvorove.
Mjereno je da se od deset propisanih stavki **tri ispunjavaju bezuvjetno, dvije uvjetno, dvije
djelomično i tri nikako**. Propis na više mjesta nije propis nego nekoliko verzija koje se
razilaze (v. [LEKCIJE.md](LEKCIJE.md), „preslike pravila").

Drugi, tehnički razlog: blok identiteta istog agenta je **bajt-identičan** od pokretanja do
pokretanja. Time predmemorija prefiksa prompta kod davatelja modela i dalje vrijedi, a to je
izravno novac.

---

## Što blok mora sadržavati

| Dio | Sadržaj | Napomena |
|---|---|---|
| **Tko si** | ime i uloga, jednom rečenicom | bez ovoga agent je generički pomoćnik |
| **Stil** | kako komunicira: kratko, s brojkama, bez ukrasa… | ulazi u svaki izvještaj |
| **Vještine** | **njegove** vještine, uz kratak sažetak svake | uz izričitu ogradu da ostale iz kataloga nisu njegove |
| **Vlastiti alati** | alati koje smije zvati i kako | samo oni koji postoje na tom stroju |
| **RAG zbirka** | gdje čita prije rada i gdje upisuje nalaz nakon rada | samo zbirke čije je postojanje potvrđeno |
| **Znanje za učitati** | **popis putanja** koje treba pročitati, ne njihov sadržaj | v. niže |

**Znanje kao popis, ne kao umetnuti tekst.** Doslovno umetanje je odbijeno mjerenjem: znanje
jedne uloge imalo je oko 34 KB (≈ 8 400 tokena) po pokretanju, a svaka izmjena tih datoteka
rušila bi bajt-identičnost bloka i s njom predmemoriju. Popis postojećih putanja uz uputu
„pročitaj prije početka" daje isti učinak za djelić cijene. Putanje koje ne postoje se
izostavljaju i broje, da se vidi što nedostaje.

U paketu blok slaže `src/core/orchestrator/PromptBuilder.ts` iz predloška
`templates/prompt/zadatak.md` (odjeljak „Tko si") i polja registra `config/agents.json`
(v. [TIM.md](TIM.md)). Vlastiti predložak: `prompt.templateDir` u `orchestrator.json` ili
`TM_PROMPT_TEMPLATES`. Nepoznata zamjena `{ime}` ostaje doslovno u tekstu — tipfeler u
predlošku mora biti vidljiv, a ne tiho nestati.

Činjenice o tvojoj infrastrukturi (gdje je ploča, koji servisi postoje) **nisu** dio koda:
upisuješ ih sam u `prompt.systemFacts`. Prazan popis je ispravno početno stanje.

---

## Zašto je napušten generator anonimnih agenata

Temeljni okvir (PAI) nudi alat koji iz popisa osobina (stručnost, osobnost, pristup) složi
**bezimenog** agenta za jedan posao. U izvornom sustavu taj je alat proglašen napuštenim, iz
četiri razloga:

1. **Provodi suprotnu politiku.** Predložak doslovno kaže da agent nema trajan identitet, a
   pravilo sustava je da rade samo imenovane uloge. To nije pokvaren alat nego alat za drugu
   politiku.
2. **Potreba je izmjerena i iznosi nulu.** U 940 izvođenja kroz pet tjedana svih 940 je
   izvela imenovana uloga iz registra; bezimenih 0.
3. **Slučaj „nema uloge za ovaj posao" ima jeftiniji odgovor:** nov zapis u registru. Graditelj
   bloka ga pokupi bez ijedne izmjene koda.
4. **Bezimeni agent lomi evidenciju.** Trošak po projektu, telemetrija izvođenja i vlastita RAG
   zbirka vežu se uz ID agenta. Agent bez imena u tim je zapisima rupa, a ne redak.

Alat nije obrisan (dolazi iz uzvodnog projekta i ništa ne troši dok ga nitko ne zove), ali je
napuštanje **vidljivo** označeno. Nevidljivo napuštanje — mrtav kod koji ploča prikazuje kao
aktivan — upravo je kvar zbog kojeg je odluka i donesena.

Ako se ikad izmjeri da znatan dio poslova nema prikladnu ulogu, odluka se preispituje — s
brojkom iz dnevnika izvođenja, ne s pretpostavkom.

---

## Zamka: sistemski kanal curi

CLI modela obično prima identitet preko zastavice za sistemski prompt (npr.
`--append-system-prompt`, `systemPromptFlag` u izvođaču). Sve što ide kroz argumente naredbenog
retka:

- vidljivo je **svakom korisniku stroja** u popisu procesa dok agent radi;
- završava u dnevnicima nadzora procesa, u ispisima pogrešaka i u izvještajima o padu;
- može se zadržati u povijesti ljuske ako netko naredbu ponovi ručno.

Zato pravilo bez iznimke:

> **Tajne nikad ne idu u identitet ni u prompt.** Ni ključevi, ni lozinke, ni tokeni, ni
> adrese koje nisu za javnost.

Agent koji treba pristup dobiva **ime varijable okoline** ili putanju do datoteke s ograničenim
pravima — nikad vrijednost. U `orchestrator.json` se za HTTP izvođač zato upisuje `apiKeyEnv`
(ime varijable), a ne ključ. Sam tekst zadatka može se modelu predati kroz standardni ulaz
(`promptChannel: "stdin"`) umjesto kao argument, pa ne završi u popisu procesa.

Vidi i: [TIM.md](TIM.md) · [PRAVILA_ISPORUKE.md](PRAVILA_ISPORUKE.md)
