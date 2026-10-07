# TASK-5330 — mjerenja za ADR-0006 (znanje čvora: opće i privatno)

Samo čitanje. Privatni popis NIJE u paketu: `~/.claude/regoc/deploy/profili/privatno.popis`
na glavnom stroju (0600; redak `kategorija<TAB>izraz`; ID-evi projekata iz `/api/projects` glavne
ploče + ručni popis osoba, klijenata i usluga).

```
# karta sustava, po odjeljku (ADR-0006 §1.2)
python3 docs/qa/TASK-5330/razvrstaj_kartu.py --karta ~/app/regoc_system/docs/system-map \
    --privatno ~/.claude/regoc/deploy/profili/privatno.popis --recenice      # → mjerenje_karte_2026-10-07.txt
#   --tsv  = presuda po odjeljku (ispis sadrži naslove odjeljaka — NE spremati u paket)

# teret kompleta izvornog sustava (ADR-0006 §1.6)
python3 docs/qa/TASK-5330/razvrstaj_kartu.py --karta - --privatno ~/.claude/regoc/deploy/profili/privatno.popis \
    --komplet ~/.claude/regoc/deploy/node-a-samostalnost/MANIFEST.sha256   # → mjerenje_kompleta_2026-10-07.txt

# curenje banke čvora (ADR-0006 §1.1) — upit = izraz s privatnog popisa
curl -s -X POST 127.0.0.1:17792/v1/default/banks/regoc_opus_nodea/memories/recall \
    -H 'Content-Type: application/json' -d '{"query":"<izraz>","budget":"low","max_tokens":1024}'

# izloženost svih banaka kroz tunel (ADR-0006 §1.5)
curl -s 127.0.0.1:17792/v1/default/banks        # 07.10.: 4 banke
```

`mjerenje_kompleta_*.txt` broji i ime vlasnika (81 datoteka / 356 pogodaka); bez njega
46 / 158 (ADR §1.6).
