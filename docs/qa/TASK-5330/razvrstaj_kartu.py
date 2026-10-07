#!/usr/bin/env python3
"""TASK-5330 — mjerenje karte sustava: koji je odjeljak OPĆI, koji PRIVATNI, koji UVJETAN
(ovisi o mogućnosti čvora) i koji MJESNI (putanje/adrese glavnog stroja). Samo čita.

    python3 razvrstaj_kartu.py --karta <docs/system-map> --privatno <popis izvan paketa> [--tsv] [--recenice]

Popis privatnih izraza NIJE u paketu (i on je naš podatak): redak = `kategorija<TAB>izraz`.
Na glavnom stroju gradi se iz vlastitih izvora (projekti s ploče + kratak ručni popis osoba
i klijenata) — v. ADR-0006 §4.3. Paket nosi samo OPĆE uzorke (ID projekta, chat id, uid,
IP, e-pošta, tuđi HOME) i uzorke mogućnosti.

Presuda odjeljka (prvo pravilo koje vrijedi):
  PRIVATNO   — pogodak s privatnog popisa ili opći uzorak (PRJ-, chat id, uid, e-pošta)
  UVJETNO:x  — spominje mogućnost x (rag, nextcloud, docuseal, glas, ollama, internet)
  MJESNO     — samo putanje/adrese glavnog stroja (prilagodljivo predloškom)
  OPĆE       — ništa od navedenog
Izlaz 0 uvijek (mjerenje, ne brana).
"""
import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

OPCI = {
    "projekt-id": r"\bPRJ-\d{3}\b",
    "chat-id": r"(?<![\w.])-100\d{10}\b|(?<![\w.:])-\d{10}\b",
    "uid": r"\buid:? ?\d{7,}\b|\b\d{9,10}\b(?=\)|`\))",
    "e-posta": r"[\w.+-]+@[\w-]+\.[\w.]+",
}
MJESNO = {
    "tudi-home": r"/home/[a-z_][a-z0-9_-]*",
    "ip": r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
}
MOGUCNOSTI = {
    "rag": r"\bRAG\b|rag-query|rag-store|pgvector|ChromaDB|\bkolekcij\w*|agent_[a-z]+\b",
    "nextcloud": r"Nextcloud|\bNC\b|nc\.py",
    "docuseal": r"DocuSeal",
    "glas": r"\bTTS\b|\bSTT\b|[Ww]hisper|Piper|VoiceServer|glasovn\w*",
    "ollama": r"Ollam\w*|qwen\d",
    "internet": r"GitHub|\bpush\w*|Tailscale|javn\w* (?:adres|link)\w*",
}
MOGUCNOST_IZRAZI = {"nextcloud": "nextcloud", "docuseal": "docuseal"}  # s privatnog popisa idu kao mogućnost


def ucitaj_privatno(p):
    izrazi = []
    for r in Path(p).read_text().splitlines():
        if not r.strip() or r.startswith("#") or "\t" not in r:
            continue
        kat, izraz = r.split("\t", 1)
        if izraz.strip().lower() in MOGUCNOST_IZRAZI:
            continue
        izrazi.append((kat, re.compile(r"(?<![\w-])" + re.escape(izraz.strip()))))
    return izrazi


def odjeljci(tekst):
    """(naslov, tijelo) za svaki ## odjeljak; uvod prije prvog ## = „(uvod)”."""
    dijelovi, naslov, buf = [], "(uvod)", []
    for r in tekst.splitlines():
        if r.startswith("## "):
            dijelovi.append((naslov, "\n".join(buf)))
            naslov, buf = r[3:].strip(), []
        elif not r.startswith("# "):
            buf.append(r)
    dijelovi.append((naslov, "\n".join(buf)))
    return [(n, t) for n, t in dijelovi if t.strip()]


def razvrstaj(tijelo, privatno):
    pog = Counter()
    for kat, rx in privatno:
        n = len(rx.findall(tijelo))
        if n:
            pog["priv:" + kat] += n
    for ime, rx in OPCI.items():
        n = len(re.findall(rx, tijelo))
        if n:
            pog["priv:" + ime] += n
    mog = [ime for ime, rx in MOGUCNOSTI.items() if re.search(rx, tijelo)]
    mj = [ime for ime, rx in MJESNO.items() if re.search(rx, tijelo)]
    if any(k.startswith("priv:") for k in pog):
        presuda = "PRIVATNO"
    elif mog:
        presuda = "UVJETNO:" + ",".join(mog)
    elif mj:
        presuda = "MJESNO"
    else:
        presuda = "OPĆE"
    return presuda, pog, mog


