#!/usr/bin/env python3
"""rag_audit.py — pregled i tagiranje RAG korpusa po projektu.

Goran, 04.09.2026.: „provjeri na koji način smo prije koristili RAG, kako ga sada
koristimo … čišćenje RAG-a + dodavanje boljeg tagiranja - tipa po projektu?"

ŠTO RADI
  --pregled     mjeri: kolekcije, broj dokumenata, udio s projektom, koji se ključevi
                uopće koriste, koliko je probnog/šuma
  --tagiraj     dopisuje `project_id` (ključ s ploče, npr. PRJ-041) u metapodatke
                domenskih kolekcija po mapi niže; postojeći `project`/`projekt` ostaje
  --primijeni   bez toga --tagiraj samo ispisuje što bi napravio

ZAŠTO `project_id`, a ne `project`: domenske kolekcije već nose `project` kao slobodan
tekst („GateMateETH", „pdp1_port"), a `intergalaktik_sportai` čak hrvatski `projekt`.
Ni jedno se ne može spojiti s pločom. `project_id` je isti ključ kao `tasks.project_id`,
pa se RAG i TaskManager od tada mogu presjeći (trošak, zadatci i znanje istog projekta).
"""
from __future__ import annotations
import argparse, json, sys, urllib.request
from collections import Counter

BAZA = "http://192.168.10.200:18765/api/v2/tenants/default_tenant/databases/default_database/collections"

# Kolekcija → ključ projekta na ploči. Samo dokazane veze; nepoznato se ne pogađa.
MAPA = {
    "cubes": "CUBES_2026", "emc": "REGOC_EMC", "dribler": "PRJ-021", "gladius": "PRJ-018",
    "regoc_mobile": "PRJ-032", "ulx5m-gs-ethernet": "ULX5M", "ulx5m_serdes": "PRJ-051",
    "pcie": "PRJ-051", "kinemotion": "PRJ-045", "presa": "PRJ-036", "magaphone": "PRJ-037",
    "igor": "PRJ-027", "voice_tts": "PRJ-035", "certifikat_prompting": "PRJ-031",
    "hrvatski_pravopis": "PRJ-050", "lifeos_research": "PRJ-059",
    "intergalaktik_sportai": "PRJ-034", "regoc_system_sesija": "REGOC_SYSTEM",
    "agent_manda": "REGOC_SYSTEM", "agent_jelena": "REGOC_SYSTEM",
    "agent_grga": "REGOC_SYSTEM", "agent_emard": "REGOC_SYSTEM",
}
# `pai_learning_system` nema svoju temu — u njemu su dokumenti SVIH projekata, a pripadnost
# nosi slobodan `project`/`domain` (npr. „fpg1_port", „sensorberg_emc"). Ova mapa te vrijednosti
# svodi na ključ s ploče. Vrijednosti koje nisu ovdje ostaju netagirane — ne pogađa se.
VRIJEDNOSTI = {
    "FAST-TRACK-SIM": "FAST-TRACK-SIM", "FTSIM": "FAST-TRACK-SIM", "ftsim": "FAST-TRACK-SIM",
    "REGOC": "REGOC_SYSTEM", "regoc": "REGOC_SYSTEM", "REGOC_v4.4.0": "REGOC_SYSTEM",
    "regoc_zod": "REGOC_SYSTEM", "PAI": "REGOC_SYSTEM", "taskmanagermd": "PRJ-001",
    "anthropic_skills_integration": "REGOC_SYSTEM", "pai_statusline_enhancement": "REGOC_SYSTEM",
    "gladius_app": "PRJ-018", "gladius": "PRJ-018",
    "port_fpg1": "PRJ-003", "fpg1_port": "PRJ-003", "fpga_pdp1": "PRJ-003",
    "fpga_pdp1_port": "PRJ-003", "pdp1_port": "PRJ-003", "PDP-1": "PRJ-003", "pdp1": "PRJ-003",
    "ulx3s": "PRJ-057", "RU2024_ULX4M": "INTERGALAKTIK",
    "GateMateETH": "GATEMATE_ETH", "gatemate": "GATEMATE_ETH",
    "sensorberg_emc": "PRJ-052", "emc": "REGOC_EMC",
    "cubes_2026": "CUBES_2026", "cubes": "CUBES_2026",
    "dribler": "PRJ-021", "wordpress_woo": "MINIMAX", "PRJ-016": "PRJ-016",
    "REGOC_Enterprise": "PRJ-043", "ULX_PRECOM": "PRJ-042", "EU_PK1117": "PRJ-042",
    "presa_linorez": "PRJ-063", "podno_grijanje_suteren": "PRJ-064",
    "ULX-PRECOM": "PRJ-042", "REGOC_EMC": "REGOC_EMC", "emc_webapp": "EMC_WEBAPP",
    "litex-rgmii-ulx5m": "ULX5M", "teamspeak": "REGOC_SYSTEM", "regoc-visualization": "PRJ-004",
}

