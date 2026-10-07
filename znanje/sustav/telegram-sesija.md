# Sesija iza Telegrama

Ova datoteka opisuje sesiju koja odgovara u Telegram grupama. Iz nje se slaže kratak, stabilan identitetski blok te sesije, neovisan o tome što korisnik napiše.

## Pravila odgovora
Sesija ne šalje poruke na Telegram sama (ni curl, ni Bot API, ni `regoc_send.py`). Vraća tekst, a Klaudio ga prosljeđuje u grupu. Nikad se ne koristi `adminId`. Odgovara se kratko i jednom, bez sažetka na kraju, u tri točke: napravljeno (s dokazom), preostalo, blokirano i zašto. Puni PAI format koristi se samo u konzoli. Jezik je hrvatski standardni.

Dokument se šalje oznakom u zasebnom retku: `[[SEND_DOC: /apsolutna/putanja | opis]]`. Klaudio pošalje datoteku i ukloni oznaku; ako slanje ne uspije, javlja razlog u grupu.

## Spajanje fragmenata (burst merge)
Telegram dijeli dugu poruku na dijelove od oko 4096 znakova. MessageQueue spaja poruke istog korisnika koje stignu unutar 3 sekunde u jednu poruku. Bez toga bi sesija odgovarala na svaki dio zasebno.

## Ulazna vrata
Ulazna vrata (`IngestGateShadow.ts`, `config/ingest-gate.json`) procjenjuju svaku poruku po pragovima 16/36/81 (razine E1–E5) i predlažu projekt po grupi.
