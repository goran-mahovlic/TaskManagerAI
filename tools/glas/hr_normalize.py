"""hr_normalize.py — deterministički normalizator hrvatskog teksta za čitač (TTS sloj 1).

Pretvara ono što čitač ne zna pročitati (brojke, nadnevke, kratice, %, €, interne oznake)
u izgovorne riječi. Samo pravila, bez modela: obavijest ne smije čekati LLM.
Primjeri pravila su u tests/test_hr_normalize.py.

API:
    normaliziraj(tekst) -> str            # cijeli sloj 1
    podijeli(tekst) -> list[list[str]]    # odlomci → rečenice (za sintezu po rečenicama)
    broj(n), redni(n, padez, rod)         # brojke → riječi
"""
from __future__ import annotations

import re

# ── brojevi ──────────────────────────────────────────────────────────────────

_JEDINICE = ["nula", "jedan", "dva", "tri", "četiri", "pet", "šest", "sedam", "osam", "devet",
             "deset", "jedanaest", "dvanaest", "trinaest", "četrnaest", "petnaest", "šesnaest",
             "sedamnaest", "osamnaest", "devetnaest"]
_DESETICE = ["", "", "dvadeset", "trideset", "četrdeset", "pedeset", "šezdeset", "sedamdeset",
             "osamdeset", "devedeset"]
_STOTICE = ["", "sto", "dvjesto", "tristo", "četiristo", "petsto", "šeststo", "sedamsto",
            "osamsto", "devetsto"]

_REDNI_JED = ["", "prv", "drug", "treć", "četvrt", "pet", "šest", "sedm", "osm", "devet", "deset",
              "jedanaest", "dvanaest", "trinaest", "četrnaest", "petnaest", "šesnaest",
              "sedamnaest", "osamnaest", "devetnaest"]
_REDNI_DES = ["", "", "dvadeset", "trideset", "četrdeset", "pedeset", "šezdeset", "sedamdeset",
              "osamdeset", "devedeset"]
_REDNI_STO = ["", "stot", "dvjestot", "tristot", "četiristot", "petstot", "šeststot", "sedamstot",
              "osamstot", "devetstot"]

# nastavci pridjevske sklonidbe: (rod, padež) → (nakon nepčanika, inače)
_NASTAVCI = {
    ("m", "nom"): ("i", "i"), ("m", "gen"): ("eg", "og"), ("m", "lok"): ("em", "om"),
    ("m", "aku"): ("i", "i"),
    ("z", "nom"): ("a", "a"), ("z", "gen"): ("e", "e"), ("z", "lok"): ("oj", "oj"),
    ("z", "aku"): ("u", "u"),
}

MJESECI_GEN = ["", "siječnja", "veljače", "ožujka", "travnja", "svibnja", "lipnja", "srpnja",
               "kolovoza", "rujna", "listopada", "studenoga", "prosinca"]
MJESECI_NOM = ["", "siječanj", "veljača", "ožujak", "travanj", "svibanj", "lipanj", "srpanj",
               "kolovoz", "rujan", "listopad", "studeni", "prosinac"]
MJESECI_AKU = ["", "siječanj", "veljaču", "ožujak", "travanj", "svibanj", "lipanj", "srpanj",
               "kolovoz", "rujan", "listopad", "studeni", "prosinac"]


def _do_999(n: int, rod: str = "m") -> list[str]:
    s, ostatak = divmod(n, 100)
    out = [_STOTICE[s]] if s else []
    if ostatak == 0:
        return out
    if ostatak < 20:
        rijec = _JEDINICE[ostatak]
    else:
        d, j = divmod(ostatak, 10)
        out.append(_DESETICE[d])
        if not j:
            return out
        rijec = _JEDINICE[j]
    if rod == "z":
        rijec = {"jedan": "jedna", "dva": "dvije"}.get(rijec, rijec)
    out.append(rijec)
    return out


def _mnozina(n: int, jedan: str, dva_cetiri: str, pet: str) -> str:
    if 11 <= n % 100 <= 14:
        return pet
    if n % 10 == 1:
        return jedan
    if 2 <= n % 10 <= 4:
        return dva_cetiri
    return pet


def broj(n: int, rod: str = "m") -> str:
    """Glavni broj riječima (rod 'm' ili 'z' utječe samo na 1 i 2)."""
    if n == 0:
        return "nula"
    if n < 0:
        return "minus " + broj(-n, rod)
    out: list[str] = []
    mil, n = divmod(n, 1_000_000)
    tis, n = divmod(n, 1000)
    if mil:
        out += [] if mil == 1 else _do_999(mil)
        out.append(_mnozina(mil, "milijun", "milijuna", "milijuna"))
    if tis:
        out += [] if tis == 1 else _do_999(tis, "z")
        out.append("tisuću" if tis == 1 else _mnozina(tis, "tisuća", "tisuće", "tisuća"))
    if n:
        out += _do_999(n, rod)
    return " ".join(out)


