import { describe, test, expect } from "bun:test";
import {
  evaluateCompletion,
  countEvidenceMarkers,
  findIncapacityAdmission,
  isTrivialResult,
  MIN_MEANINGFUL_LENGTH,
  EVIDENCE_OVERRIDE_THRESHOLD,
  NO_EVIDENCE_MAX_LENGTH,
  parseDeclaredStatus,
  shouldEnforce,
  formatVerdictLabel,
  executorTrust,
  evaluateLocalExecutor,
  DEFAULT_GATE_CONFIG,
  type CompletionVerdict,
  type GateConfig,
} from "../src/core/CompletionGuard";

// ─────────────────────────────────────────────────────────────────────────────
// Doslovni result_summary zapisi iz žive baze (TASK-2954 / D2). Ovo su rezultati
// koje je sustav zatvorio kao `completed` iako agent EKSPLICITNO kaže da nije radio.
// ─────────────────────────────────────────────────────────────────────────────
const TASK_329 = "Nema zadane test description, ne mogu pokrenuti test bez detalja.";
const TASK_330 =
  "Nemam pristup alatima (Bash, datotekama, MCP-u) ili lokalnim modelima za izvršavanje zadataka, " +
  "pa ne mogu stvoriti rezultate ili pristupiti sistemskim činjenicama.";
const TASK_338 = "Zadatak je gotov.\n";

// Stvarni, dokazani rezultat — mora PROĆI (regresija protiv pretjerano strogog gatea).
const REAL_RESULT = `📋 REZULTAT: Dodan CompletionGuard u TaskWebUI.ts:5546.
⚡ ACTIONS:
- bun test tests/completion-guard.test.ts → 24 pass, 0 fail
- curl -s -X PUT http://localhost:17781/api/tasks/TASK-2954 → HTTP 400 (guard aktivan)
📊 STATUS: Uspješno, commit 82575f0`;

const REAL_ANALYSIS = `Uzrok pada je stretch 640x360 u live.js:212 — canvas ne poštuje
aspect ratio portreta, pa model dobiva deformiranu sliku. Izmjerio sam recall prije/poslije:
0.517 → 0.828 na istom harness setu od 731 framea.`;

describe("isTrivialResult", () => {
  test("prazna potvrda bez sadržaja je trivijalna", () => {
    expect(isTrivialResult("Zadatak je gotov.")).toBe(true);
    expect(isTrivialResult("gotovo")).toBe(true);
    expect(isTrivialResult("Done.")).toBe(true);
    expect(isTrivialResult("OK")).toBe(true);
    expect(isTrivialResult("Završeno!")).toBe(true);
    expect(isTrivialResult("Uspješno izvršeno.")).toBe(true);
  });

  test("rezultat sa sadržajem nije trivijalan", () => {
    expect(isTrivialResult(REAL_RESULT)).toBe(false);
    expect(isTrivialResult(REAL_ANALYSIS)).toBe(false);
  });
});

describe("findIncapacityAdmission", () => {
  test("hvata hrvatska priznanja nemoći", () => {
    expect(findIncapacityAdmission(TASK_329)).not.toBeNull();
    expect(findIncapacityAdmission(TASK_330)).not.toBeNull();
    expect(findIncapacityAdmission("Nisam u mogućnosti dovršiti bez specifikacije.")).not.toBeNull();
    expect(findIncapacityAdmission("Nedostaje opis zadatka.")).not.toBeNull();
    expect(findIncapacityAdmission("Nije moguće izvršiti bez pristupa repozitoriju.")).not.toBeNull();
  });

  test("hvata engleska priznanja nemoći", () => {
    expect(findIncapacityAdmission("I cannot execute this without tool access.")).not.toBeNull();
    expect(findIncapacityAdmission("Unable to complete the task.")).not.toBeNull();
    expect(findIncapacityAdmission("I have no access to Bash or the filesystem.")).not.toBeNull();
    expect(findIncapacityAdmission("Insufficient context to proceed.")).not.toBeNull();
  });

  test("NE hvata opis tuđe nemoći u bug reportu (false-positive zaštita)", () => {
    // Klasičan legitiman nalaz: korisnici ne mogu nešto — to nije agentovo priznanje.
    expect(
      findIncapacityAdmission(
        "Korisnici ne mogu otvoriti stranicu jer self-signed cert blokira <video>. Popravio sam u live.js:212.",
      ),
    ).toBeNull();
    expect(findIncapacityAdmission(REAL_RESULT)).toBeNull();
    expect(findIncapacityAdmission(REAL_ANALYSIS)).toBeNull();
  });
});