def recenice_s_pogotkom(tijelo, privatno):
    rec = re.split(r"(?<=[.!?])\s+", " ".join(tijelo.split()))
    n_priv = 0
    for s in rec:
        if any(rx.search(s) for _, rx in privatno) or any(re.search(rx, s) for rx in OPCI.values()):
            n_priv += 1
    return len(rec), n_priv


def komplet(manifest, privatno):
    """Isti popis nad teretom kompleta izvornog sustava (ADR-0006 §5.2: i kod koji ide na čvor je teret)."""
    import os
    lst = [r.split(None, 1)[1].strip().removeprefix("payload/") for r in Path(manifest).read_text().splitlines() if r.strip()]
    kat, datoteke, procitano = Counter(), [], 0
    for rel in lst:
        p = Path(os.path.expanduser("~")) / rel
        if not p.is_file():
            continue
        procitano += 1
        t = p.read_text(errors="ignore")
        c = Counter()
        for k, rx in privatno:
            c[k] += len(rx.findall(t))
        c["chat-id"] = len(re.findall(OPCI["chat-id"], t))
        if sum(c.values()):
            datoteke.append((sum(c.values()), rel))
            kat.update(+c)
    datoteke.sort(reverse=True)
    print(f"komplet: {len(lst)} u MANIFEST-u, pročitano {procitano}; s privatnim pogotkom {len(datoteke)}; "
          f"pogodaka {sum(n for n, _ in datoteke)} {dict(kat)}")
    for n, rel in datoteke:
        print(f"{n:5d}  {rel}")
    return 0


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--karta", required=True)
    a.add_argument("--privatno", required=True)
    a.add_argument("--tsv", action="store_true")
    a.add_argument("--recenice", action="store_true")
    a.add_argument("--komplet", help="MANIFEST.sha256 kompleta: broji privatne pogotke po datoteci tereta (korijen = $HOME)")
    o = a.parse_args()
    privatno = ucitaj_privatno(o.privatno)
    if o.komplet:
        return komplet(o.komplet, privatno)
    karta = Path(o.karta)
    datoteke = sorted(karta.glob("*.md")) + sorted((karta / "popis").glob("*.md"))
    po_dok = defaultdict(Counter)
    bajt = defaultdict(Counter)
    zbroj_rec = Counter()
    redci = []
    for p in datoteke:
        rel = str(p.relative_to(karta))
        for naslov, tijelo in odjeljci(p.read_text()):
            presuda, pog, mog = razvrstaj(tijelo, privatno)
            glavna = presuda.split(":")[0]
            po_dok[rel][glavna] += 1
            bajt[rel][glavna] += len(tijelo.encode())
            if o.recenice:
                n, np_ = recenice_s_pogotkom(tijelo, privatno)
                zbroj_rec[(rel, "ukupno")] += n
                zbroj_rec[(rel, "privatno")] += np_
            redci.append((rel, naslov, presuda, ",".join(f"{k[5:]}={v}" for k, v in sorted(pog.items()))))
    if o.tsv:
        print("datoteka\todjeljak\tpresuda\tpogoci")
        for r in redci:
            print("\t".join(r))
        return 0
    kat = ["OPĆE", "MJESNO", "UVJETNO", "PRIVATNO"]
    print(f"{'datoteka':44} " + " ".join(f"{k:>9}" for k in kat) + "   B priv/ukupno" + ("   rečenica priv/ukupno" if o.recenice else ""))
    uk = Counter()
    ukb = Counter()
    for rel in po_dok:
        c, b = po_dok[rel], bajt[rel]
        uk.update(c)
        ukb.update(b)
        s = f"{rel:44} " + " ".join(f"{c[k]:>9}" for k in kat) + f"   {b['PRIVATNO']:>6}/{sum(b.values()):<6}"
        if o.recenice:
            s += f"   {zbroj_rec[(rel, 'privatno')]:>4}/{zbroj_rec[(rel, 'ukupno')]:<4}"
        if rel.count("/") == 0 or c["PRIVATNO"]:
            print(s)
    print(f"{'UKUPNO (' + str(len(po_dok)) + ' datoteka, odjeljaka ' + str(sum(uk.values())) + ')':44} "
          + " ".join(f"{uk[k]:>9}" for k in kat) + f"   {ukb['PRIVATNO']:>6}/{sum(ukb.values()):<6}")
    popis = [r for r in po_dok if r.startswith("popis/")]
    pp = sum(1 for r in popis if po_dok[r]["PRIVATNO"])
    print(f"popis/: {len(popis)} datoteka, s barem jednim PRIVATNIM odjeljkom {pp} (ispisane gore)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
