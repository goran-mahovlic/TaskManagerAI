# REGOČ — sustav agenata izgrađen oko TaskManagera

Ovaj dokument opisuje sustav iz kojega je TaskManagerAI izvučen. **Nije potreban za rad
TaskManagera** — tu je zato što je najkorisnije objašnjenje što se s upraviteljem zadataka može
napraviti kad ga postaviš u središte, umjesto da ti bude popis obveza sa strane.

REGOČ je kratica za *REsursni Gestor za Orkestraciju Članova*. Ime je iz hrvatske predaje —
Regoč je div iz priča Ivane Brlić-Mažuranić, dobroćudan i spor, ali kad se pokrene, pomiče
brda. Ostali agenti nose imena iz istoga svijeta.

Sve što slijedi opisuje kako sustav radi, ne kako je konfiguriran: adrese, ključevi, imena
skupina i lozinke namjerno izostaju.

---

## 1. Osnovna zamisao

Klasičan pomoćnik s umjetnom inteligencijom radi u razgovoru: pitaš, odgovori, zaboravi. To pada
na tri stvari:

1. **posao dulji od jednog odgovora** — ako se sjednica prekine, rad je izgubljen;
2. **više poslova odjednom** — jedan razgovor ne može držati pet niti;
3. **odgovornost** — nitko poslije ne zna tko je što napravio i zašto.

REGOČ na sve tri odgovara istim potezom: **posao živi u bazi, ne u razgovoru**. Razgovor je samo
način da se u bazu nešto upiše ili iz nje pročita. Padne li sjednica, zadatak i dalje stoji, s
poviješću i bilješkama, i netko ga drugi može preuzeti.

Zato je TaskManager u središtu, a ne sa strane.

```
   čovjek                       agenti
     │                            │
     ▼                            ▼
  ┌──────────────────────────────────┐
  │        TaskManager (SQL)         │  ← jedini izvor istine
  │  zadatci · red · projekti · trag │
  └──────────────────────────────────┘
     ▲                            ▲
     │                            │
  ploča i API              demon i usmjeravanje
```

---

## 2. Tim

Umjesto jednoga sveznajućeg pomoćnika, sustav ima ulogu po poslu. Svaka ima svoju osobnost,
svoje područje i **svoj model** — jači ondje gdje treba prosuđivanje, jeftiniji ondje gdje treba
brzina.

| Agent | Uloga |
|---|---|
| **REGOČ** | koordinator; ne radi sam nego dijeli posao i sastavlja rezultat |
| **Kosjenka** | arhitektica; postavlja pitanja dok zamisao ne izdrži |
| **Jelena** | inženjerka; piše i mijenja kod |
| **Malik** | sigurnost; traži čime se ovo može zloupotrijebiti |
| **Manda** | istraživačica; čita izvore i donosi činjenice |
| **Dora** | analitičarka; gleda isti problem iz više kutova |
| **Potjeh** | provjera kvalitete; sumnja u tuđi rad, uključujući i naš |
| **Grga** i **Gita** | dizajn i vizualni sadržaj |
| **Klaudio** i **Stribor** | kanali prema čovjeku — poruke i glas |

Uobičajen tijek posla ide **Kosjenka → Jelena → Potjeh → Malik**: prvo se zamisao izoštri, pa
napiše, pa provjeri, pa napadne. Svaki korak je zadatak u bazi, pa se poslije točno vidi gdje je
nešto zapelo.

Načelo koje sve drži: **koordinator ne izvršava.** Kad REGOČ počne sam raditi posao umjesto da
ga dodijeli, sustav se pretvara u jedan dugačak razgovor i vraćamo se na početni problem.

---

## 3. Demon — dio koji radi kad nitko ne gleda

U pozadini stalno radi jedan proces. On je razlog zašto sustav odgovara u tri ujutro.

**Što radi u krug:**

1. **Čita dolazne poruke** iz zasebne baze poruka. Poruka može doći od čovjeka ili od agenta.
2. **Odlučuje kome pripada.** Prepoznaje spominje li se agent po imenu i je li riječ o nalogu
   ili o pitanju. „Kosjenka, napravi analizu“ ide Kosjenki. „Što radi Kosjenka?“ **ne** ide
   Kosjenki, nego istraživačici — jer je to pitanje o njoj, a ne zadatak za nju.