def redni(n: int, padez: str = "nom", rod: str = "m") -> str:
    """Redni broj; sklanja se samo zadnja riječ (31. → trideset prvog)."""
    zad = n % 100
    pred = n - zad
    if zad == 0:
        if n % 1000 == 0:
            tis = n // 1000
            prefiks = ("" if tis == 1 else broj(tis, "z") + " ")
            osnova = prefiks + "tisućit"
        else:
            osnova = (broj(n - n % 1000) + " " if n >= 1000 else "") + _REDNI_STO[(n % 1000) // 100]
    elif zad < 20 or zad % 10 == 0:
        osnova = (broj(pred) + " " if pred else "") + (_REDNI_JED[zad] if zad < 20 else _REDNI_DES[zad // 10])
    else:
        glavni = broj(n - zad % 10)
        osnova = glavni + " " + _REDNI_JED[zad % 10]
    nepcani, ostali = _NASTAVCI[(rod, padez)]
    return osnova.strip() + (nepcani if osnova[-1] in "ćčšžj" else ostali)


def godina(n: int, padez: str = "gen") -> str:
    """Godina kao redni broj ženskog roda: 2026. → dvije tisuće dvadeset šeste."""
    return redni(n, padez, "z")


def _decimalni(cijeli: str, dec: str | None) -> str:
    out = broj(int(cijeli.replace(".", "")))
    if dec is not None:
        # decimale se čitaju kao broj, s vodećim nulama posebno (0,05 → nula zarez nula pet)
        vodece = len(dec) - len(dec.lstrip("0"))
        ostatak = dec.lstrip("0")
        dijelovi = ["nula"] * vodece + ([broj(int(ostatak))] if ostatak else [])
        out += " zarez " + " ".join(dijelovi)
    return out


# ── leksikon i kratice ───────────────────────────────────────────────────────

_SLOVA = {"A": "a", "B": "be", "C": "ce", "Č": "če", "Ć": "će", "D": "de", "Đ": "đe", "E": "e",
          "F": "ef", "G": "ge", "H": "ha", "I": "i", "J": "je", "K": "ka", "L": "el", "M": "em",
          "N": "en", "O": "o", "P": "pe", "Q": "ku", "R": "er", "S": "es", "Š": "eš", "T": "te",
          "U": "u", "V": "ve", "W": "dvostruko ve", "X": "iks", "Y": "ipsilon", "Z": "ze", "Ž": "že"}

# Riječi koje čitač inače krivo izgovara. Ključ se uspoređuje točno (osjetljivo na velika slova).
LEKSIKON = {
    "REGOČ": "Regoč", "REGOC": "Regoč", "Deck": "Dek", "OK": "okej", "Ok": "okej",
    "Nextcloud": "Nekstklaud", "GitHub": "Githeb", "email": "imejl",
    "e-mail": "imejl", "mail": "mejl", "online": "onlajn", "ElevenLabs": "Ilevn Labs", "Piper": "Pajper", "Claude": "Klod",
}

# Kratice koje se čitaju kao riječ, ne slovkaju se.
_KAO_RIJEC = {"NATO", "PIN", "WIFI", "LED", "RAM", "USB", "HZZO", "HEP", "INA"}
_KAO_RIJEC_ZAMJENA = {"USB": "u-es-be", "WIFI": "vajfaj", "LED": "led", "RAM": "ram"}


def _slovkaj(rijec: str) -> str:
    return "-".join(_SLOVA.get(c, c.lower()) for c in rijec if c in _SLOVA or c.isdigit())


def _kratica(w: str) -> str:
    if w in LEKSIKON:
        return LEKSIKON[w]
    if w in _KAO_RIJEC:
        return _KAO_RIJEC_ZAMJENA.get(w, w.capitalize())
    if len(w) <= 4:
        return _slovkaj(w)
    return w.capitalize()  # dulji niz velikih slova čita se kao riječ (PRECOM → Precom)


# ── pravila (redoslijed je bitan) ────────────────────────────────────────────

# riječi iza kojih nadnevak ide u genitiv; lokativ vrijedi samo za godinu ("u 2026." → šestoj)
_GENITIV = {"od", "do", "prije", "nakon", "poslije", "oko", "iza", "rokom", "roka",
            "dana", "sredinom", "početkom", "krajem", "tijekom", "zaključno", "počevši", "s", "sa"}
_LOKATIV = {"u", "na", "o", "po", "pri", "prema"}

_PRETHODNA = re.compile(r"(\w+)\W*$")


def _padez_iz_konteksta(tekst: str, start: int) -> str:
    m = _PRETHODNA.search(tekst[:start])
    if not m:
        return "nom"
    rijec = m.group(1).lower()
    if rijec in _GENITIV:
        return "gen"
    if rijec in _LOKATIV:
        return "lok"
    return "nom"


def _kraj_recenice(tekst: str, end: int) -> str:
    """Točka nadnevka je ujedno kraj rečenice ako iza nje slijedi kraj teksta ili veliko slovo."""
    iza = tekst[end:]
    if not iza.strip() or re.match(r"\s*\n|\s+[A-ZČĆŠŽĐ]", iza):
        return "."
    return ""


_NADNEVAK = re.compile(r"(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?:\s?((?:19|20)\d\d)\.?)?(?![\d])")
_MJ_RASPON = re.compile(r"(?<!\d)(\d{1,2})\s?[–-]\s?(\d{1,2})/((?:19|20)\d\d)(?!\d)")
_MJ_GOD = re.compile(r"(?<![\d/])(\d{1,2})/((?:19|20)\d\d)(?!\d)")
_GODINA = re.compile(r"(?<![\d.])((?:19|20)\d\d)\.(?=\s+godin|\s|$)")
_VRIJEME = re.compile(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])")
_URL = re.compile(r"https?://\S+|www\.\S+")
_TASK = re.compile(r"\bTASK-(\d+)\b")
_MILESTONE = re.compile(r"\bM(\d{1,2})\b")
_POSTO = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s?%")
_EURO_ISPRED = re.compile(r"€\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?")
_EURO_IZA = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?\s?(?:€|EUR\b|eura\b|euro\b)")
_RASPON = re.compile(r"(?<![\d,.])(\d+)\s?[–—]\s?(\d+)(?![\d,])")
_DECIMALNI = re.compile(r"(?<![\d,.])(\d+),(\d+)(?![\d,])")
_TISUCICE = re.compile(r"(?<![\d,.])(\d{1,3}(?:\.\d{3})+)(?![\d.,]\d)")
_REDNI = re.compile(r"(?<![\d,.])(\d{1,3})\.(?=\s+[a-zčćšžđ])")
_BROJ = re.compile(r"(?<![\w,.])(\d+)(?:\s+(\w+))?")
_OZNAKA = re.compile(r"\b(?=[A-ZČĆŠŽĐ0-9]*\d)(?=[A-ZČĆŠŽĐ0-9]*[A-ZČĆŠŽĐ])[A-ZČĆŠŽĐ0-9]{2,}\b")
_MALA_BROJ = re.compile(r"\b([a-zčćšžđ]+)(\d+)\b")
_KRATICA = re.compile(r"\b[A-ZČĆŠŽĐ]{2,}\b")


def _oznaka(w: str) -> str:
    """ULX4M → u-el-iks-četiri-em: slova se slovkaju, nizovi znamenki čitaju kao broj."""
    return "-".join(broj(int(d)) if d.isdigit() else _slovkaj(d) for d in re.findall(r"\d+|\D+", w))


def _nadnevak(m: re.Match, tekst: str) -> str:
    dan, mj, god = int(m.group(1)), int(m.group(2)), m.group(3)
    if not (1 <= dan <= 31 and 1 <= mj <= 12):
        return m.group(0)
    padez = "gen" if _padez_iz_konteksta(tekst, m.start()) == "gen" else "nom"
    out = f"{redni(dan, padez)} {MJESECI_GEN[mj]}"
    if god:
        out += " " + godina(int(god))
    zavrsava_tockom = m.group(0).endswith(".")
    return out + (_kraj_recenice(tekst, m.end()) if zavrsava_tockom else "")


def _mj_raspon(m: re.Match, tekst: str) -> str:
    a, b, god = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= a < b <= 12):
        return m.group(0)
    prethodna = _PRETHODNA.search(tekst[:m.start()])
    if prethodna and prethodna.group(1).lower() == "za" and b - a <= 2:
        mj = [MJESECI_AKU[i] for i in range(a, b + 1)]
        popis = ", ".join(mj[:-1]) + " i " + mj[-1]
    else:
        popis = f"od {MJESECI_GEN[a]} do {MJESECI_GEN[b]}"
    return f"{popis} {godina(god)}"


def _broj_s_imenicom(m: re.Match) -> str:
    n = int(m.group(1))
    imenica = m.group(2)
    rod = "m"
    if imenica:
        zad = n % 10
        if zad == 2 and imenica.endswith("e") and not 11 <= n % 100 <= 14:
            rod = "z"
        elif zad == 1 and imenica.endswith("a") and n % 100 != 11:
            rod = "z"
    return broj(n, rod) + (" " + imenica if imenica else "")


def normaliziraj(tekst: str) -> str:
    if not tekst or not tekst.strip():
        return ""
    t = tekst
    t = _URL.sub("poveznicu", t)
    t = _TASK.sub(lambda m: "zadatak " + broj(int(m.group(1))), t)
    t = _MILESTONE.sub(lambda m: redni(int(m.group(1))) + " mjesec", t)
    t = _OZNAKA.sub(lambda m: _oznaka(m.group(0)), t)
    t = _MALA_BROJ.sub(r"\1 \2", t)
    t = _MJ_RASPON.sub(lambda m: _mj_raspon(m, t), t)
    t = _MJ_GOD.sub(lambda m: f"{MJESECI_NOM[int(m.group(1))]} {godina(int(m.group(2)))}"
                    if 1 <= int(m.group(1)) <= 12 else m.group(0), t)
    t = _NADNEVAK.sub(lambda m: _nadnevak(m, t), t)
    t = _GODINA.sub(lambda m: godina(int(m.group(1)), "lok" if _padez_iz_konteksta(t, m.start()) == "lok"
                                     else "gen"), t)
    t = _VRIJEME.sub(lambda m: f"{broj(int(m.group(1)))} sati" if m.group(2) == "00"
                     else f"{broj(int(m.group(1)))} i {broj(int(m.group(2)))}", t)
    t = _POSTO.sub(lambda m: _decimalni(m.group(1), m.group(2)) + " posto", t)

    def _euro(m: re.Match) -> str:
        n = int(m.group(1).replace(".", ""))
        rijec = "euro" if (n % 10 == 1 and n % 100 != 11 and not m.group(2)) else "eura"
        return f"{_decimalni(m.group(1), m.group(2))} {rijec}"

    t = _EURO_ISPRED.sub(_euro, t)
    t = _EURO_IZA.sub(_euro, t)
    t = _RASPON.sub(lambda m: f"{broj(int(m.group(1)))} do {broj(int(m.group(2)))}", t)
    t = _DECIMALNI.sub(lambda m: _decimalni(m.group(1), m.group(2)), t)
    t = _TISUCICE.sub(lambda m: broj(int(m.group(1).replace(".", ""))), t)
    t = _REDNI.sub(lambda m: redni(int(m.group(1))), t)
    t = _BROJ.sub(_broj_s_imenicom, t)

    # kratice: najprije složenice s crticom (ULX-PRECOM), zatim samostalne
    t = re.sub(r"\b([A-ZČĆŠŽĐ]{2,})-([A-ZČĆŠŽĐ]{2,})\b",
               lambda m: f"{_kratica(m.group(1))} {_kratica(m.group(2))}", t)
    t = re.sub(r"\b[\wČĆŠŽĐčćšžđ-]+\b", lambda m: LEKSIKON.get(m.group(0), m.group(0)), t)
    t = _KRATICA.sub(lambda m: _kratica(m.group(0)), t)

    # znakovi
    t = t.replace("&", " i ").replace("+", " plus ").replace("→", ", ").replace("—", ", ")
    t = re.sub(r"\s–\s", ", ", t)
    t = re.sub(r"[*_#`~<>|\[\]{}]", "", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" +([,.!?])", r"\1", t)
    return "\n".join(r.strip() for r in t.split("\n")).strip()


# ── podjela na odlomke i rečenice ────────────────────────────────────────────

_REZ = re.compile(r"(?<=[.!?…])\s+(?=[A-ZČĆŠŽĐ\"„'(])")


def podijeli(tekst: str) -> list[list[str]]:
    """Odlomci (prazan redak) → rečenice. Svaka rečenica završava interpunkcijom."""
    out: list[list[str]] = []
    for odlomak in re.split(r"\n\s*\n", tekst.strip()):
        recenice = []
        for redak in odlomak.split("\n"):
            for r in _REZ.split(redak.strip()):
                r = r.strip()
                if not r:
                    continue
                if r[-1] not in ".!?…":
                    r += "."
                recenice.append(r)
        if recenice:
            out.append(recenice)
    return out
