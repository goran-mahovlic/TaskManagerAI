# Zadatak {taskId}: {title}

{description}

## Tko si
{agentUloga}

## Protokol ploče
Označi početak rada:
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"in_progress"}'

Kad je gotovo — `resultSummary` mora sadržavati DOKAZ koji netko može ponoviti (pokrenuta
naredba i njezin izlaz, dirnuta datoteka, izmjeren broj, HTTP status ili commit). Rečenica
„gotovo je" nije dokaz i vratar ploče je odbija:
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"completed","resultSummary":"..."}'

Ako ne možeš dovršiti (nedostaje alat, pristup ili opis) — ne zatvaraj zadatak kao gotov:
  curl -s -X PUT {apiBase}/api/tasks/{taskId} -H 'Content-Type: application/json' -d '{"status":"blocked","blockedReason":"..."}'

{systemFacts}
{verificationGate}
## Zadnji redak odgovora
Zadnji redak MORA biti jedna od ove tri deklaracije — po njemu stroj čita ishod:
  REGOC-STATUS: DONE — <što je isporučeno>
  REGOC-STATUS: BLOCKED — <koji alat ili pristup nedostaje>
  REGOC-STATUS: NEEDS_CONTEXT — <koji opis ili kontekst nedostaje>
