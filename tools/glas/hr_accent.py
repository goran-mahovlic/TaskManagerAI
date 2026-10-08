"""hr_accent — hrvatski naglasci za Piper/espeak-ng TTS.

PROBLEM (izmjereno, TASK-2652):
  espeak-ng za hr/sr (zajednički 'hbs' skup) NEMA naglasni leksikon — naglasak
  pogađa pravilom "primarni naglasak na 1. slog, uvijek". Provjereno: u cijelom
  hr_dict/sr_dict NIJEDNA riječ ne dobiva ne-inicijalni primarni naglasak (0/60).

  Popis grešaka koje ovaj modul ispravlja:
    B1  naglasak uvijek na 1. slogu     televizija -> tˈɛlɛvˌɪzɪjɐ  (te-le-VI-zi-ja)
    B2  lažni sekundarni naglasak ˌ     računalo   -> rˈatʃʊnˌɐlo   (hrvatski ga nema)
    B3  slogotvorno r nije nukleus      brzo       -> brzˈo         (BR-zo)
                                        vrt        -> vrt           (bez naglaska)
    B4  redukcija samoglasnika ɐ/æ/ɪ/ʊ  hvala      -> xvˈalɐ        (hrvatski ne reducira)

  B5 (NIJE bug ovog modula): prebacivanje espeak glasa sr->hr NE popravlja naglasak.
     Izmjereno: hr i sr daju IDENTIČAN naglasak, razlikuju se samo u ɾ/r i æ/ɐ.
     Piper glas je treniran na sr fonemima -> prebacivanje na hr uvodi ɾ i æ kojih
     možda nema u phoneme_id_map -> gubitak fonema. NE DIRAJ espeak.voice.

  B6 (izvan dosega): 4 hrvatska tonska naglaska (◌̏ ◌̑ ◌̀ ◌́) i zanaglasna duljina.
     espeak IPA ih ne kodira, a Piper glas ih nije vidio u treningu. Ovdje se
     modelira samo MJESTO naglaska (+ duljina preko ː), ne i ton.

RJEŠENJE: post-obrada fonemskog niza (ne dira se espeak ni Piper model).
  Oslonac: espeak vraća fonemske komadiće poravnate 1:1 s riječima (provjereno),
  a ˈ stavlja neposredno ispred samoglasnika-nukleusa -> premještanje je lokalno.

Redoslijed odlučivanja za svaku riječ:
  1. LEXICON       — eksplicitne iznimke i visokofrekventne riječi
  2. SUFFIX_RULES  — produktivni razredi (-cija, -ija, -irati, -or, ...)
  3. espeak default (1. slog) — točno za većinu domaćih riječi, pa se ostavlja
                                 (ali se svejedno čisti B2/B3/B4)

Uporaba:
    from hr_accent import phonemize_hr
    phonemes = phonemize_hr("Gledam televiziju.")   # -> 'ɡlˈɛdam tɛlɛvˈiziju.'
"""

from __future__ import annotations

import re
import unicodedata

PRIMARY = "ˈ"    # ˈ
SECONDARY = "ˌ"  # ˌ
LENGTH = "ː"     # ː

# Samoglasnici koje espeak koristi za hbs (uklj. reducirane alofone)
VOWELS = set("aɑɐæeɛiɪoɔuʊ")

# B4: espeakova redukcija -> hrvatski stabilni samoglasnici
DEREDUCE = {"ɐ": "a", "æ": "a", "ɪ": "i", "ʊ": "u"}

# Nenaglašenice (proklitike + enklitike) — NIKAD ne dobivaju naglasak.
# espeak ih ispravno ostavlja bez ˈ, pa ih moramo izuzeti iz "dodaj naglasak" grane.
CLITICS = {
    # glagolske enklitike
    "je", "su", "sam", "si", "smo", "ste", "bi", "bih", "bismo", "biste",
    "ću", "ćeš", "će", "ćemo", "ćete",
    # zamjeničke enklitike
    "me", "te", "se", "ga", "je", "ju", "nas", "vas", "ih", "mi", "ti", "mu",
    "joj", "nam", "vam", "im",
    # upitna / veznici / prijedlozi (proklitike)
    "li", "i", "a", "ni", "ali", "pa", "te", "da", "ne",
    "u", "na", "za", "s", "sa", "iz", "od", "do", "po", "o", "pri", "uz",
    "kroz", "bez", "nad", "pod", "pred", "među",
}


