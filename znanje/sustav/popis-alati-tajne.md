# Alati domene tajne

Kanonski alati domene tajne. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `AuditLogger.ts` (cli, vlasnik jelena): REGOČ F1.5 Audit Logger. Poziv: `bun ${SUSTAV_DIR}/security/AuditLogger.ts`.
- `probe_security_guidance_selfscan.py` (modul, vlasnik jelena): — proba: pokreni PATTERN sloj plugina `security-guidance` (2.0.7). Poziv: `import iz ${SUSTAV_DIR}/security/probe_security_guidance_selfscan.py`.
- `PromptGuard.ts` (cli, vlasnik jelena): REGOC F1.1 PromptGuard -- Prompt Injection Detection for Telegram Messages. Poziv: `bun ${SUSTAV_DIR}/security/PromptGuard.ts`.
- `rotate_set.sh` (cli, vlasnik jelena): rotate_set.sh <VAR_NAME> — sigurno upisuje NOVU vrijednost tajne u credentials.env. Poziv: `bash ${SUSTAV_DIR}/security/rotate_set.sh`.
- `secret_exposure_scan.py` (cli, vlasnik jelena): secret_exposure_scan.py — provjerava jesu li ŽIVE vrijednosti iz credentials storea. Poziv: `python3 ${SUSTAV_DIR}/tools/tajne/secret_exposure_scan.py            # pun scan`. Stare putanje: `${SUSTAV_DIR}/tools/secret_exposure_scan.py`.
- `secret_probe.py` (cli, vlasnik jelena): secret_probe.py — odgovori na pitanje "postoji li tajna X i je li to ONA?" BEZ ispisa vrijednosti. Poziv: `python3 ${SUSTAV_DIR}/tools/tajne/secret_probe.py --name NEXTCLOUD_PASSWORD`. Stare putanje: `${SUSTAV_DIR}/tools/secret_probe.py`.
- `secret_redact_derived.py` (cli, vlasnik jelena): secret_redact_derived.py — L3 SANACIJA: redigira žive tajne iz IZVEDENIH artefakata. Poziv: `python3 ${SUSTAV_DIR}/tools/tajne/secret_redact_derived.py            # dry-run`. Stare putanje: `${SUSTAV_DIR}/tools/secret_redact_derived.py`.
- `SecurityPipeline.ts` (modul, vlasnik jelena): REGOČ F1.3 SecurityPipeline — Main Pipeline Orchestrator. Poziv: `import iz ${SUSTAV_DIR}/security/SecurityPipeline.ts`.
- `SelfScan.ts` (cli, vlasnik jelena): SelfScan — deterministički skener STANJA vlastite orkestracijske konfiguracije. Poziv: `bun ${SUSTAV_DIR}/security/SelfScan.ts                  # samo NOVO prema osnovici (JSON)`.
- `types.ts` (modul, vlasnik jelena): REGOČ F1.3 SecurityPipeline — Type Definitions. Poziv: `import iz ${SUSTAV_DIR}/security/types.ts`.