# Kolekcije koje su ostatak pokusa ili čisti šum — kandidati za čišćenje, ne za tagiranje.
SUMNJIVE = {"test": "prazna", "regoc_seedtest_2620": "probni zapisi (seed test TASK-2620)",
            "pai_agent_unknown": "agent bez imena", "pai_agent_Bash": "izlazi Bash poziva",
            "pai_agent_Explore": "izlazi pretraga"}


def dohvati(put: str, tijelo=None):
    if tijelo is None:
        return json.load(urllib.request.urlopen(put, timeout=60))
    req = urllib.request.Request(put, json.dumps(tijelo).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))


def kolekcije() -> dict[str, str]:
    return {c["name"]: c["id"] for c in dohvati(BAZA + "?limit=500")}


def pregled() -> int:
    kol = kolekcije()
    red = []
    for ime, cid in kol.items():
        n = dohvati(f"{BAZA}/{cid}/count")
        s_proj = s_task = 0
        kljucevi: Counter = Counter()
        if n:
            d = dohvati(f"{BAZA}/{cid}/get", {"limit": min(n, 500), "include": ["metadatas"]})
            for m in (d.get("metadatas") or []):
                for k in (m or {}):
                    kljucevi[k] += 1
                if m and "project_id" in m:
                    s_proj += 1
                if m and ("task_id" in m or "task" in m):
                    s_task += 1
        red.append((ime, n, s_proj, s_task, kljucevi))
    red.sort(key=lambda r: -r[1])
    print(f"{'KOLEKCIJA':30}{'DOK':>6}{'project_id':>11}{'task_id':>9}  napomena")
    uk = uk_proj = 0
    for ime, n, sp, st, _ in red:
        uk += n
        uk_proj += sp
        nap = SUMNJIVE.get(ime, "")
        if not nap and ime in MAPA:
            nap = f"→ {MAPA[ime]}"
        elif not nap and ime.startswith("pai_"):
            nap = "naslijeđeno iz PAI-ja (bez projekta)"
        print(f"{ime:30}{n:>6}{sp:>11}{st:>9}  {nap}")
    print(f"\nUKUPNO {uk} dokumenata · s `project_id` {uk_proj} ({100*uk_proj/max(uk,1):.1f} %)")
    prisutne_sumnjive = [ime for ime, *_ in red if ime in SUMNJIVE]
    sum_n = sum(n for ime, n, *_ in red if ime in prisutne_sumnjive)
    ocisceno = [ime for ime in SUMNJIVE if ime not in kol]
    print(f"Kandidati za čišćenje: {sum_n} dokumenata u {len(prisutne_sumnjive)} kolekcija"
          + (f" (već očišćeno: {', '.join(ocisceno)} — vidi tools/rag_archive.py --drop)" if ocisceno else ""))
    return 0


