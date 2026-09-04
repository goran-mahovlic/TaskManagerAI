#!/usr/bin/env python3
"""razvrstaj_pretinac.py — drugi prolaz kroz PRJ-033 Pretinac.

Goran, 04.09.2026.: „ako je sitan zadatak onda ga treba staviti u Pretinac — ali ako je
nešto kompleksnije i imali smo više zadataka, onda se za to mora otvoriti projekt."

PRAVILO: tema s TRI ili više zadataka (ili 15+ USD) dobiva projekt — postojeći ako ga ima,
inače novi. Tema s manje ostaje u Pretincu. Zbirni dnevni zadatci („[nerazvrstano] Sjednice
bez zadatka") se NE diraju: oni su zbroj više različitih tema istog dana i pripisati ih
jednom projektu značilo bi izmisliti podatak.
"""
from __future__ import annotations
import argparse, json, re, shutil, sqlite3, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

DB = Path.home() / ".claude/regoc/data/regoc.db"
PRETINAC = "PRJ-033"
PRAG_ZADATAKA = 3
PRAG_USD = 15.0

# (kljuc teme, uzorci, ciljni projekt ili None = novi, naziv i opis za novi projekt)
TEME = [
    ("muszg", [r"muszg", r"admin konzol", r"zgode", r"virtualn\w* [sš]etnj", r"turnir",
               r"dreamhost", r"cyber_?up", r"php 8", r"hosting", r"muzej sportsk",
               r"backup ture", r"martina ?n?c", r"prezentacij\w* sa novim"], "PRJ-041", None),
    ("emc", [r"^\[emc\]", r"krivulj\w* pojacal", r"rfa-30", r"litevna", r"tinysa"], "EMC_WEBAPP", None),
    ("meshtastic", [r"meshtastic", r"sensecap", r"solar node"], None,
     ("Meshtastic / LoRa solarni čvor — odabir opreme",
      "Istraživanje i nabava opreme za meshtastic mrežu (SenseCAP Solar Node P1-Pro i srodno): "
      "dostupnost u EU, cijena, može li se preprogramirati. Nastalo iz upita u REGOČ grupi 09/2026.")),
    ("bom", [r"\bbom\b", r"gaard", r"m-udivi", r"lcsc iz knjiznice"], None,
     ("BOM provjere i narudžbe (klijentski)",
      "Provjere sastavnica: part-number, opis, footprint, zalihe (Mouser/LCSC) i priprema XLS-a za "
      "narudžbu. Klijentski poslovi koji nisu vezani uz jednu ploču.")),
    ("dijelovi", [r"i2c expander", r"tca9536", r"usporedn\w* tablic", r"4 bitni"], "PRJ-058", None),
    ("eu", [r"eu projekt", r"3 ponude", r"dokumentacij\w* .*prijav", r"\bnkd\b",
            r"pretežit\w* djelatnost"], "PRJ-042", None),
    ("regoc", [r"keepalive", r"claude --print", r"adr-001", r"broja redaka", r"implementacija:"],
     "REGOC_SYSTEM", None),
]


