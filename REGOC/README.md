# REGOČ — sustav agenata izgrađen oko TaskManagera

Ovaj dokument opisuje sustav iz kojega je TaskManagerAI izvučen. **Nije potreban za rad
TaskManagera** — tu je zato što je najkorisnije objašnjenje što se s upraviteljem zadataka može
napraviti kad ga postaviš u središte, umjesto da ti bude popis obveza sa strane.

Sve što slijedi opisuje kako sustav radi, ne kako je konfiguriran. Adrese, ključevi, imena
skupina i lozinke namjerno izostaju.

---

## Sadržaj

1. [Odakle je krenulo — PAI](#1-odakle-je-krenulo--pai)
2. [Ime i osnovna zamisao](#2-ime-i-osnovna-zamisao)
3. [Arhitektura u slojevima](#3-arhitektura-u-slojevima)
4. [Tim](#4-tim)
5. [Demon — dio koji radi kad nitko ne gleda](#5-demon--dio-koji-radi-kad-nitko-ne-gleda)
6. [Usmjeravanje poruka](#6-usmjeravanje-poruka)
7. [Sjednice u pozadini](#7-sjednice-u-pozadini)
8. [TaskManager kao središte](#8-taskmanager-kao-središte)
9. [Izbor modela](#9-izbor-modela)
10. [Kontekst, vještine i kuke](#10-kontekst-vještine-i-kuke)
11. [Pamćenje i znanje](#11-pamćenje-i-znanje)
12. [Kočnice i autonomija](#12-kočnice-i-autonomija)
13. [Provjere prije nego što se nešto proglasi gotovim](#13-provjere-prije-nego-što-se-nešto-proglasi-gotovim)
14. [Servisi](#14-servisi)
15. [Mreža čvorova](#15-mreža-čvorova)
16. [Naučene lekcije](#16-naučene-lekcije)
17. [Što od ovoga treba tebi](#17-što-od-ovoga-treba-tebi)
18. [Zahvale](#18-zahvale)

---

## 1. Odakle je krenulo — PAI

REGOČ nije nastao na praznom papiru. Temelj je **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**
Daniela Miesslera (MIT licencija), i to nije usputna inspiracija nego okvir u kojem sustav i
danas radi.

**Što je PAI dao:**

- **Zamisao osobne infrastrukture.** Pomoćnik nije usluga na koju se prijaviš nego sustav koji
  držiš kod sebe, konfiguriraš ga i znaš što radi. Podatci ostaju tvoji.
- **Vještine (*skills*).** Znanje spakirano u mape s uputama koje se učitavaju kad zatrebaju —
  za pisanje dokumenata, za istraživanje, za rad s PDF-om, za ispravljanje pogrešaka. Kod nas
  ih je danas 45.
- **Kuke (*hooks*).** Točke u kojima se sustav umeće u tijek rada: pri pokretanju sjednice, prije
  poziva alata, nakon završetka posla. Kod nas ih je 24 i one drže sve što mora biti
  automatsko — učitavanje konteksta, provjeru sigurnosti, bilježenje ocjena, sažetak sjednice.
- **Učitavanje konteksta pri pokretanju.** Svaka sjednica počinje tako da sustav sam učita tko
  je, koja pravila vrijede i što je zadnje radio.
- **Glasovni sloj.** Odgovor se može i izgovoriti, ne samo napisati.
- **Propisani oblik odgovora.** Sažetak, analiza, poduzeto, rezultat, stanje, sljedeći korak —
  uvijek istim redom, pa se odgovor može čitati letimično.

**Što je REGOČ dodao na to:**

| PAI daje | REGOČ dodaje |
|---|---|
| jednog pomoćnika s vještinama | **tim uloga**, svaka sa svojim područjem i svojim modelom |
| razgovor kao radni prostor | **bazu zadataka kao jedini izvor istine** |
| rad na zahtjev | **demon** koji radi i kad nitko ne gleda |
| jedan model | **usmjerivač modela** — od najjačega u oblaku do lokalnoga |
| povjerenje korisniku | **kočnice** koje sustav sam sebi postavlja |
| jedan stroj | **mrežu čvorova** koji dijele posao |

Ako te zanima temelj, počni od PAI-ja. REGOČ je ono što se dogodi kad taj temelj gurneš do
višeagentnog rada s odgovornošću.

---

## 2. Ime i osnovna zamisao

REGOČ je kratica za *REsursni Gestor za Orkestraciju Članova*, ali ime je prije svega iz hrvatske
predaje — Regoč je div iz priča Ivane Brlić-Mažuranić, dobroćudan i spor, ali kad se pokrene,
pomiče brda. Ostali agenti nose imena iz istoga svijeta: Kosjenka, Jelena, Malik, Potjeh, Stribor.
To nije ukras. Ime koje nešto znači lakše se pamti i lakše se o njemu govori — „pitaj Kosjenku“
kraće je i jasnije od „pokreni arhitektonsku analizu“.

Klasičan pomoćnik radi u razgovoru: pitaš, odgovori, zaboravi. To pada na tri stvari:

1. **posao dulji od jednog odgovora** — ako se sjednica prekine, rad je izgubljen;
2. **više poslova odjednom** — jedan razgovor ne može držati pet niti;
3. **odgovornost** — nitko poslije ne zna tko je što napravio i zašto.

REGOČ na sve tri odgovara istim potezom: **posao živi u bazi, ne u razgovoru.** Razgovor je samo
način da se u bazu nešto upiše ili iz nje pročita. Padne li sjednica, zadatak i dalje stoji, s
poviješću i bilješkama, i netko ga drugi može preuzeti.

---

## 3. Arhitektura u slojevima

```
┌─────────────────────────────────────────────────────────────┐
│  KANALI        poruke · glas · web ploča · naredbeni redak  │
├─────────────────────────────────────────────────────────────┤
│  DEMON         čita poruke · usmjerava · pokreće agente      │
│                vuče posao iz reda · mjeri potrošnju          │
├─────────────────────────────────────────────────────────────┤
│  AGENTI        koordinator + specijalisti, svaki svoj model  │
├─────────────────────────────────────────────────────────────┤
│  ZNANJE        vještine · kuke · pamćenje · semantička baza  │
├─────────────────────────────────────────────────────────────┤
│  TASKMANAGER   zadatci · red · projekti · povijest promjena  │  ← jedini izvor istine
├─────────────────────────────────────────────────────────────┤
│  MODELI        oblak (jači) · lokalni (jeftini i privatni)   │
└─────────────────────────────────────────────────────────────┘
```

Strelice idu u oba smjera, ali jedno je pravilo tvrdo: **svaki sloj koji nešto radi mora to
zapisati u TaskManager.** Sloj iznad ne vjeruje pamćenju sloja ispod.

---

## 4. Tim

Umjesto jednoga sveznajućeg pomoćnika, sustav ima ulogu po poslu. Svaka ima svoju osobnost, svoje
područje i **svoj model** — jači ondje gdje treba prosuđivanje, jeftiniji ondje gdje treba brzina.

| Agent | Uloga | Što zapravo radi |
|---|---|---|
| **REGOČ** | koordinator | dijeli posao, sastavlja rezultat, ne izvršava sam |
| **Kosjenka** | arhitektica | postavlja pitanja dok zamisao ne izdrži; vodi pojmovnik i odluke |
| **Jelena** | inženjerka | piše i mijenja kod, radi po ciklusu testiraj-pa-piši |
| **Malik** | sigurnost | traži čime se ovo može zloupotrijebiti |
| **Manda** | istraživačica | čita izvore, donosi činjenice s poveznicama |
| **Dora** | analitičarka | isti problem iz više kutova, traži što svi previđaju |
| **Potjeh** | provjera kvalitete | sumnja u tuđi rad, uključujući i naš |
| **Grga** | dizajner | sučelja i vizualni jezik |
| **Gita** | vizualni sadržaj | slike, dijagrami, ilustracije |
| **Klaudio** | kanal poruka | veza s čovjekom kroz razgovor, danonoćno |
| **Stribor** | glas | govor u tekst i tekst u govor |

Uobičajen tijek posla ide **Kosjenka → Jelena → Potjeh → Malik**: prvo se zamisao izoštri, pa
napiše, pa provjeri, pa napadne. Svaki korak je zadatak u bazi, pa se poslije točno vidi gdje je
nešto zapelo — a zapinje uvijek na istom mjestu, na koraku koji je netko preskočio.

Načelo koje sve drži: **koordinator ne izvršava.** Kad REGOČ počne sam raditi posao umjesto da ga
dodijeli, sustav se pretvara u jedan dugačak razgovor i vraćamo se na početni problem. To se
dogodi lakše nego što zvuči — koordinatoru je uvijek brže napraviti sam nego objasniti.

Postoji i mehanizam koji tim slaže sam: iz opisa posla sustav zaključi koji lanac uloga treba i
otvori zadatke redom, umjesto da čovjek imenuje svakog sudionika.

---

## 5. Demon — dio koji radi kad nitko ne gleda

U pozadini stalno radi jedan proces. On je razlog zašto sustav odgovara u tri ujutro.

**Petlja izgleda ovako:**

1. **Čita dolazne poruke** iz zasebne baze poruka. Poruka može doći od čovjeka ili od agenta.
2. **Odlučuje kome pripada** (vidi sljedeće poglavlje).
3. **Pokreće agenta na zahtjev** — kao zaseban proces operacijskog sustava, s rokom i s
   ograničenjem koliko ih smije raditi istodobno.
4. **Vuče posao iz reda.** Ako nema poruka, gleda red izvršavanja koji sam okidač u bazi puni
   zadatcima prioriteta 1.
5. **Mjeri vlastitu potrošnju** i po njoj odlučuje smije li nastaviti.
6. **Pazi na zaglavljene zadatke** — onaj koji predugo stoji u radu vraća se ili se označi.

**Zašto agenti nisu stalni procesi.** Isprobali smo i to. Stalni agent zauzima memoriju dok čeka,
a kad se glavna sjednica prekine, umire zajedno s njom — i to tiho, pa nitko ne zna da posao
stoji. U razdoblju od nekoliko tjedana zabilježili smo desetke takvih tihih smrti. Pokretanje na
zahtjev znači da je svaki agent zaseban proces sa svojim životnim vijekom; ako padne, zadatak u
bazi ostaje u stanju „u radu“ i sljedeći prolaz ga može preuzeti.

Uz demon ide i **čuvar** koji ga podiže ako padne. Bez njega pad nitko ne primijeti do sljedećeg
puta kad nešto zatreba — a to zna biti i sutradan.

---

## 6. Usmjeravanje poruka

Kad poruka stigne, netko mora odlučiti čija je. To radi razvrstavanje u nekoliko koraka:

1. **Izričito imenovanje.** „Kosjenka, napravi analizu“ — ide Kosjenki.
2. **Razlika naloga i pitanja.** „Što radi Kosjenka?“ **ne** ide Kosjenki nego istraživačici, jer
   je to pitanje *o* njoj, a ne zadatak *za* nju. Prepoznaje se po upitniku i po upitnim riječima.
3. **Po području.** Bez imena, poruka ide onome čije područje pokriva — kod inženjerki,
   sigurnosno pitanje sigurnosti, istraživanje istraživačici.
4. **Rezervni put.** Ako ništa ne odgovara, poruku preuzima koordinator.

Razlika između drugoga i prvoga koraka izgleda sitno, a nije: bez nje svako spominjanje agenta
pokreće toga agenta, pa razgovor o sustavu pokreće pola sustava.

**Grupiranje poruka.** Kanali poput Telegrama dugačak tekst razbijaju na dijelove. Bez zaštite
agent na svaki dio odgovori zasebno, pa na jedno pitanje stigne sedam odgovora. Red poruka zato
skuplja sve od istog pošiljatelja unutar nekoliko sekunda i spaja ih u jednu.

---

## 7. Sjednice u pozadini

Ovo je dio koji se najčešće krivo shvati, pa vrijedi razdvojiti pojmove.

**Sjednica je nit razgovora vezana uz kanal.** Kad poruka stigne, demon ne pokreće prazan
razgovor nego **nastavlja postojeći** za taj kanal. Svaki kanal ima svoju oznaku sjednice, pa
razgovor u jednoj skupini ne zna ništa o razgovoru u drugoj. Zato možeš tjedan dana kasnije reći
„nastavi ono od jučer“ i sustav zna na što misliš.

**Sjednica traje dulje od procesa.** Proces koji odgovara na poruku živi nekoliko sekunda ili
minuta. Sjednica živi tjednima. Nakon odgovora proces nestaje, a nit ostaje zapisana i sljedeća
je poruka nastavlja.

**Prekid nije gubitak — ali samo za ono što je zapisano.** Veza prema modelu zna puknuti nasred
odgovora. Tada proces izađe s pogreškom, a sjednica ostaje čitava. Ono što je izgubljeno jest
**rad koji nije zapisan nigdje osim u razgovoru**. Jednom nam je osmominutno istraživanje nestalo
s jednim takvim prekidom, jer je usput samo čitalo, a ništa nije otvaralo. Odatle najvažnije
pravilo sustava:

> Napredak mora biti trajan: u bazi, u datoteci i u gitu. Nikada samo u glavi agenta.

**Kontekst se sažima, ne odbacuje.** Kad razgovor naraste, stariji dio se sažme i sažetak ulazi u
sljedeći prolaz. Posljedica za način rada: ono što mora preživjeti sažimanje ne smije ostati samo
u razgovoru — mora otići u zadatak, u bilješku ili u datoteku.

**Sjednica nije isto što i potrošnja.** Uz nit razgovora sustav zasebno prati koliko je kvote
potrošeno u tekućem razdoblju. Ta se dva pojma lako pomiješaju jer se oba zovu „sjednica“ — prvo
je ono što se pamti, drugo je ono što se troši. Kočnice iz 12. poglavlja gledaju drugo.

---

## 8. TaskManager kao središte

Ovo je dio zbog kojega dokument stoji u ovom repozitoriju.

**Svaki posao je zadatak.** Ne „zapamti da trebam“, nego zapis s nositeljem, prioritetom i
stanjem. Ako posla nema u bazi, posao ne postoji. Zvuči kruto dok ne izgubiš prvi veći rad.

**Stanje se mijenja odmah, ne na kraju.** Čim agent počne raditi, zadatak ide u „u radu“. Čovjek
gleda ploču i vidi tko je na čemu — zadatak koji stoji na „čeka“ dok se na njemu radi laže o
stanju sustava. Zato prijelaz iz „čeka“ ravno u „gotovo“ nije dopušten: trebaju dva koraka.

**Prioritet 1 je izvršni nalog.** Otvoriš zadatak s prioritetom 1 i okidač u bazi ga sam stavi u
red; demon ga podigne bez ijednog daljnjeg poziva. Prioritet nije samo redoslijed nego prekidač.

**Dodjela je pokretanje.** Zadatak s nositeljem znači da će taj agent biti pokrenut. Ako čovjek
posao radi sam, zadatak dodijeli koordinatoru i označi ga tako da ga nadzor ne dira.

**Zatvaranje traži dokaz.** Zadatak se ne može zatvoriti bez sažetka rezultata. Prazno zatvaranje
sustav odbija i predlaže da se zadatak označi kao blokiran uz razlog — to je namjerno, jer je
„gotovo“ bez traga isto što i „ne znam što se dogodilo“.

**Trag ostaje.** Svaka promjena polja upisuje se u povijest. Kad tri tjedna poslije pitaš zašto je
nešto ovako, odgovor je u bazi, a ne u nečijem pamćenju.

**Projekti okupljaju.** Veći posao je projekt sa specifikacijom; iz specifikacije nastaju zadatci,
a povijest specifikacije čuva se uz njih, pa se vidi kako se namjera mijenjala.

---

## 9. Izbor modela

Nijedan model nije najbolji za sve, a razlika u cijeni između najjačega i sasvim pristojnoga zna
biti deseterostruka. Zato postoji sloj koji za svaki posao bira model.

**Pravilo je da model nikad nije zapisan u kodu.** Bira ga usmjerivač, prema ulozi i prema težini
posla. To je i praktično: kad izađe nov model, mijenja se jedna postavka, a ne dvadeset mjesta.

| Vrsta posla | Kamo ide |
|---|---|
| prosudba, arhitektura, sigurnost | najjači model u oblaku |
| razgovor, kratki odgovori, kanali | srednji model, brz i jeftin |
| razvrstavanje, sažimanje, izvlačenje podataka | **lokalni model** |
| ugradbe za semantičko pretraživanje | **lokalni model** |

Lokalni modeli nisu tu samo zbog cijene nego i zbog privatnosti: ono što se ne mora poslati van,
ne šalje se van. Podržano je više dobavljača, pa se isti posao može voziti kroz različite
poslužitelje bez izmjene koda.

Uz to se mjeri **potrošnja po pozivu** — koji agent, koji zadatak, koliko žetona, koliko je to
stajalo. Bez tog mjerenja nema ni kočnica iz 12. poglavlja.

---

## 10. Kontekst, vještine i kuke

Ovo je sloj naslijeđen iz PAI-ja i najviše dorađivan.

**Kontekst pri pokretanju.** Svaka sjednica počinje učitavanjem onoga što uvijek vrijedi: tko je
sustav, koja su pravila, koji su servisi, što se nedavno radilo. Time se izbjegava trošenje
prvoga dijela svakog razgovora na objašnjavanje očitog.

**Vještine.** Znanje spakirano u mape s uputama, koje se učitavaju tek kad zatrebaju. Kod nas ih
je 45 — od pisanja dokumenata i rada s tablicama, preko istraživanja i sigurnosnih pregleda, do
usko tehničkih poput ispravljanja programske podrške za sklopovlje. Vještina se pokreće imenom, a
sustav sam prepozna kad je koja primjerena.

**Kuke.** Programi koji se izvode u točno određenom trenutku tijeka rada. Kod nas ih je 24 i one
drže sve što mora biti automatsko:

- učitavanje konteksta i pozdrav na početku sjednice;
- **provjera sigurnosti prije svakog poziva alata** — naredba koja bi ispisala tajnu ili dirnula
  zaštićenu putanju biva zaustavljena prije izvršenja;
- zapisivanje onoga što je agent proizveo, radi kasnijeg pregleda;
- bilježenje ocjena i zadovoljstva, izrečenog i naslućenog;
- sažetak sjednice na kraju;
- provjera da demon radi, pri svakom pokretanju.

Kuke su tiši dio sustava, ali onaj koji najviše sprječava. Sigurnosna provjera nekoliko nas je
puta zaustavila usred naredbe koja bi tajnu ispisala u zapisnik razgovora — a odande se više ne
briše.

---

## 11. Pamćenje i znanje

Tri su razine, i razlikuju se po tome koliko dugo žive.

**Pamćenje sjednice** živi dok traje nit razgovora. Sažima se kad naraste.

**Trajno pamćenje** su kratke datoteke, jedna činjenica po datoteci, s popisom na ulazu. Ondje
idu stvari koje vrijede i za tri mjeseca: kako je nešto postavljeno, što je korisnik tražio da se
radi drukčije, gdje je koja datoteka. Ne ide ono što se ionako vidi iz koda ili povijesti.

**Graf znanja i semantičko pretraživanje.** Bilješke, nalazi i naučene lekcije, s vezama među
njima. Uz njih ide baza ugradbi, pa se traži po smislu, a ne po riječi.

Pravilo koje se pokazalo najkorisnijim: **prije nego što kažeš „ne znam“, pretraži znanje.**
Većina pitanja koja izgledaju nova već ima odgovor od prije nekoliko mjeseci.

Drugo pravilo je o pogreškama: **ne briši, arhiviraj.** Neuspio pokušaj preimenuje se, a ne
uklanja. Izgubili smo dan rada jer je „čišćenje“ odnijelo jedini dokaz o tome što je pošlo po zlu.

---

## 12. Kočnice i autonomija

Sustav koji sam sebi dodjeljuje posao mora imati mjesto na kojem staje. Ima ih nekoliko i
namjerno se preklapaju.

**Mjerilo potrošnje.** Poseban postupak prati koliko je kvote potrošeno u tekućem razdoblju i u
tjednu. Demon ga osvježava **sam**, neovisno o agentima. Razlog je skupo naučen: dok je mjerenje
ovisilo o radu agenata, zaustavljanje agenata gasilo je i mjerilo, mjerilo bi zastarjelo, a
sustav bi zastarjelu vrijednost čitao kao „sve u redu“ i krenuo raditi punom parom. Točno u
trenutku kad je najmanje smio.

**Stupnjevi autonomije.** Prema potrošenom postotku sustav se sam spušta:

| Potrošeno | Ponašanje |
|---|---|
| ispod prvoga praga | autonomija radi, sustav sam vuče posao iz reda |
| iznad prvoga | autonomija staje, radi se zadatak po zadatak, na nalog |
| iznad drugoga | bez više agenata odjednom, traži se potvrda prije početka |
| iznad trećega | odgovara, ali ništa se ne izvršava do obnove kvote |

Uz to postoji tjedni prag: kad se prijeđe, autonomija prestaje sama vući posao. **Nalog čovjeka
prolazi kroz sve stupnjeve** — kočnica gasi samostalnost, ne odzivnost. To je važna razlika:
sustav koji prestane odgovarati djeluje pokvareno, a sustav koji prestane sam sebi davati posao
djeluje razumno.

**Načelo zatvorenih vrata.** Ako mjerenje zakaže, sustav pretpostavlja najgore i zatvara se.
Jedina je iznimka stroj na kojem mjerenje nikad nije ni radilo — ondje bi zatvaranje značilo da
se novi sustav nikad ne pokrene.

**Ručna kočnica.** Postoji i gumb: pauza globalno ili po zadatku. Pauza ne mijenja stanje
zadatka, pa se posao nastavlja točno ondje gdje je prekinut. Otkazivanje se za to **ne koristi** —
to je konačno stanje iz kojega se ne vraća.

**Ograničenje dosega.** Agent koji radi na zadatku ne smije usput dirati datoteke koje s tim
zadatkom nemaju veze. Postoji provjera koja to zaustavlja — jer je najskuplja vrsta pogreške ona
koju nitko nije tražio.

---

## 13. Provjere prije nego što se nešto proglasi gotovim

Najveći problem u radu s agentima nije pogrešan odgovor nego **uvjeren pogrešan odgovor**. Zato
postoji nekoliko provjera.

**Pet koraka prije nego što se kaže „gotovo“:** utvrdi što se točno tvrdi, pokreni to, pročitaj
ishod, usporedi s očekivanim, pa tek onda tvrdi. Preskakanje trećega koraka najčešći je uzrok
lažnog „radi“.

**Propisano stanje umjesto slobodnog opisa.** Rezultat je jedno od: gotovo, gotovo uz zadršku,
blokirano, treba mi kontekst. Slobodan opis dopušta „uglavnom je gotovo“, što ne znači ništa.

**Sumnjičar.** Zaseban prolaz koji čita tuđi rezultat i traži rupe. Kod većih zahvata bira se
više njih s različitim gledištima, jer tri ista pogleda nisu provjera nego odjek.

**Bez sklopovlja nema tvrdnje.** Ako se radi o programskoj podršci za uređaj koji nije priključen,
ishod je „treba provjeriti na sklopovlju“, a ne „popravljeno“. To je pravilo nastalo nakon niza
„popravaka“ koji nikad nisu bili ni prevedeni.

---

## 14. Servisi

Sustav je skup procesa koje jedna skripta pokreće, zaustavlja i provjerava.

| Servis | Čemu služi |
|---|---|
| **Demon** | srce sustava: poruke, usmjeravanje, pokretanje agenata, red |
| **Ploča zadataka** | web sučelje i API — ovo je TaskManagerAI |
| **Most za poruke** | veza s kanalom za razgovor, danonoćno |
| **Glasovni poslužitelj** | pretvorba teksta u govor |
| **Prepoznavanje govora** | pretvorba govora u tekst, u cijelosti lokalno |
| **Baza ugradbi** | semantičko pretraživanje znanja |
| **Lokalni modeli** | jeftini i privatni poslovi |

Provjera stanja radi tako da svaki servis odgovara na vlastitoj provjeri zdravlja, a skripta ih
redom ispituje. **Ako proces radi, to još ne znači da servis radi** — dokaz je odgovor na
provjeri, ne postojanje procesa. Naučili smo to nakon što je skripta javljala „već radi“ za
proces koji je bio ispitni ostatak, a pravi servis uopće nije slušao.

Isto vrijedi i za mrežu: odgovor na glavnoj adresi ne dokazuje da radi i utičnica za živi tijek.
Za nju treba tražiti njezin vlastiti odgovor.

---

## 15. Mreža čvorova

Sustav ne mora živjeti na jednom stroju. Postoji izvedba u kojoj se isti sustav vrti na više
manjih čvorova — prijenosno, u virtualnim strojevima — pa se posao može premjestiti bliže mjestu
gdje nastaje ili se raspodijeliti.

Za to su bila potrebna dva mehanizma:

- **Popis dopuštenih mogućnosti po čvoru.** Čvor ne dobiva sve nego samo ono što smije; širenje
  ovlasti traži odobrenje.
- **Zajednički pogled na posao.** Zadatci su i dalje u bazi, pa čvor koji preuzme posao zna gdje
  je stao onaj prije njega.

Pravilo koje ovdje vrijedi bez iznimke: **tajna ide na udaljeni stroj samo uz izričito
odobrenje.** Virtualni stroj se klonira, a s klonom se seli i sve što je u njemu.

---

## 16. Naučene lekcije

Popis je kratak jer su sve skupo plaćene.

1. **Trajnost prije brzine.** Rad koji nije zapisan izgubljen je pri prvom prekidu. Zapiši prvo,
   radi poslije.
2. **Mjerilo mora biti neovisno o onome što mjeri.** Inače prestane raditi baš kad zatreba.
3. **Ako proces radi, servis ne mora raditi.** Dokaz je odgovor, ne postojanje procesa.
4. **Ne briši, arhiviraj.** Dokaz o pogrešci vrijedi više od uredne mape.
5. **Potpisan dokument nije provjeren dokument.** Brojke treba preračunati prije potpisa.
6. **Sumnjaj u vlastiti sažetak.** Kad agent kaže da je nešto gotovo, provjeri ishod, ne tvrdnju.
7. **Imena su korisna.** Uloga s imenom i osobnošću lakše se poziva i lakše se o njoj razgovara.
8. **Kočnicu postavi prije nego što zatreba.** Poslije je uvijek skuplje.

---

## 17. Što od ovoga treba tebi

Ako gradiš vlastiti sustav, ovo je redoslijed koji bih preporučio:

1. **Postavi TaskManager i ništa više.** Otvaraj zadatke ručno tjedan dana. Vidjet ćeš kakav ti
   tijek posla zapravo treba, umjesto da ga pogađaš.
2. **Napiši jednog agenta koji vuče iz reda.** Petlja u desetak redaka: uzmi zadatak, odradi,
   zatvori. Primjer je u [docs/API.md](../docs/API.md).
3. **Tek onda dodaj drugoga.** Kad ih je više, trebat će ti usmjeravanje — i to je trenutak kad
   koordinator ima smisla, a ne prije.
4. **Postavi mjerenje potrošnje prije nego što uključiš autonomiju.** Bez brojke nemaš kočnicu,
   a bez kočnice autonomija je pitanje vremena, ne mogućnosti.
5. **Zapiši pravila koja si naučio.** Sustav bez zapisanih pravila ponavlja iste pogreške, samo
   brže.

Redoslijed nije proizvoljan. Neke smo od tih koraka radili obrnuto i svaki nas je vratio natrag.

---

## 18. Zahvale

- **[PAI — Personal AI Infrastructure](https://github.com/danielmiessler/PAI)**, Daniel Miessler
  (MIT). Temelj na kojem sve ovo stoji: zamisao osobne infrastrukture, vještine, kuke, učitavanje
  konteksta i propisani oblik odgovora.
- **[Tasks.md](https://github.com/BaldissaraMatheus/Tasks.md)**, Matheus Baldissara (MIT).
  Početna točka upravitelja zadataka i zamisao ploče koju držiš uz sebe.
- **Claude Code** kao okruženje u kojem agenti rade.

REGOČ je ono što je nastalo kad su se ta dva temelja spojila i gurnula do višeagentnog rada s
odgovornošću. Ako gradiš nešto slično, počni od njih — ušteda je mjesecima mjerljiva.
