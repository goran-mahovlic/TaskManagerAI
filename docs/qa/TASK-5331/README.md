# TASK-5331 — izvedba ADR-0006 na node-A: mjerenja (07.10.2026.)

Privatni popis NIJE u paketu (`~/.claude/regoc/deploy/profili/privatno.popis` na glavnom stroju, 0600).

## Curenje (recall po izrazu s privatnog popisa, `mjeri_curenje.ts`)

Izuzeti su `PRJ-001`, `PRJ-002`, `PRJ-033` — te ID-eve ploča node-A ima i SAMA (svoji projekti).

| Banka | Upita | Izraza s privatnom činjenicom | Po kategoriji |
|---|---|---|---|
| `regoc_opus_nodea` (stara, sada ARHIVA) | 90 | **89** (229 rezultata) | projekt 66/67, klijent 10/10, osoba 4/4, usluga 9/9 |
| `cvor_node_a` (nova), prvo mjerenje | 90 | 3 | osoba 2, usluga 1 — sve iz razgovora grupe 06.10. (bot je tada radio sa starom bankom) |
| `cvor_node_a` nakon `ZNANJE_RAZGOVOR_OD` i brisanja tog dana | 90 | **0** | 0/67, 0/10, 0/4, 0/9 |

```
bun docs/qa/TASK-5331/mjeri_curenje.ts --privatno <popis> --banka cvor_node_a --iskljuci PRJ-001,PRJ-002,PRJ-033
```

## Izolacija (s node-A, kroz tunel → posrednik 127.0.0.1:17795)

| Zahtjev | HTTP |
|---|---|
| `GET /v1/default/banks` | 200, samo `["cvor_node_a"]` |
| recall `regoc_sustav_opus` (naša glavna) | 403 |
| recall `regoc_opus_nodea` (stara) | 403 |
| recall `cvor_node_a` | 200 |
| `POST …/webhooks`, `…/clone`, `DELETE` tuđe banke | 403 |

## Banka čvora

* 88 dokumenata: 81 `sustav/*` (opći korpus iz paketa, render: rag=false) + 7 `cvor/*` (agenti, projekti,
  stanje, 4 zatvorena zadatka). 2 zadatka preskočena (oblik tajne u punom rezultatu).
* Drugi prolaz (`regoc-znanje.service`): `novo 0, promijenjeno 0, nestalo 0, isto 88` (Z4).
* Primjeri recalla: „Ima li ovaj čvor RAG?" → „Na čvoru node-A RAG NIJE uključen … memorija je samo
  Hindsight banka `cvor_node_a`"; „Koji su projekti?" → PRJ-001/002/033 node-A.
* Trošak prvog upisa: sesija Opusa 24 % → 50 % (retain ≈ 88 dokumenata, ≈ 140 KB).

## Profil na živom node-A

`profil-cvora.ts provjeri --modul …`: `[memorija] 9/9 OK` (izolacija, nikadNeNosi), `[mogucnosti] 1/1 OK`,
`[znanje] 2/2 OK` (banka, timer `regoc-znanje.timer` svakih 30 min).
