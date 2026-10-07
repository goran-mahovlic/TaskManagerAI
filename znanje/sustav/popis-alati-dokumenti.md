# Alati domene dokumenti

Kanonski alati domene dokumenti. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `docx2pdf.sh` (cli, vlasnik jelena): Uredski dokument (DOCX/ODT/XLSX/PPTX) → PDF (+ PNG po stranici) LibreOfficeom 25.8 iz AppImagea, bez sudo-a; koristi fontove ugrađene u DOCX, slike bez smanjivanja. Za vizualnu provjeru DOCX-a. Poziv: `${SUSTAV_DIR}/tools/dokumenti/docx2pdf.sh ulaz.docx [izlazna_mapa] [--png 200]`.
- `mk-excalidraw.py` (cli, vlasnik jelena): mk-excalidraw.py — deterministicki generator valjanog .excalidraw dijagrama iz. Poziv: `python3 ${SUSTAV_DIR}/tools/dokumenti/mk-excalidraw.py --help`. Stare putanje: `${SUSTAV_DIR}/tools/mk-excalidraw.py`.