# ---------------------------------------------------------------------------
# Leksikon: riječ -> indeks naglašenog sloga (0-baziran; negativan = od kraja)
# ---------------------------------------------------------------------------
# ⚠️ OVO JE PRIVREMENA SJEMENSKA TABLICA, RUČNO POGOĐENA — NIJE NORMATIVNA.
# Križna provjera s wiktionary podacima već je pokazala neslaganja
# (npr. ovdje "računalo": 1, a rȁčūnalo -> 0; "telefon": 0, a kaikki -> 1).
# PRAVI leksikon gradi build_lexicon.py iz kaikki.org podataka i učitava se
# preko load_lexicon(); ova tablica služi samo kao fallback dok se ne izgradi.
LEXICON: dict[str, int] = {
    # --- posuđenice s naglaskom na pretposljednjem/antepenultimi ---
    "restoran": 1, "hotel": 0, "banana": 1, "gitara": 1, "balkon": 0,
    "automobil": 3, "kompjuter": 0, "telefon": 1, "program": 0,
    "kilometar": 1, "univerzitet": 3, "sveučilište": 1,
    # --- domaće riječi koje espeak promaši ---
    "računalo": 1, "sveučilišta": 1, "doviđenja": 2, "dovidenja": 2,
    "oprostite": 1, "izvolite": 1, "gospodin": 1, "gospođa": 1,
    "prijatelj": 0, "obitelj": 0, "izvještaj": 0, "izvješće": 0,
    "dogovoriti": 2, "napraviti": 1, "razumijem": 1,
    # --- vrlo česte u sustavu ---
    "hrvatska": 1, "hrvatski": 1, "hrvatskoj": 1, "hrvatske": 1,
    "zagreb": 0, "molim": 0, "hvala": 0, "pozdrav": 0,
    "poslužitelj": 1, "poruka": 1, "zadatak": 1, "zadatka": 1,
    "greška": 0, "sustav": 0, "postavke": 1, "korisnik": 1,
    "lozinka": 1, "datoteka": 2, "mreža": 0, "podatak": 1,
}


# ---------------------------------------------------------------------------
# Produktivna pravila: (regex na pravopisnom obliku, slog od KRAJA, min. slogova)
# ---------------------------------------------------------------------------
# Indeks je negativan = brojano od zadnjeg sloga (-1 = zadnji, -3 = treći od kraja).
SUFFIX_RULES: list[tuple[re.Pattern, int, int]] = [
    # informacija, organizacija, televizija, demokracija -> 3. slog od kraja
    (re.compile(r"(cij|zij|sij|đij)[aeiou]$"), -3, 4),
    # -irati / -izirati glagoli: organizirati -> or-ga-ni-ZI-ra-ti
    (re.compile(r"ir[ao](ti|la|li|lo|na|ni)?$"), -3, 4),
    # -or: profesor, direktor, doktor, traktor -> pretposljednji
    (re.compile(r"[oe]r$"), -2, 2),
    # -ent / -ant / -ist: student, asistent, specijalist -> pretposljednji
    (re.compile(r"(ent|ant|ist|izam)$"), -2, 2),
    # -ura / -ija (opće): kultura, literatura, kemija -> pretposljednji
    (re.compile(r"ur[ae]$"), -2, 3),
]


# ---------------------------------------------------------------------------
# Jezgra: rad nad fonemskim nizom
# ---------------------------------------------------------------------------
def _nuclei(ph: str) -> list[int]:
    """Indeksi slogovnih nukleusa u fonemskom nizu.

    Nukleus = samoglasnik ILI slogotvorno r (B3): r/ɾ koje nema samoglasnika
    ni s jedne strane unutar iste riječi (vrt, brzo, prst, cvrkut).
    """
    out: list[int] = []
    for i, c in enumerate(ph):
        if c in VOWELS:
            out.append(i)
        elif c in "rɾ":
            prev = ph[i - 1] if i > 0 else ""
            nxt = ph[i + 1] if i + 1 < len(ph) else ""
            if prev not in VOWELS and nxt not in VOWELS:
                out.append(i)
    return out