3. **Pokreće agenta na zahtjev.** Agent nije proces koji stalno visi u memoriji nego se pokrene
   kad ima posla i ugasi kad završi. Najviše tri odjednom, s rokom po pokretanju.
4. **Vuče posao iz reda.** Ako nema poruka, gleda `execution_queue` — red koji sam okidač u bazi
   puni zadatcima prioriteta 1.
5. **Mjeri vlastitu potrošnju** i po njoj odlučuje smije li uopće nastaviti (vidi 5. poglavlje).

**Zašto agenti nisu stalni procesi.** Isprobali smo i to. Stalni agent zauzima memoriju dok
čeka, a kad se glavna sjednica prekine, umire zajedno s njom — i to tiho, pa nitko ne zna da
posao stoji. Pokretanje na zahtjev znači da je svaki agent zaseban proces operacijskog sustava
sa svojim životnim vijekom; ako padne, zadatak u bazi ostaje `in_progress` i sljedeći prolaz ga
može preuzeti.

---

## 4. Sjednice — kako se pamti razgovor

Ovo je dio koji se najčešće krivo shvati, pa vrijedi razdvojiti tri pojma.

**Sjednica razgovora.** Kad poruka stigne s nekog kanala, demon ne pokreće prazan razgovor nego
**nastavlja postojeći** za taj kanal. Svaki kanal ima svoju oznaku sjednice, pa razgovor u jednoj
skupini ne zna ništa o razgovoru u drugoj. Zato možeš tjedan dana kasnije reći „nastavi ono od
jučer“ i sustav zna na što misliš.

**Prekid nije gubitak.** Ako proces padne nasred odgovora — a pada, jer mreža nije savršena —
sjednica ostaje zapisana i sljedeća poruka je nastavlja. Ono što je izgubljeno jest **rad koji
nije zapisan nigdje osim u razgovoru**. Odatle najvažnije pravilo sustava:

> Napredak mora biti trajan: u bazi, u datoteci i u gitu. Nikada samo u glavi agenta.

Naučili smo to skupo. Osmominutno istraživanje koje nije usput otvaralo zadatke nestalo je s
jednim prekidom veze. Da su zadatci otvoreni prvo, prekid bi odnio minute.

**Grupiranje poruka.** Kanali poput Telegrama dugačak tekst razbijaju na dijelove. Bez zaštite
agent na svaki dio odgovori zasebno, pa na jedno pitanje stigne sedam odgovora. Zato red poruka
skuplja sve od istog pošiljatelja unutar nekoliko sekunda i spaja ih u jednu.

---

## 5. Kočnice — zašto sustav sam sebe zaustavlja

Sustav koji sam sebi dodjeljuje posao mora imati mjesto na kojem staje. Ima ih tri.

**Mjerilo potrošnje.** Poseban zapis prati koliko je kvote potrošeno u tekućoj sjednici i u
tjednu. Demon ga osvježava sam, neovisno o agentima — jer da mjerenje ovisi o agentima, gašenje
agenata ugasilo bi i mjerilo, a upravo tada je najopasnije.

**Stupnjevi autonomije.** Prema potrošenom postotku sjednice sustav se sam spušta:

| Potrošeno | Ponašanje |
|---|---|
| ispod praga | autonomija radi, sustav sam vuče posao iz reda |
| iznad prvoga praga | autonomija staje, radi se zadatak po zadatak na nalog |
| iznad drugoga | bez više agenata odjednom, traži se potvrda prije početka |
| iznad trećega | odgovara, ali ništa se ne izvršava do obnove kvote |

Nalog čovjeka prolazi kroz sve stupnjeve — kočnica gasi **samostalnost**, ne odzivnost.

**Načelo zatvorenih vrata.** Ako mjerenje zakaže, sustav pretpostavlja najgore i zatvara se.
Jedina iznimka je stroj na kojem mjerenje nikad nije ni radilo — ondje bi zatvaranje značilo da
se novi sustav nikad ne pokrene.

**Ručna kočnica.** Postoji i gumb: pauza globalno ili po zadatku. Pauza ne mijenja stanje
zadatka, pa se posao nastavlja točno ondje gdje je prekinut. Otkazivanje se za to **ne koristi**
— to je konačno stanje iz kojega se ne vraća.

---

## 6. Servisi

Sustav je skup procesa koje jedna skripta pokreće, zaustavlja i provjerava.