describe("countEvidenceMarkers", () => {
  test("prazan/trivijalan tekst nema dokaza", () => {
    expect(countEvidenceMarkers("")).toBe(0);
    expect(countEvidenceMarkers("Zadatak je gotov.")).toBe(0);
    expect(countEvidenceMarkers(TASK_330)).toBe(0);
  });

  test("stvarni rezultat ima više različitih dokaznih markera", () => {
    expect(countEvidenceMarkers(REAL_RESULT)).toBeGreaterThanOrEqual(EVIDENCE_OVERRIDE_THRESHOLD);
    expect(countEvidenceMarkers(REAL_ANALYSIS)).toBeGreaterThanOrEqual(1);
  });

  test("broji RAZLIČITE vrste, ne ponavljanja iste", () => {
    // Deset istih naredbi = i dalje jedna vrsta dokaza.
    const repeated = Array(10).fill("curl je pokrenut").join(" ");
    expect(countEvidenceMarkers(repeated)).toBe(1);
  });
});

describe("evaluateCompletion — živi dokazi iz baze (D2)", () => {
  test("TASK-329: 'ne mogu pokrenuti test bez detalja' → NEEDS_CONTEXT, ne completed", () => {
    const v = evaluateCompletion(TASK_329);
    expect(v.accept).toBe(false);
    expect(v.code).toBe("incapacity_admission");
    expect(v.label).toBe("NEEDS_CONTEXT");
    expect(v.suggestedStatus).toBe("blocked");
    expect(v.blockedReason).toStartWith("NEEDS_CONTEXT:");
  });

  test("TASK-330: 'nemam pristup alatima' → BLOCKED (nedostaje sposobnost, ne kontekst)", () => {
    const v = evaluateCompletion(TASK_330);
    expect(v.accept).toBe(false);
    expect(v.code).toBe("incapacity_admission");
    expect(v.label).toBe("BLOCKED");
    expect(v.blockedReason).toStartWith("BLOCKED:");
  });

  test("TASK-338: 'Zadatak je gotov.' kao cijeli rezultat → odbijeno", () => {
    const v = evaluateCompletion(TASK_338);
    expect(v.accept).toBe(false);
    expect(v.code).toBe("trivial_result");
    expect(v.suggestedStatus).toBe("blocked");
  });

  test("prazan result_summary → odbijeno", () => {
    expect(evaluateCompletion("").code).toBe("empty_result");
    expect(evaluateCompletion("   \n  ").code).toBe("empty_result");
    expect(evaluateCompletion(null).code).toBe("empty_result");
    expect(evaluateCompletion(undefined).accept).toBe(false);
  });

  test("kratak tekst ispod praga smislenosti → odbijeno", () => {
    const short = "Pogledao sam.";
    expect(short.length).toBeLessThan(MIN_MEANINGFUL_LENGTH);
    expect(evaluateCompletion(short).accept).toBe(false);
  });
});