def _strip_marks(ph: str) -> str:
    """Makni sve postojeće oznake naglaska (B1 priprema + B2 brisanje ˌ)."""
    return ph.replace(PRIMARY, "").replace(SECONDARY, "")


def restress(ph: str, syllable: int) -> str:
    """Premjesti primarni naglasak na zadani slog fonemskog niza.

    `syllable` je 0-baziran; negativan broji od kraja (-1 = zadnji slog).
    Vraća niz nepromijenjen ako slog ne postoji.
    """
    bare = _strip_marks(ph)
    nuc = _nuclei(bare)
    if not nuc:
        return bare  # npr. sama interpunkcija
    idx = syllable if syllable >= 0 else len(nuc) + syllable
    if not 0 <= idx < len(nuc):
        return bare
    at = nuc[idx]
    return bare[:at] + PRIMARY + bare[at:]


def dereduce(ph: str) -> str:
    """B4: vrati reducirane samoglasnike u pune hrvatske."""
    return "".join(DEREDUCE.get(c, c) for c in ph)


# ---------------------------------------------------------------------------
# Odabir sloga za riječ
# ---------------------------------------------------------------------------
def _clean_word(w: str) -> str:
    """Pravopisna riječ bez interpunkcije, mala slova."""
    return re.sub(r"[^\wčćžšđ]", "", w.lower(), flags=re.UNICODE)


def _count_syllables_ortho(w: str) -> int:
    """Gruba procjena broja slogova iz pravopisa (samoglasnici + slogotvorno r)."""
    n = len(re.findall(r"[aeiou]", w))
    n += len(re.findall(r"(?<![aeiou])r(?![aeiou])", w))
    return n


def load_lexicon(path: str, *, replace: bool = True) -> int:
    """Učitaj naglasni leksikon izgrađen s build_lexicon.py (JSON: riječ -> slog).

    replace=True (zadano): podaci iz korpusa imaju prednost nad ručnom sjemenskom
    tablicom, jer je ona samo pogađanje (vidi upozorenje uz LEXICON).
    Vraća broj učitanih natuknica.

    Leksikon u paketu (TASK-5340) nema natuknice „jelena" i „malik": poklapaju se s imenima
    uloga pa ih brana paketa broji kao popis tima; obje imaju naglasak na 1. slogu, što je
    zadano pravilo, pa je izgovor isti (izmjereno na 11 oblika, bez razlike).
    """
    import json

    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if replace:
        LEXICON.update(data)
    else:
        for k, v in data.items():
            LEXICON.setdefault(k, v)
    _build_inflection_index()
    return len(data)


def _build_inflection_index() -> None:
    """Indeks OSNOVA za padežne oblike kojih nema doslovno u leksikonu.

    Za razliku od _stem_lookup (koji je prelazio i na TVORBU pa je griješio:
    cvȑkūt vs cvrkùtati), ovdje se osnova dobiva skidanjem isključivo
    NASTAVAKA — a unutar paradigme je mjesto naglaska stabilno.
    Osnove s proturječnim naglaskom se izbacuju.
    """
    _INFLECTION_INDEX.clear()
    conflict: set[str] = set()
    for word, idx in LEXICON.items():
        for end in INFLECTIONS:
            if not word.endswith(end):
                continue
            stem = word[: -len(end)]
            if len(stem) < 4:
                continue
            prev = _INFLECTION_INDEX.get(stem)
            if prev is None:
                _INFLECTION_INDEX[stem] = idx
            elif prev != idx:
                conflict.add(stem)
    for stem in conflict:
        _INFLECTION_INDEX.pop(stem, None)


# Iznad ovog praga leksikon se smatra "punim" i heuristika po osnovi se GASI.
# Razlog: _stem_lookup je bio smislen dok je leksikon imao ~40 ručnih natuknica,
# ali na 53k natuknica lažno pogađa jer se naglasak pri TVORBI pomiče:
#   cvȑkūt (slog 0) vs cvrkùtati (slog 1) -> osnova bi "cvrkut" krivo dala 1.
FULL_LEXICON_THRESHOLD = 1000

# osnova -> naglašeni slog; gradi se iz LEXICON-a u _build_inflection_index()
_INFLECTION_INDEX: dict[str, int] = {}