def tagiraj(primijeni: bool) -> int:
    kol = kolekcije()
    ukupno = 0
    for ime, pid in MAPA.items():
        if ime not in kol:
            continue
        cid = kol[ime]
        n = dohvati(f"{BAZA}/{cid}/count")
        if not n:
            continue
        d = dohvati(f"{BAZA}/{cid}/get", {"limit": n, "include": ["metadatas"]})
        ids = d.get("ids") or []
        metas = d.get("metadatas") or []
        novi_ids, novi_metas = [], []
        for i, m in zip(ids, metas):
            m = dict(m or {})
            if m.get("project_id") == pid:
                continue
            m["project_id"] = pid
            # `projekt` (hrvatski ključ, samo u intergalaktik_sportai) svodi se na isti pojam.
            if "projekt" in m and "project" not in m:
                m["project"] = m.pop("projekt")
            novi_ids.append(i)
            novi_metas.append(m)
        if not novi_ids:
            continue
        print(f"{ime:28} {len(novi_ids):>4} dokumenata → project_id={pid}")
        ukupno += len(novi_ids)
        if primijeni:
            for k in range(0, len(novi_ids), 100):
                dohvati(f"{BAZA}/{cid}/update",
                        {"ids": novi_ids[k:k+100], "metadatas": novi_metas[k:k+100]})
    print(f"\n{'Označeno' if primijeni else 'Bilo bi označeno'}: {ukupno} dokumenata")
    return 0


def tagiraj_vrijednosti(primijeni: bool, ime_kolekcije: str = "pai_learning_system") -> int:
    """Tagiraj dokumente MIJEŠANE kolekcije po slobodnoj vrijednosti `project`/`domain`."""
    kol = kolekcije()
    if ime_kolekcije not in kol:
        print(f"nema kolekcije {ime_kolekcije}")
        return 1
    cid = kol[ime_kolekcije]
    n = dohvati(f"{BAZA}/{cid}/count")
    d = dohvati(f"{BAZA}/{cid}/get", {"limit": n, "include": ["metadatas"]})
    ids, metas = d.get("ids") or [], d.get("metadatas") or []
    po_pid = Counter()
    novi_ids, novi_metas = [], []
    bez_mape = Counter()
    for i, m in zip(ids, metas):
        m = dict(m or {})
        if m.get("project_id"):
            continue
        v = m.get("project") or m.get("domain")
        if not v:
            continue
        pid = VRIJEDNOSTI.get(str(v))
        if not pid:
            bez_mape[str(v)] += 1
            continue
        m["project_id"] = pid
        po_pid[pid] += 1
        novi_ids.append(i)
        novi_metas.append(m)
    for pid, br in po_pid.most_common():
        print(f"  {pid:16} {br:>4} dokumenata")
    print(f"\nNemapirano (ostaje bez projekta): {sum(bez_mape.values())} dokumenata, "
          f"{len(bez_mape)} različitih oznaka; najčešće: "
          + ", ".join(f"{k}({n})" for k, n in bez_mape.most_common(8)))
    if primijeni and novi_ids:
        for k in range(0, len(novi_ids), 100):
            dohvati(f"{BAZA}/{cid}/update", {"ids": novi_ids[k:k+100], "metadatas": novi_metas[k:k+100]})
        print(f"Označeno: {len(novi_ids)} dokumenata u {ime_kolekcije}")
    elif novi_ids:
        print(f"Bilo bi označeno: {len(novi_ids)} dokumenata u {ime_kolekcije}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pregled", action="store_true")
    ap.add_argument("--tagiraj", action="store_true")
    ap.add_argument("--tagiraj-vrijednosti", action="store_true",
                    help="tagiraj pai_learning_system po slobodnoj oznaci project/domain")
    ap.add_argument("--primijeni", action="store_true")
    a = ap.parse_args()
    if a.tagiraj_vrijednosti:
        return tagiraj_vrijednosti(a.primijeni)
    if a.tagiraj:
        return tagiraj(a.primijeni)
    return pregled()


if __name__ == "__main__":
    sys.exit(main())