describe("evaluateCompletion — regresija: pravi rezultati moraju proći", () => {
  test("izvještaj s naredbama, fajlovima i brojevima prolazi", () => {
    const v = evaluateCompletion(REAL_RESULT);
    expect(v.accept).toBe(true);
    expect(v.code).toBe("ok");
    expect(v.suggestedStatus).toBe("completed");
  });

  test("analitički nalaz s izmjerenim brojkama prolazi", () => {
    expect(evaluateCompletion(REAL_ANALYSIS).accept).toBe(true);
  });

  test("dugi detaljni izvještaj bez naredbi ipak prolazi (no_evidence ima limit duljine)", () => {
    const longProse =
      "Analizirao sam arhitekturu odlučivanja o završnom statusu. ".repeat(30);
    expect(longProse.length).toBeGreaterThan(NO_EVIDENCE_MAX_LENGTH);
    expect(evaluateCompletion(longProse).accept).toBe(true);
  });

  test("spomen ograničenja UZ jake dokaze ne blokira (evidence override)", () => {
    const mixed = `Nisam mogao pristupiti Nextcloudu (offline), ali sam sve ostalo odradio:
- izmijenio /srv/tm/src/core/CompletionGuard.ts
- bun test → 24 pass, 0 fail
- curl PUT vratio HTTP 200`;
    expect(countEvidenceMarkers(mixed)).toBeGreaterThanOrEqual(EVIDENCE_OVERRIDE_THRESHOLD);
    expect(evaluateCompletion(mixed).accept).toBe(true);
  });
});