# Hrvatske normativne iznimke nad podacima iz kaikkija.
# Izvor kaikkija je 'sh' (srpsko-hrvatski) pa za dio riječi nosi SRPSKI lik:
#   hr profèsor (slog 1) vs sr prȍfesor (slog 0); isto dirèktor/dìrektor.
# Ove natuknice imaju prednost pred korpusom. Popis treba proširiti provjerom
# na hr.wiktionary / HJP — vidi OTVORENO u README.
NORMATIVE_HR: dict[str, int] = {
    "profesor": 1,
    "direktor": 1,
    "profesorica": 1,
    "direktorica": 1,
}


def _stem_lookup(w: str, min_stem: int = 4) -> int | None:
    """Padežni oblik -> naglasak lemme preko zajedničke osnove.

    Hrvatski je jako flektivan (sveučilište/sveučilišta/sveučilištu/sveučilištem...),
    a mjesto naglaska je u većini paradigmi STABILNO. Umjesto da u leksikon idu svi
    oblici, tražimo najdulju leksikonsku natuknicu koja dijeli osnovu s riječi.

    Prenosi se samo POZITIVAN indeks (broji od početka, pa ga dodavanje nastavka
    ne pomiče). Negativni indeksi (od kraja) se NE prenose jer ih nastavak pomakne.
    """
    best: tuple[int, int] | None = None  # (duljina osnove, indeks)
    for key, idx in LEXICON.items():
        if idx < 0:
            continue
        # zajednički prefiks
        n = 0
        for a, b in zip(w, key):
            if a != b:
                break
            n += 1
        # osnova mora pokriti gotovo cijelu natuknicu (razlika = samo nastavak)
        if n >= min_stem and n >= len(key) - 3 and n >= len(w) - 4:
            if best is None or n > best[0]:
                best = (n, idx)
    return best[1] if best else None


# Česti hrvatski padežni/glagolski nastavci — za svođenje oblika na osnovni lik.
# Duži prvi (da "ima" pobijedi "a").
INFLECTIONS = ("ovima", "evima", "ima", "ama", "ove", "ovi", "om", "em", "im",
               "ah", "ju", "a", "e", "i", "o", "u")


def _apply_suffix_rules(w: str) -> int | None:
    """Primijeni produktivna pravila izravno na dani oblik."""
    nsyl = _count_syllables_ortho(w)
    for pattern, idx, minsyl in SUFFIX_RULES:
        if nsyl >= minsyl and pattern.search(w):
            return idx
    return None


def stress_for(word: str) -> int | None:
    """Vrati indeks naglašenog sloga za riječ, ili None = ostavi espeakov default."""
    w = _clean_word(word)
    if not w:
        return None
    if w in NORMATIVE_HR:
        return NORMATIVE_HR[w]
    if w in LEXICON:
        return LEXICON[w]

    idx = _apply_suffix_rules(w)
    if idx is not None:
        return idx

    # Oblik nije uhvaćen pravilom (npr. "profesora" ne završava na -or).
    # Svedi ga na osnovni lik, primijeni pravilo TAMO, pa negativni indeks
    # (od kraja) pretvori u pozitivan (od početka) — jer je mjesto naglaska u
    # hrvatskoj paradigmi stabilno, a nastavak bi negativni indeks pomaknuo.
    for end in INFLECTIONS:
        if not w.endswith(end):
            continue
        base = w[: -len(end)]
        if len(base) < 3:
            continue
        base_idx = _apply_suffix_rules(base)
        if base_idx is None:
            continue
        if base_idx < 0:
            base_idx = _count_syllables_ortho(base) + base_idx
        if base_idx >= 0:
            return base_idx

    # Padežni oblik kojeg nema doslovno: probaj preko osnove iz paradigme
    for end in INFLECTIONS:
        if w.endswith(end):
            stem = w[: -len(end)]
            if stem in _INFLECTION_INDEX:
                return _INFLECTION_INDEX[stem]

    # Heuristika po osnovi samo dok je leksikon mali (vidi FULL_LEXICON_THRESHOLD)
    if len(LEXICON) < FULL_LEXICON_THRESHOLD:
        return _stem_lookup(w)
    return None


