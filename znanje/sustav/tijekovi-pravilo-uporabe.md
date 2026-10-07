# Pravilo uporabe tijekova: kako REGOČ slaže lanac zadataka

Ova datoteka je ručni opis odluke. Stanja prekidača, popis tijekova i njihovi koraci nisu ovdje nego u generiranom sloju `docs/system-map/popis/` (datoteke `tijek-<id>.md`, `agent-<id>.md` i `prekidaci.md`).

## Kada se uopće slaže lanac
Kriterij nije trajanje posla nego broj različitih struka koje posao traži. Ako nalog traži više specijalista (na primjer istraživanje, dizajn, izradu i provjeru), REGOČ ga ne radi sam. Razbija ga na zadatke u TaskManageru i dodjeljuje ih agentima prema vještinama. Kratak i jednostručan posao (odgovor, provjera stanja, sitna izmjena) radi se bez lanca. Dorada već isporučenog posla uvijek dobiva vlastiti zadatak prije početka rada.

## Redoslijed provjere kad REGOČ slaže lanac
REGOČ prije otvaranja lanca prolazi pet koraka, ovim redom.

1. **Ocjena ulaznih vrata.** Ulazna vrata daju poruci težinu i razred od E1 do E5. Težina određuje treba li lanac uopće: lagan posao ide jednom izvršitelju, a težak posao (E4 i E5) je kandidat za razlaganje. Težina je i prag tijeka, jer svaki tijek ima polje `najmanja_tezina` ispod kojeg se ne pokreće.
2. **Prijedlog tijeka.** REGOČ pogleda katalog tijekova `workflows.json` i odluku vrata tijeka za taj nalog u `data/workflow_odluke.jsonl` (polja `workflow`, `kod` i `razlog`). Prijedlog je savjet, a ne naredba, dok su vrata u načinu sjene. Ako se tijek uklapa, REGOČ preuzima njegove korake, uloge i vještine. Ako se ne uklapa, REGOČ u bilješci zadatka zapiše zašto ga je odbacio. Taj zapis je mjerilo za prelazak vrata iz sjene u pogon.
3. **Vještine agenata.** Za svaki korak REGOČ provjerava ima li izabrani agent vještinu koju korak imenuje (polje `vjestina` u koraku, vještine agenta u `popis/agent-<id>.md`). Ako je nema, korak dobiva izvršitelja koji je ima ili se u opis upisuje zamjena iz polja `zamjena`. Vještina se uvijek imenuje u opisu koraka, jer je agenti sami gotovo nikad ne biraju.
4. **Izričita oznaka ima prednost.** Oznaka `workflow:<id>` na zadatku pobjeđuje okidače, a oznaka `bez-workflowa` pobjeđuje sve, i izričitu oznaku i način rada `on`. Ugašen tijek (`enabled: false`) ne pokreće se ni na izričit zahtjev.
5. **Otvaranje lanca.** Svaki korak postaje zadatak s `assignee`, `projectId` izvornog naloga, oznakom `chat:<id>` ako je nalog došao s Telegrama i vezom `blockedBy` prema prethodnom koraku. Veza se upisuje i u suprotnom smjeru (`blocks`), jer ploča odblokira sljedeći korak samo kad su obje strane upisane.

## Tijek se bira za nalog, a ne za korak
Tijek opisuje cijeli posao od naloga do isporuke. Korak lanca već je dio tijeka i ne smije dobiti vlastiti tijek. Vrata tijeka danas računaju odluku i za svaki korak, pa koraci koji u opisu sadrže riječi poput „pada” (iz upute za provjeru) ili „usporedi” (usklađivanje s inačicom) dobivaju krive prijedloge kao što su `bug-fix` i `research`. Kad REGOČ čita prijedlog tijeka, gleda samo odluku za izvorni nalog. Odluke za zadatke koji već imaju izvršitelja i vezu `blockedBy` unutar istog lanca zanemaruje. Ispravak vrata predložen je u dizajnu `docs/DIZAJN-karta-sustava-v2.md`, u odjeljku 7.

## Kad nijedan tijek ne odgovara
Neodlučeno uvijek znači rad bez tijeka. Tijek od četiri koraka za posao od deset minuta košta više nego što donosi. Ako posao ipak traži više struka, a nijedan tijek ga ne opisuje, REGOČ slaže lanac ručno prema pravilu 25 iz `CLAUDE.md` i u bilješci zapiše koji tijek nedostaje. Ti zapisi su ulaz za nove tijekove u katalogu, a o uvrštenju tijeka odlučuje vlasnik.

## Što REGOČ ne radi
REGOČ ne mijenja prekidač vrata tijeka (`nacin` i `materijalizacija` u `config/workflow-gate.json`) ni polje `enabled` tijeka na vlastitu inicijativu. To je vlasnikova odluka, donesena na temelju mjerila `tools/workflow-odluke-mjera.ts`. REGOČ ne uzima sebi korak koji traži struku drugog agenta, jer `assignee: regoc` nije zamjena za delegiranje.