def novi_id(con) -> str:
    zauzeti = [int(m.group(1)) for (i,) in con.execute("SELECT id FROM projects")
               if (m := re.match(r"PRJ-(\d+)$", i))]
    return f"PRJ-{max(zauzeti) + 1:03d}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--primijeni", action="store_true")
    a = ap.parse_args()
    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row

    zadatci = con.execute(f"""
        SELECT t.id, t.title, COALESCE(t.description,'') opis,
               ROUND(COALESCE((SELECT SUM(c.cost_usd) FROM cost_log c WHERE c.task_id=t.id),0),4) usd
          FROM tasks t WHERE t.project_id = '{PRETINAC}'
           AND t.title NOT LIKE '[nerazvrstano]%'""").fetchall()

    grupe: dict[str, list] = defaultdict(list)
    ostatak = []
    for t in zadatci:
        tekst = f"{t['title']} {t['opis']}".lower()
        for kljuc, uzorci, cilj, novi in TEME:
            if any(re.search(u, tekst, re.IGNORECASE) for u in uzorci):
                grupe[kljuc].append(t)
                break
        else:
            ostatak.append(t)

    print(f"Pretinac: {len(zadatci)} zadataka (bez zbirnih) · "
          f"{sum(t['usd'] for t in zadatci):.2f} USD\n")
    odluke = []
    for kljuc, uzorci, cilj, novi in TEME:
        red = grupe.get(kljuc, [])
        if not red:
            continue
        usd = sum(t["usd"] for t in red)
        # Prag vrijedi samo za OTVARANJE novog projekta. Kad projekt već postoji, držati
        # zadatke u Pretincu nema svrhe — ništa se ne otvara, a mjesto im je poznato.
        dovoljno = cilj is not None or len(red) >= PRAG_ZADATAKA or usd >= PRAG_USD
        gdje = cilj or (f"NOVI: {novi[0]}" if novi else "—")
        print(f"{kljuc:12} {len(red):>3} zadataka · {usd:7.2f} USD → "
              f"{gdje if dovoljno else 'ostaje u Pretincu (premalo)'}")
        for t in red[:4]:
            print(f"    {t['id']} {t['usd']:6.2f}  {t['title'][:74]}")
        if len(red) > 4:
            print(f"    … i još {len(red)-4}")
        if dovoljno:
            odluke.append((kljuc, red, cilj, novi))
    # Nasljeđivanje po sjednici: zadatak bez ključne riječi, ali iz ISTE telegramske sjednice
    # kao već razvrstani zadatci, ide za većinom. („nastavi sada", „dohvati slike" i slično
    # nemaju vlastiti trag, ali pripadaju razgovoru koji ga ima.)
    sesija_re = re.compile(r"\[uvoz:telegram segment=([0-9a-f-]+)#")
    po_sesiji: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for kljuc, red, *_ in [(k, grupe[k], None, None) for k in grupe]:
        for t in red:
            m = sesija_re.search(t["opis"])
            if m:
                po_sesiji[m.group(1)][kljuc] += 1
    # + sjednice zadataka koji su VEĆ na nekom projektu izvan Pretinca
    for r in con.execute("""SELECT project_id, description FROM tasks
                             WHERE created_by='telegram' AND project_id NOT IN ('PRJ-033')"""):
        m = sesija_re.search(r["description"] or "")
        if m:
            po_sesiji[m.group(1)]["→" + r["project_id"]] += 1

    naslijedjeni: dict[str, list] = defaultdict(list)
    jos_ostaje = []
    for t in ostatak:
        m = sesija_re.search(t["opis"])
        glasovi = po_sesiji.get(m.group(1)) if m else None
        if glasovi:
            pobjednik = max(glasovi.items(), key=lambda kv: kv[1])[0]
            naslijedjeni[pobjednik].append(t)
        else:
            jos_ostaje.append(t)
    if naslijedjeni:
        print("\nnasljeđivanje po sjednici (isti razgovor, bez vlastite ključne riječi):")
        for kljuc, red in sorted(naslijedjeni.items(), key=lambda kv: -len(kv[1])):
            usd = sum(t["usd"] for t in red)
            print(f"  {kljuc:16} {len(red):>3} zadataka · {usd:7.2f} USD")
    ostatak = jos_ostaje

    print(f"\nostaje u Pretincu: {len(ostatak)} zadataka · {sum(t['usd'] for t in ostatak):.2f} USD")
    for t in ostatak[:10]:
        print(f"    {t['id']} {t['usd']:6.2f}  {t['title'][:74]}")
    if len(ostatak) > 10:
        print(f"    … i još {len(ostatak)-10}")

    # Naslijeđene pridruži njihovoj temi/projektu (samo ako tema ide u projekt).
    for kljuc, red in naslijedjeni.items():
        if kljuc.startswith("→"):
            odluke.append((f"sjednica{kljuc}", red, kljuc[1:], None))
            continue
        for i, (k, r2, cilj2, novi2) in enumerate(odluke):
            if k == kljuc:
                odluke[i] = (k, r2 + red, cilj2, novi2)
                break

    if not a.primijeni:
        con.close()
        return 0

    pricuva = DB.with_name(f"regoc.db.pricuva-pretinac-{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    shutil.copy2(DB, pricuva)
    print(f"\nPričuva: {pricuva}")
    with con:
        for kljuc, red, cilj, novi in odluke:
            pid = cilj
            if pid is None:
                red_p = con.execute("SELECT id FROM projects WHERE name = ?", (novi[0],)).fetchone()
                if red_p:
                    pid = red_p[0]
                else:
                    pid = novi_id(con)
                    con.execute("""INSERT INTO projects (id,name,description,status,priority,lead_agent,
                                        created_at,updated_at,tags,metadata)
                                   VALUES (?,?,?,'active',3,'manda',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,'{}')""",
                                (pid, novi[0], novi[1], json.dumps(["iz-pretinca"], ensure_ascii=False)))
                    print(f"  kreiran {pid}  {novi[0]}")
            ids = [t["id"] for t in red]
            up = ",".join("?" * len(ids))
            con.execute(f"UPDATE tasks SET project_id=?, updated_at=CURRENT_TIMESTAMP WHERE id IN ({up})", [pid] + ids)
            con.execute(f"UPDATE cost_log SET project_id=? WHERE task_id IN ({up})", [pid] + ids)
            print(f"  {pid} ← {len(ids)} zadataka ({kljuc})")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