# ---------------------------------------------------------------------------
# Javni API
# ---------------------------------------------------------------------------
def fix_word(word: str, ph: str, *, apply_dereduce: bool = False) -> str:
    """Ispravi fonemski niz jedne riječi (naglasak + čišćenje artefakata)."""
    # Odvoji završnu interpunkciju da ne pomakne indekse
    m = re.match(r"^(.*?)([\s,.:;!?]*)$", ph, flags=re.DOTALL)
    core, tail = m.group(1), m.group(2)

    if _clean_word(word) in CLITICS:
        # Nenaglašenica: samo očisti eventualne oznake, nikad ne dodaji naglasak.
        core = _strip_marks(core)
    else:
        syl = stress_for(word)
        if syl is not None:
            core = restress(core, syl)
        else:
            # espeakov default (1. slog) se zadržava, ali se čisti B2 (lažni ˌ)
            # i popravlja B3: slogotvorno r nije nukleus pa je espeak naglasak
            # gurnuo na sljedeći samoglasnik (brzo -> brzˈo) ili ga izostavio (vrt).
            bare = _strip_marks(core)
            nuc = _nuclei(bare)
            if nuc:
                syllabic_r_first = bare[nuc[0]] in "rɾ"
                if syllabic_r_first or PRIMARY in core:
                    core = restress(core, 0)
                else:
                    # espeak nije dao naglasak i nema slogotvornog r -> ne izmišljaj ga
                    core = bare

    if apply_dereduce:
        core = dereduce(core)
    return core + tail


def phonemize_hr(
    text: str,
    *,
    voice: str = "sr",
    apply_dereduce: bool = False,
    phonemizer=None,
) -> str:
    """Fonemiziraj hrvatski tekst s ispravljenim naglascima.

    voice='sr' je NAMJERNO (vidi B5): Piper glas sr_RS-serbski_institut-medium
    je treniran na sr fonemima. Ne mijenjaj bez provjere phoneme_id_map.
    """
    if phonemizer is None:
        from piper.phonemize_espeak import EspeakPhonemizer

        phonemizer = EspeakPhonemizer()

    words = text.split()
    out_sentences: list[str] = []
    wi = 0
    for sent in phonemizer.phonemize(voice, text):
        ph = "".join(sent)
        chunks = ph.split(" ")
        fixed: list[str] = []
        for ch in chunks:
            if not ch.strip():
                fixed.append(ch)
                continue
            word = words[wi] if wi < len(words) else ""
            fixed.append(fix_word(word, ch, apply_dereduce=apply_dereduce))
            wi += 1
        out_sentences.append(" ".join(fixed))
    return " ".join(out_sentences)


def patch_piper_voice(voice, *, apply_dereduce: bool = False):
    """Ugradi hrvatske naglaske u PiperVoice instancu (in-place).

    PiperVoice lanac je: phonemize() -> phonemes_to_ids() -> phoneme_ids_to_audio().
    Presreće se samo prvi korak, pa model i phoneme_id_map ostaju netaknuti.

    ⚠️ NE RADI preko CLI-ja: `python3 -m piper` fonemizira interno, pa ga ova
    zakrpa ne vidi. servis glasa koji zove CLI (subprocess)
    mora prijeći na Python API da bi ovo imalo učinka (regoc_piper_synth.py to radi).

    Primjer:
        from piper import PiperVoice
        v = PiperVoice.load(model_path)
        patch_piper_voice(v)
        with wave.open("out.wav","wb") as w: v.synthesize_wav("Dobar dan.", w)
    """
    original = voice.phonemize

    def _hr_phonemize(text: str) -> list[list[str]]:
        sentences = original(text)
        words = text.split()
        wi = 0
        out: list[list[str]] = []
        for sent in sentences:
            fixed_chunks: list[str] = []
            for chunk in "".join(sent).split(" "):
                if not chunk.strip():
                    fixed_chunks.append(chunk)
                    continue
                word = words[wi] if wi < len(words) else ""
                fixed_chunks.append(
                    fix_word(word, chunk, apply_dereduce=apply_dereduce)
                )
                wi += 1
            # PiperVoice očekuje listu pojedinačnih fonema (znakova), ne niz
            out.append(list(" ".join(fixed_chunks)))
        return out

    voice.phonemize = _hr_phonemize
    return voice


__all__ = [
    "phonemize_hr", "fix_word", "restress", "stress_for", "dereduce",
    "load_lexicon", "patch_piper_voice", "LEXICON", "NORMATIVE_HR",
]