describe("evaluateCompletion — nema dokaza izvršenja", () => {
  test("kratka tvrdnja o uspjehu bez ijednog dokaza → odbijeno", () => {
    const v = evaluateCompletion(
      "Napravio sam sve što je traženo i sve radi kako treba, provjerio sam dvaput.",
    );
    expect(v.accept).toBe(false);
    expect(v.code).toBe("no_evidence");
    expect(v.label).toBe("NEEDS_CONTEXT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sloj 2, dorada TASK-2959: deklarirani ishod je UGOVOR, proza je fallback.
// ─────────────────────────────────────────────────────────────────────────────
describe("parseDeclaredStatus — obvezni REGOC-STATUS redak", () => {
  test("čita sva tri ishoda s razlogom", () => {
    expect(parseDeclaredStatus("REGOC-STATUS: DONE — guard dodan, 26 testova")).toEqual({
      status: "DONE",
      reason: "guard dodan, 26 testova",
    });
    expect(parseDeclaredStatus("REGOC-STATUS: BLOCKED — nemam pristup repozitoriju")?.status).toBe("BLOCKED");
    expect(parseDeclaredStatus("REGOC-STATUS: NEEDS_CONTEXT — fali opis")?.status).toBe("NEEDS_CONTEXT");
  });

  // TASK-4815: četvrti ishod (CLAUDE.md pravilo 8, MessageQueue.TaskSignal, MonitorLoop).
  // Prije popravka uzorak ga NIJE parsirao uopće — izjava je padala u heuristiku.
  test("čita i DONE_WITH_CONCERNS, i to kao ZAVRŠETAK (uz ograde), ne kao odbijanje", () => {
    expect(parseDeclaredStatus("REGOC-STATUS: DONE_WITH_CONCERNS — dio nije provjeren")).toEqual({
      status: "DONE_WITH_CONCERNS",
      reason: "dio nije provjeren",
    });
    expect(parseDeclaredStatus("REGOC-STATUS: DONE-WITH-CONCERNS")?.status).toBe("DONE_WITH_CONCERNS");
    // goli DONE ne smije pojesti prefiks i oboriti podudaranje
    expect(parseDeclaredStatus("REGOC-STATUS: DONE — sve provjereno")?.status).toBe("DONE");
  });

  test("DONE_WITH_CONCERNS ne obara zatvaranje — obitelj gotovo", () => {
    const text = [
      "Popravljen parser, 43 testa prolaze (bun test tests/agent-output-parser.test.ts).",
      "Dodana datoteka AgentOutputParser.ts, 0 fail.",
      "REGOC-STATUS: DONE_WITH_CONCERNS — sjena nije pokrenuta",
    ].join("\n");
    const v = evaluateCompletion(text);
    expect(v.accept).toBe(true);
  });

  test("tolerira varijante zapisa (NEEDS-CONTEXT, dvotočje, markdown bold)", () => {
    expect(parseDeclaredStatus("**REGOC-STATUS: NEEDS-CONTEXT: fali opis**")?.status).toBe("NEEDS_CONTEXT");
    expect(parseDeclaredStatus("regoc_status = done")?.status).toBe("DONE");
  });

  test("mjerodavno je ZADNJE pojavljivanje (agent smije citirati protokol)", () => {
    const text = `Protokol kaže: REGOC-STATUS: DONE — primjer iz uputa.
Napravio sam analizu, ali ne mogu dalje.
REGOC-STATUS: NEEDS_CONTEXT — nedostaje specifikacija`;
    expect(parseDeclaredStatus(text)?.status).toBe("NEEDS_CONTEXT");
  });

  test("nema retka → null", () => {
    expect(parseDeclaredStatus(REAL_RESULT)).toBeNull();
    expect(parseDeclaredStatus("")).toBeNull();
  });
});

describe("evaluateCompletion — deklaracija ima prednost pred prozom", () => {
  test("deklarirani BLOCKED ruši zatvaranje i kad tekst vrvi dokazima", () => {
    const text = `Pokrenula sam bun test → 24 pass, curl je vratio HTTP 200, dirala /home/x/y.ts.
REGOC-STATUS: BLOCKED — nemam ovlasti za deploy`;
    const v = evaluateCompletion(text);
    expect(v.accept).toBe(false);
    expect(v.code).toBe("declared_not_done");
    expect(v.label).toBe("BLOCKED");
    expect(v.confidence).toBe("declared");
  });

  test("deklarirani DONE prolazi i nosi confidence=declared", () => {
    const v = evaluateCompletion(`Sredila sam gate i testove u CompletionGuard.ts.
REGOC-STATUS: DONE — 26 testova zeleno`);
    expect(v.accept).toBe(true);
    expect(v.confidence).toBe("declared");
  });

  test("goli 'REGOC-STATUS: DONE' bez sadržaja NE prolazi (nova rupa se ne otvara)", () => {
    expect(evaluateCompletion("REGOC-STATUS: DONE").accept).toBe(false);
  });

  test("bez deklaracije sud je heuristički i tako označen", () => {
    expect(evaluateCompletion(REAL_RESULT).confidence).toBe("heuristic");
    expect(evaluateCompletion(TASK_330).confidence).toBe("heuristic");
  });
});

describe("shouldEnforce — shadow rollout (dorada TASK-2959)", () => {
  const shadow: GateConfig = { enabled: true, live: false, deterministicLive: true };
  const live: GateConfig = { enabled: true, live: true, deterministicLive: true };
  const off: GateConfig = { enabled: false, live: true, deterministicLive: true };

  test("default konfiguracija je SHADOW (live=false)", () => {
    expect(DEFAULT_GATE_CONFIG.live).toBe(false);
    expect(DEFAULT_GATE_CONFIG.enabled).toBe(true);
  });

  test("u shadowu heuristički sud NE blokira (proza ne smije zaustaviti ploču)", () => {
    expect(shouldEnforce(evaluateCompletion(TASK_330), shadow)).toBe(false);
    expect(shouldEnforce(evaluateCompletion(TASK_338), shadow)).toBe(false);
  });

  test("u shadowu se NE-heuristički sudovi ipak provode", () => {
    // Agentova vlastita deklaracija — nije pogađanje.
    expect(shouldEnforce(evaluateCompletion("Analiza je gotova.\nREGOC-STATUS: BLOCKED — fali pristup"), shadow)).toBe(true);
    // Prazan rezultat je prazan u svakom modu.
    expect(shouldEnforce(evaluateCompletion(""), shadow)).toBe(true);
  });

  test("u liveu se provodi sve što nije prihvaćeno", () => {
    expect(shouldEnforce(evaluateCompletion(TASK_330), live)).toBe(true);
    expect(shouldEnforce(evaluateCompletion(TASK_338), live)).toBe(true);
  });

  test("prihvaćen rezultat se nikad ne provodi, a isključen gate ništa ne radi", () => {
    expect(shouldEnforce(evaluateCompletion(REAL_RESULT), live)).toBe(false);
    expect(shouldEnforce(evaluateCompletion(TASK_330), off)).toBe(false);
  });
});

describe("verdict je uvijek strojno upotrebljiv", () => {
  const cases: Array<string | null | undefined> = [
    "", TASK_329, TASK_330, TASK_338, REAL_RESULT, REAL_ANALYSIS, null,
  ];
  test("svaki verdict ima popunjena polja i konzistentan suggestedStatus", () => {
    for (const c of cases) {
      const v: CompletionVerdict = evaluateCompletion(c);
      expect(typeof v.accept).toBe("boolean");
      expect(v.reason.length).toBeGreaterThan(0);
      expect(v.suggestedStatus).toBe(v.accept ? "completed" : "blocked");
      if (!v.accept) expect(v.blockedReason.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-4724: oznaka suda u porukama. `label` je null kad je sud `accept()` — a
// zadatak ipak nije zatvoren (kritičar ga je oborio: RegocDaemon.ts treatAsDone=false).
// Tada je `${verdict.label}` ispisivao doslovno "(null)" u Telegram/konzola poruci.
// ─────────────────────────────────────────────────────────────────────────────
describe("formatVerdictLabel — nikad doslovni 'null' u poruci", () => {
  test("prihvaćen sud (label null) daje čitljiv nadomjestak, ne 'null'", () => {
    const v = evaluateCompletion(REAL_RESULT);
    expect(v.label).toBeNull();
    expect(formatVerdictLabel(v)).toBe("n/a");
  });

  test("odbijen sud vraća svoju oznaku doslovno", () => {
    expect(formatVerdictLabel(evaluateCompletion(TASK_330))).toBe("BLOCKED");
    expect(formatVerdictLabel(evaluateCompletion(TASK_329))).toBe("NEEDS_CONTEXT");
  });

  test("nijedan sud nikad ne formatira u 'null'/'undefined'", () => {
    for (const c of ["", TASK_329, TASK_330, TASK_338, REAL_RESULT, REAL_ANALYSIS, null]) {
      const s = formatVerdictLabel(evaluateCompletion(c));
      expect(s.length).toBeGreaterThan(0);
      expect(["null", "undefined"]).not.toContain(s);
    }
  });

  // U paketu nema demona; ista brana gleda ploču i paketni orkestrator.
  test.each(["src/TaskWebUI.ts", "src/core/orchestrator/Orchestrator.ts"])("regresija: %s ne interpolira verdict.label bez nadomjestka", async (rel) => {
    const src = await Bun.file(`${import.meta.dir}/../${rel}`).text();
    const gola = src.split("\n")
      .map((redak, i) => ({ redak, br: i + 1 }))
      .filter(({ redak }) => /\$\{verdict\.label\}/.test(redak));
    expect(gola.map(g => `${g.br}: ${g.redak.trim()}`)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E1/TASK-4787 — sloj IZVRŠITELJA. Doslovni zapis iz baze čvora cvor-1 (TASK-152,
// qa @ ollama:qwen3:8b, 09.09.2026. 08:26Z). Artefakt je bio NETOČAN
// (~/.tmp/regresija_cvor.txt sadrži literal `$(uname -a)`), a izvještaj
// tvrdi suprotno. Stari vratar ga je pustio: ACCEPT conf=heuristic evidence=2.
// ─────────────────────────────────────────────────────────────────────────────
const TASK_152_CVOR =
  "Datoteka ~/.tmp/regresija_cvor.txt postoji i sadrži izlaz uname -a.  \n" +
  "1. ✅ REGRESIJA samostalnosti cvor-1: zadatak izvršen bez glavnog stroja (datoteka ~/.tmp/regresija_cvor.txt)  \n" +
  "2. ✅ STO: naredba `uname -a` izvršena i zapisana (datoteka ~/.tmp/regresija_cvor.txt)  \n" +
  "3. ✅ JEDNA rečenica: zadatak gotov  \n" +
  "4. ✅ ZASTO: cvor-1 spawna agenta i završava zadatak (dokaz: datoteka)  \n" +
  "5. ✅ KRITERIJ: datoteka postoji i sadrži izlaz (dokaz: datoteka)";

const CFG_E1: GateConfig = {
  ...DEFAULT_GATE_CONFIG,
  localExecutorStrict: true,
  localExecutorStrictLive: true,
  localExecutorRequiresDeclared: false,
  trustedProviders: ["anthropic"],
};

describe("executorTrust", () => {
  test("anthropic je zadano povjerljiv, sve ostalo nije", () => {
    expect(executorTrust("anthropic", CFG_E1)).toBe("trusted");
    expect(executorTrust("ANTHROPIC", CFG_E1)).toBe("trusted");
    expect(executorTrust("ollama", CFG_E1)).toBe("local");
    expect(executorTrust("openrouter", CFG_E1)).toBe("local");
    expect(executorTrust("kimicli", CFG_E1)).toBe("local");
  });

  test("prazan/nepoznat provider ne mijenja stari (CLI) put", () => {
    expect(executorTrust(undefined, CFG_E1)).toBe("trusted");
    expect(executorTrust("", CFG_E1)).toBe("trusted");
    expect(executorTrust(null, CFG_E1)).toBe("trusted");
  });

  test("popis povjerljivih providera je konfigurabilan", () => {
    const cfg: GateConfig = { ...CFG_E1, trustedProviders: ["anthropic", "ollama"] };
    expect(executorTrust("ollama", cfg)).toBe("trusted");
  });
});

describe("evaluateLocalExecutor — regresija TASK-152 (cvor-1)", () => {
  test("stari vratar je izvještaj PRIHVATIO (to je i bio kvar)", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    expect(v.accept).toBe(true);
    expect(v.confidence).toBe("heuristic");
    expect(v.evidence).toBeGreaterThanOrEqual(2);
  });

  test("lokalni izvršitelj bez ijedne pokrenute provjere se ODBIJA", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const e = evaluateLocalExecutor(
      v,
      { provider: "ollama", checksRun: 0, checksFailed: 0, declaredPresent: false },
      CFG_E1,
    );
    expect(e.accept).toBe(false);
    expect(e.code).toBe("unverified_local");
    expect(e.confidence).toBe("executor");
    expect(e.label).toBe("NEEDS_CONTEXT");
    expect(e.suggestedStatus).toBe("blocked");
    expect(e.blockedReason).toContain("[PROVJERA] cmd:");
    expect(e.reason).toContain("ollama");
  });

  test("isti izvještaj od anthropic izvršitelja prolazi (nema regresije na glavnom stroju)", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    expect(evaluateLocalExecutor(v, { provider: "anthropic", checksRun: 0 }, CFG_E1).accept).toBe(true);
    expect(evaluateLocalExecutor(v, {}, CFG_E1).accept).toBe(true);
  });

  test("nezavisna provjera koja je POKRENUTA i prošla otključava zatvaranje", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const e = evaluateLocalExecutor(
      v,
      { provider: "ollama", checksRun: 1, checksFailed: 0, declaredChecksRun: 1, declaredPresent: true },
      CFG_E1,
    );
    expect(e.accept).toBe(true);
    expect(e.code).toBe("ok");
  });

  test("provjera je pokrenuta ali je PALA → BLOCKED, ne NEEDS_CONTEXT", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const e = evaluateLocalExecutor(
      v,
      { provider: "ollama", checksRun: 2, checksFailed: 1, declaredChecksRun: 1, declaredPresent: true },
      CFG_E1,
    );
    expect(e.accept).toBe(false);
    expect(e.label).toBe("BLOCKED");
    expect(e.code).toBe("unverified_local");
  });

  test("stroža postava traži baš provjeru propisanu zadatkom", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const cfg: GateConfig = { ...CFG_E1, localExecutorRequiresDeclared: true };
    // parse/lint provjere su se pokrenule, ali zadatak nije propisao svoju
    const e = evaluateLocalExecutor(
      v,
      { provider: "ollama", checksRun: 3, checksFailed: 0, declaredChecksRun: 0, declaredPresent: false },
      cfg,
    );
    expect(e.accept).toBe(false);
    expect(e.code).toBe("unverified_local");
    // uz labaviju postavu ista situacija prolazi
    expect(evaluateLocalExecutor(v, { provider: "ollama", checksRun: 3, checksFailed: 0 }, CFG_E1).accept).toBe(true);
  });

  test("sud nikad ne pretvara ODBIJANJE u prihvaćanje", () => {
    const odbijen = evaluateCompletion(TASK_338);
    expect(odbijen.accept).toBe(false);
    const e = evaluateLocalExecutor(odbijen, { provider: "ollama", checksRun: 5, checksFailed: 0 }, CFG_E1);
    expect(e.accept).toBe(false);
    expect(e.code).toBe(odbijen.code);
  });

  test("ugašen mehanizam vraća sud nedirnut (bajt-identičan stari put)", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const off: GateConfig = { ...CFG_E1, localExecutorStrict: false };
    expect(evaluateLocalExecutor(v, { provider: "ollama", checksRun: 0 }, off)).toEqual(v);
    const disabled: GateConfig = { ...CFG_E1, enabled: false };
    expect(evaluateLocalExecutor(v, { provider: "ollama", checksRun: 0 }, disabled)).toEqual(v);
  });

  // QA/TASK-4789: obrambeni Math.max(0, …) oko brojača nema izravan test — pozivatelj
  // (kritičar) šalje brojeve dobivene filter().length pa ne bi trebao dati negativu, ali
  // ako ikad dâ (npr. tuđi patch pokvari brojanje), sud NE smije tiho "prihvatiti" zbog
  // negativnog broja koji slučajno prođe `> 0` provjeru u drugom smjeru.
  test("negativni/NaN brojači ne ruše sud niti ga lažno otvaraju", () => {
    const v = evaluateCompletion(TASK_152_CVOR);
    const negativan = evaluateLocalExecutor(
      v,
      { provider: "ollama", checksRun: -3, checksFailed: -1, declaredPresent: false },
      CFG_E1,
    );
    expect(negativan.accept).toBe(false);
    expect(negativan.matched).toContain("pokrenuto=0");
    expect(negativan.matched).toContain("palo=0");
  });
});

describe("shouldEnforce — sud o izvršitelju ima vlastiti prekidač", () => {
  const v = evaluateCompletion(TASK_152_CVOR);
  const odbijen = (cfg: GateConfig) =>
    evaluateLocalExecutor(v, { provider: "ollama", checksRun: 0, declaredPresent: false }, cfg);

  test("shadow (zadano): sud se donosi, ali NE blokira", () => {
    const cfg: GateConfig = { ...DEFAULT_GATE_CONFIG, localExecutorStrictLive: false };
    const e = odbijen({ ...cfg, localExecutorStrict: true });
    expect(e.accept).toBe(false);
    expect(shouldEnforce(e, { ...cfg, localExecutorStrict: true })).toBe(false);
  });

  test("live: blokira", () => {
    expect(shouldEnforce(odbijen(CFG_E1), CFG_E1)).toBe(true);
  });

  test("ne provodi se dok je cijeli gate ugašen", () => {
    const cfg: GateConfig = { ...CFG_E1, enabled: false };
    expect(shouldEnforce({ ...odbijen(CFG_E1) }, cfg)).toBe(false);
  });

  test("prozni sloj i dalje čeka `live` (E1 ga ne otključava)", () => {
    const proza = evaluateCompletion("Napravio sam sve što je traženo i sve radi kako treba u sustavu.");
    expect(proza.accept).toBe(false);
    expect(shouldEnforce(proza, CFG_E1)).toBe(false);
  });

  test("zadana postava je SHADOW (nova vrata ne smiju zaustaviti ploču same od sebe)", () => {
    expect(DEFAULT_GATE_CONFIG.localExecutorStrict).toBe(true);
    expect(DEFAULT_GATE_CONFIG.localExecutorStrictLive).toBe(false);
    expect(DEFAULT_GATE_CONFIG.trustedProviders).toEqual(["anthropic"]);
  });
});
