#!/usr/bin/env python3
"""razvrstaj_prijave.py — svaka prijava (natječaj/javni poziv) dobiva svoj projekt.

Goran, 04.09.2026.: „svaka nova EU prijava bi morala imati svoj projekt … one moraju biti
odvojene kao projekt … preseli zadatke na te pojedinačne projekte uz kalkulaciju cijene."

Pravilo je namjerno usko: zadatak se seli SAMO ako ga veže dokaz (ključna riječ iz poziva,
broj poziva, obrazac) ili ako pada u vremenski prozor jedne prijave U ISTOJ grupi. Sve
ostalo ostaje gdje jest — bolje neraspoređeno nego krivo raspoređeno.

    python3 tools/razvrstaj_prijave.py            # proba: samo ispiši
    python3 tools/razvrstaj_prijave.py --primijeni
"""
from __future__ import annotations
import argparse, json, re, shutil, sqlite3, sys
from datetime import datetime
from pathlib import Path

DB = Path.home() / ".claude/regoc/data/regoc.db"

# Svaka prijava: (kljuc, naziv, opis, jaki uzorci, prozor od, prozor do, grupa)
PRIJAVE = [
    {
        "kljuc": "SPORTOMAT",
        "naziv": "Sportomat — javni poziv Grada Zagreba (potpore male vrijednosti, otvoreni podatci)",
        "opis": ("Prijava na Javni poziv Grada Zagreba za dodjelu potpora male vrijednosti "
                 "(zagreb.hr/…/222429, raspisan 01.09.2026.). Nositelj: EN GARDE d.o.o. "
                 "Predmet: „Sportomat\" — platforma koja koristi otvorene podatke Grada Zagreba. "
                 "Prijava poslana 03.09.2026. Voditeljica: Martina (grupa IntergalaktikSportAI)."),
        "uzorci": [r"222429", r"potpora?\w* male vrijednosti", r"sportomat", r"prilog ?3\b",
                   r"prilog ?8\b", r"fina\.hr", r"porezne uprave"],
        "od": "2026-09-01T00:00", "do": "2026-09-03T12:50",
        # Dokaz vrijedi SAMO unutar razdoblja prijave: „otvoreni podatci" i „matchmaking" se
        # pojavljuju i u starijem radu na OpenSport Mapu i na MUSZG stranici, pa bi bez ove
        # ograde povukli tuđe zadatke (izmjereno u probi: 17.08. i 29.08. neispravno uhvaćeni).
        "dokaz_od": "2026-08-31T00:00", "grupa": "SportAI",
    },
    {
        "kljuc": "KULTURA-BASTINA",
        "naziv": "Javne potrebe u kulturi Grada Zagreba 2027.–2029. — digitalna baština (MUSZG)",
        "opis": ("Prijava na Javni poziv za predlaganje programa javnih potreba u kulturi Grada "
                 "Zagreba (zagreb.hr/…/222160, upute …/222161), podprogram „interdisciplinarni i "
                 "eksperimentalni umjetnički projekti\", višegodišnje financiranje 2027.–2029. "
                 "Predmet: digitalna baština MUSZG (zgode, velikani, predmeti koji ožive, "
                 "matchmaking alat za nastavu). U pripremi od 03.09.2026. Voditeljica: Martina."),
        "uzorci": [r"222160", r"222161", r"interdisciplinarn", r"javnih potreba u kulturi",
                   r"urbane kulture", r"digitaln\w* baštin", r"muzej susjedstva", r"trešnjevk"],
        "od": "2026-09-03T12:50", "do": "2026-12-31T23:59",
        "dokaz_od": "2026-09-03T00:00", "grupa": "SportAI",
    },
]


def spoji(con, kljuc: str) -> str:
    """→ id projekta; stvara ga ako ne postoji (sljedeći slobodan PRJ-NNN)."""
    red = con.execute("SELECT id FROM projects WHERE name = ?", (kljuc["naziv"],)).fetchone()
    if red:
        return red[0]
    zauzeti = [int(m.group(1)) for (i,) in con.execute("SELECT id FROM projects")
               if (m := re.match(r"PRJ-(\d+)$", i))]
    novi = f"PRJ-{max(zauzeti) + 1:03d}"
    con.execute("""INSERT INTO projects (id,name,description,status,priority,lead_agent,
                                         created_at,updated_at,tags,metadata)
                   VALUES (?,?,?,'active',2,'manda',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,'{}')""",
                (novi, kljuc["naziv"], kljuc["opis"], json.dumps(["prijava", "natjecaj"], ensure_ascii=False)))
    return novi


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--primijeni", action="store_true")
    a = ap.parse_args()
    con = sqlite3.connect(str(DB))
    con.row_factory = sqlite3.Row

    zadatci = con.execute("""SELECT id, title, description, project_id, created_at, tags
                               FROM tasks WHERE created_by IN ('telegram','uvoz','user','goran')""").fetchall()
    plan: dict[str, list] = {p["kljuc"]: [] for p in PRIJAVE}
    for t in zadatci:
        tekst = f"{t['title']} {t['description'] or ''}".lower()
        grupa = "SportAI" if "grupa:SportAI" in (t["tags"] or "") else "REGOČ"
        for p in PRIJAVE:
            jak = (any(re.search(u, tekst, re.IGNORECASE) for u in p["uzorci"])
                   and (t["created_at"] or "") >= p["dokaz_od"] and (t["created_at"] or "") <= p["do"])
            u_prozoru = (grupa == p["grupa"] and p["od"] <= (t["created_at"] or "") <= p["do"])
            if jak or u_prozoru:
                plan[p["kljuc"]].append((t["id"], t["project_id"], t["title"][:70], "dokaz" if jak else "prozor"))
                break

    trosak = {}
    for kljuc, redci in plan.items():
        if not redci:
            continue
        ids = [r[0] for r in redci]
        upitnici = ",".join("?" * len(ids))
        usd = con.execute(f"SELECT COALESCE(SUM(cost_usd),0) FROM cost_log WHERE task_id IN ({upitnici})", ids).fetchone()[0]
        trosak[kljuc] = usd
        print(f"\n═══ {kljuc}: {len(redci)} zadataka · {usd:.2f} USD ═══")
        for tid, stari, naslov, kako in redci[:12]:
            print(f"  {tid} ({stari or '-':>12} → novi) [{kako}] {naslov}")
        if len(redci) > 12:
            print(f"  … i još {len(redci)-12}")

    if not a.primijeni:
        con.close()
        return 0

    pricuva = DB.with_name(f"regoc.db.pricuva-prijave-{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    shutil.copy2(DB, pricuva)
    print(f"\nPričuva: {pricuva}")
    with con:
        for p in PRIJAVE:
            redci = plan[p["kljuc"]]
            if not redci:
                continue
            pid = spoji(con, p)
            ids = [r[0] for r in redci]
            upitnici = ",".join("?" * len(ids))
            con.execute(f"UPDATE tasks SET project_id=?, updated_at=CURRENT_TIMESTAMP WHERE id IN ({upitnici})",
                        [pid] + ids)
            con.execute(f"UPDATE cost_log SET project_id=? WHERE task_id IN ({upitnici})", [pid] + ids)
            print(f"{pid}  {p['naziv'][:60]} ← {len(ids)} zadataka, {trosak.get(p['kljuc'],0):.2f} USD")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