| Servis | Čemu služi |
|---|---|
| **Demon** | srce sustava: poruke, usmjeravanje, pokretanje agenata, red |
| **Ploča zadataka** | web sučelje i API — ovo je TaskManagerAI |
| **Most za poruke** | veza s kanalom za razgovor |
| **Glasovni poslužitelj** | pretvorba teksta u govor za izgovorene odgovore |
| **Prepoznavanje govora** | pretvorba govora u tekst, u cijelosti lokalno |
| **Baza ugradbi** | semantičko pretraživanje znanja |
| **Lokalni modeli** | jeftini poslovi bez odlaska u oblak |

Provjera stanja radi tako da svaki servis odgovara na vlastitoj provjeri zdravlja, a skripta ih
redom ispituje. **Ako proces radi, to još ne znači da servis radi** — dokaz je odgovor na
provjeri, ne postojanje procesa. To smo naučili nakon što je skripta javljala „već radi“ za
proces koji je bio ispitni ostatak.

Uz to postoji čuvar koji demon podiže ako padne. Bez njega pad nitko ne primijeti do sljedećeg
puta kad nešto zatreba.

---

## 7. Kako se TaskManager zapravo koristi

Ovo je dio zbog kojega dokument stoji u ovom repozitoriju.

**Svaki posao je zadatak.** Ne „zapamti da trebam“, nego zapis s nositeljem, prioritetom i
stanjem. Ako posla nema u bazi, posao ne postoji.

**Stanje se mijenja odmah, ne na kraju.** Čim agent počne raditi, zadatak ide u `in_progress`.
Čovjek gleda ploču i vidi tko je na čemu — zadatak koji stoji na `pending` dok se na njemu radi
laže o stanju sustava.

**Prioritet 1 je izvršni nalog.** Otvoriš zadatak s prioritetom 1 i okidač u bazi ga sam stavi u
red; demon ga podigne bez ijednog daljnjeg poziva. Prioritet nije samo redoslijed, nego prekidač.

**Dodjela je pokretanje.** Zadatak s nositeljem znači da će taj agent biti pokrenut. Ako čovjek
posao radi sam, zadatak dodijeli koordinatoru i označi ga tako da ga nadzor ne dira.

**Trag ostaje.** Svaka promjena polja upisuje se u povijest. Kad tri tjedna poslije pitaš zašto
je nešto ovako, odgovor je u bazi, a ne u nečijem pamćenju.

**Projekti okupljaju.** Veći posao je projekt sa specifikacijom; iz specifikacije nastaju
zadatci, a povijest specifikacije čuva se uz njih.

---

## 8. Znanje

Uz zadatke stoji graf znanja: bilješke, nalazi, naučene lekcije i veze među njima. Dvije razine:

- **činjenice** — kratki zapisi vezani uz projekt ili zadatak;
- **semantičko pretraživanje** — isti zapisi u bazi ugradbi, pa se traži po smislu, ne po riječi.

Pravilo koje se pokazalo najkorisnijim: **prije nego što kažeš „ne znam“, pretraži znanje.**
Većina pitanja koja izgledaju nova već ima odgovor od prije tri mjeseca.

Drugo pravilo je o pogreškama: **ne briši, arhiviraj.** Neuspio pokušaj preimenuje se, a ne
uklanja. Izgubili smo dan rada jer je „čišćenje“ odnijelo jedini dokaz što je pošlo po zlu.

---

## 9. Što od ovoga treba tebi

Ako gradiš vlastiti sustav, ovo je redoslijed koji bih preporučio:

1. **Postavi TaskManager i ništa više.** Otvaraj zadatke ručno tjedan dana. Vidjet ćeš kakav ti
   tijek posla zapravo treba, umjesto da ga pogađaš.
2. **Napiši jednog agenta koji vuče iz reda.** Petlja u desetak redaka: uzmi zadatak, odradi,
   zatvori. Primjer je u [docs/API.md](../docs/API.md).
3. **Tek onda dodaj drugoga.** Kad ih je više, trebat će ti usmjeravanje — i to je trenutak kad
   koordinator ima smisla.
4. **Kočnicu postavi prije nego što ti zatreba.** Sustav koji sam sebi daje posao naučit će te
   zašto, ali radije nauči na tuđem trošku.

Redoslijed nije proizvoljan. Mi smo neke od tih koraka radili obrnuto i svaki nas je vratio
natrag.
