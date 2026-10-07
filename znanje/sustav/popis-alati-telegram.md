# Alati domene telegram

Kanonski alati domene telegram. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `telegram_poruke_izvoz.py` (cli, vlasnik jelena): Izvoz telegramskih poruka iz transkripata — ulaz za ponovni prolaz kroz vrata. Poziv: `python3 ${SUSTAV_DIR}/tools/telegram/telegram_poruke_izvoz.py --dana 7`. Stare putanje: `${SUSTAV_DIR}/tools/telegram_poruke_izvoz.py`.
- `tg_send.py` (cli, vlasnik jelena): Šalje tekst ili datoteku (PDF, slika…) u Telegram grupu preko Bot API-ja; nikad na osobni ID. Poziv: `python3 ${SUSTAV_DIR}/tools/telegram/tg_send.py tekst --group regoc 'poruka'  |  … dokument izvjestaj.pdf --caption 'opis'`. Stare putanje: `${SUSTAV_DIR}/tools/telegram_send_text.py`, `${SUSTAV_DIR}/tools/telegram_send_document.py`, `${SUSTAV_DIR}/tools/mjere_telegram.py`.
