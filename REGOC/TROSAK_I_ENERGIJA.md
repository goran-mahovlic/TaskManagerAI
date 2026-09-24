# Trošak i energija

[English](TROSAK_I_ENERGIJA.en.md) · [Natrag na pregled](README.md)

Bez mjerenja potrošnje nema kočnica, a bez pripisa potrošnje projektu nema odgovora na pitanje
„koliko nas je ovo stajalo". Ovaj dokument opisuje oboje, i procjenu struje, CO₂ i vode koja se
na trošak nadovezuje — uz iskreno objašnjenje zašto je ta procjena pretvorba jedinice, a ne
novo mjerilo.

---

## Trošak po projektu

### Izvori

| Izvor | Što daje | Napomena |
|---|---|---|
| **zapis izvođača** (`cost_log`) | jedan redak po pozivu: agent, zadatak, model, tokeni po razredu, cijena | kad CLI modela sam javi cijenu, to je mjerenje i ima prednost pred tarifom |
| **transkripti sjednica** (`tools/run_tokens.py`) | tokeni i cijena iz zapisa svake sjednice | pokriva i rad koji nije prošao kroz izvođača |
| **cjenik** (`src/core/CostTracker.ts`) | procjena kad mjerenja nema | isti cjenik u oba alata, da ista potrošnja nema dvije cijene |

Tokeni se bilježe **po razredu** (ulaz, izlaz, čitanje iz predmemorije, upis u predmemoriju),
jer je predmemorija oko 96 % prometa i cijena razreda razlikuje se i do 50 puta.

### Pripis zadatak → projekt

Trošak se na projekt penje **spajanjem** `cost_log.task_id → tasks.project_id`, a ne kopijom
projekta u redak troška. Kopija bi se zamrznula u trenutku spawna: kad zadatak kasnije dobije
projekt, stari bi retci ostali krivi zauvijek. Spajanje se samo ispravlja.

Mjereno u izvornom sustavu: **97 % troška** stiže do projekta tim putem. Ostatak su sjednice
bez ID-a zadatka (3 %) i zadatci kojih nema u bazi (0,004 %).

**Nepripisano je vlastiti redak**, ravnopravan s projektima — nikad se ne razmazuje po
projektima proporcionalno. Razmazivanje izmišlja trošak: projekt dobije novac koji nitko nije
potrošio na njega, a brojka se mijenja svaki put kad nastane nov projekt. Vidljiv redak
„nepripisano" je i mjerilo kvalitete pripisa: naraste li iznad desetak posto, pokvario se
prompt koji agentu daje ID zadatka.

**U paketu:** `GET /api/projects/trosak`, kartica projekta na ploči. Trošak (što je rad
stajao) i vrijednost po cjeniku (`tools/vrijednost_inputa.py`) su dvije brojke u dva stupca —
nikad zbrojene.

---

## Struja, CO₂ i voda — procjena s rasponom

Davatelji modela **ne objavljuju** potrošnju po upitu. Postoje samo javne procjene različite
kakvoće: jedno produkcijsko mjerenje jednog davatelja, modeli izvedeni iz sklopovlja, i
izvedenice iz javnih mjerenja latencije. Sve se razlikuju i do reda veličine.

### Formula po razredu tokena

```
E [Wh] = k(model) × ( ulaz·c_ulaz + izlaz·c_izlaz + čitanje·c_čit + upis·c_upis ) / 10⁶
```

Naivna formula `(ulaz + izlaz) × faktor` odbačena je mjerenjem: vidi samo **13,7 %** energije,
jer zanemaruje predmemoriju koja nosi 96 % prometa — **podcjenjuje 7,3 puta**.

| Razred tokena | Wh po milijunu (središnja vrijednost) |
|---|---|
| ulaz | 390 |
| izlaz | 1 950 |
| čitanje iz predmemorije | 39 |
| upis u predmemoriju | 490 |

`k(model)` je omjer cijene ulaza prema srednjem razredu modela (npr. ≈ 1,67 za veći razred,
1,00 za srednji, ≈ 0,33 za najmanji). Nepoznat model dobiva `k = 1` **i zastavicu**, nikad
tihu nulu.

### Raspon se prikazuje uvijek

| Veličina | Faktor | Pojas nesigurnosti |
|---|---|---|
| energija | formula gore | **÷3 … ×3** |
| CO₂e | 0,21 kg/kWh (prosjek mreže EU-27) | **÷4 … ×4** |
| voda | 1,1 L/kWh (produkcijsko mjerenje na licu mjesta) | **÷10 … ×6** |

Uži pojas bio bi laž, širi bi brojku učinio beskorisnom. Primjer iz izvornog sustava, sto dana
rada: **579 kWh (193 – 1 737)**, **122 kg CO₂e (30 – 487)**, **637 L vode (64 – 3 823)**.

Voda ima najširi i nesimetričan pojas, i jače upozorenje u prikazu: objavljene vrijednosti
razlikuju se oko 50 puta, granica obračuna nije dogovorena (samo podatkovni centar ili i
proizvodnja struje), a regija u kojoj je upit poslužen nije poznata.

### Zašto je to pretvorba jedinice, a ne novo mjerilo

Koeficijenti razreda tokena preuzeti su iz omjera **cjenika** (izlaz 5× ulaz, čitanje 0,1×…),
a `k(model)` je isti cjenik po drugoj osi. Posljedica je algebarska, ne empirijska:

```
390 / 3  =  1950 / 15  =  39 / 0,3  =  130 Wh po dolaru cjeničkog troška
```

Energija je **trošak pomnožen konstantom**. Poredak projekata po energiji identičan je poretku
po trošku (10 od 10), a CO₂ i voda su samo pretvorba te pretvorbe. Nijedna od tih brojki ne
nosi **nijedan bit** informacije koji trošak u eurima već nema.

Zašto se onda prikazuju: jer „579 kWh ≈ dva mjeseca prosječnog kućanstva" čovjeku znači nešto
što iznos u eurima ne znači. Ali prikaz mora to reći naglas:

- znak `≈` uz svaku brojku,
- vlastita boja koja na ploči znači „nije izmjereno",
- riječ „procjena" u vidljivom tekstu, ne samo u opisu pri prelasku mišem,
- metoda i raspon u objašnjenju.

Brojka s vlastitim sadržajem traži drugi fizikalni temelj — snagu × trajanje, ili stvarno
mjerenje lokalnog modela na vlastitom sklopovlju. Nijedan izbor koeficijenata izveden iz
cjenika to ne može postići; to je svojstvo izvora, ne podešavanja.

**U paketu:** trošak po projektu postoji; procjena energije je u izvornom sustavu i u paket
dolazi kao zaseban modul s koeficijentima u konfiguraciji, ne u kodu.

Vidi i: [BAZE.md](BAZE.md) · [VRATA_I_KOCNICE.md](VRATA_I_KOCNICE.md)
