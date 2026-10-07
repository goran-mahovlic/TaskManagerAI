# Alati, vještine, kuke i MCP

Prije pisanja nove skripte treba pitati katalog: `katalog trazi <svrha>` (ili `python3 ${SUSTAV_DIR}/tools/katalog/katalog.py trazi …`). Ako postoji kanonski alat iste svrhe, nadograđuje se on, a ne piše novi (ADR-0015, „traži → nadogradi → upiši”). Kuka `KatalogCuvar` uz svaki Write nove `.py/.ts/.sh` u `tools/` ili `~/.tmp` sama dojavi najsličniji postojeći alat.

## Vještine (skillovi)
Vještine su u `~/.claude/skills`; generičke vještine bez ijednog poziva u 30 dana premještene su u `~/.claude/skills/_arhiva/`, pa ih sesije više ne učitavaju. Svaka aktivna vještina ima datoteku `popis/vjestina-<Ime>.md` sa svrhom, agentima kojima je dodijeljena i svim tijekovima iz njezine mape `Workflows`. Inženjerske vještine su GrillWithDocs (oštrenje dizajna, CONTEXT.md i ADR, za Kosjenku), DiagnosingBugs (šestofazna petlja otklanjanja pogrešaka, za Jelenu) i TDD (vertikalni TDD, za Jelenu). Agent koristi samo vještine navedene za njega u registru.

## Kuke (hooks)
Kuke su registrirane u `~/.claude/settings.json` (ključ `hooks`) po događaju: početak sesije, prije i nakon alata, korisnički upit i kraj. Kanonske kuke sa svrhom popisane su u `popis/alati-kuke-*.md`. `SecurityValidator` blokira naredbe koje bi ispisale sadržaj spremišta tajni.
