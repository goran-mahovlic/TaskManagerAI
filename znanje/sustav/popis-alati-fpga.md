# Alati domene fpga

Kanonski alati domene fpga. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `build.sh` (cli, vlasnik jelena): Reproducible build of nextpnr-himbaechel (gatemate uarch only) at the same. Poziv: `bash ${SUSTAV_DIR}/tools/fpga/nextpnr-patched/build.sh`.
- `compare.sh` (cli, vlasnik jelena): Run one design through old (oss-cad-suite), vanilla (local 3edea68e) and patched (3edea68e+abd0731). Poziv: `bash ${SUSTAV_DIR}/tools/fpga/nextpnr-patched/compare.sh`.
- `summarize.py` (cli, vlasnik jelena): Summarise compare.sh results: post-route Fmax per clock, hold violations, worst hold slack,. Poziv: `python3 ${SUSTAV_DIR}/tools/fpga/nextpnr-patched/summarize.py --help`.
