import { describe, test, expect } from "bun:test";
import {
  isRecycledAgentReport,
  isCompletionReport,
  isAgentLifecycleNotice,
  isEmptyOrFixtureTask,
  emptyOrFixtureReason,
  EMPTY_TASK_REASON_TEXT,
  isNonActionableMessage,
  isSchedulerQueueNotice,
  hashContent,
  normalizeForDedup,
  evaluateDispatch,
  recordDispatch,
  DISPATCH_DEDUP_WINDOW_MS,
  type DispatchRecord,
} from "../src/core/DispatchGuard";

// A real recycled-report payload, distilled from the TASK-637 chain.
const RECYCLED_REPORT = `## Originalni zahtjev od: arhitekt

📋 SUMMARY: TASK-634 je već completed — recikliran meta-summary bez koda.
🔍 ANALYSIS: description je doslovna kopija prethodnog SUMMARY-ja.
⚡ ACTIONS:
- GET /api/tasks/TASK-634 → 200
✅ RESULTS: Živa veza potvrđena.
📊 STATUS: DONE_WITH_CONCERNS
🗣️ Arhitekt: duplikat liveness task.

**Zašto:** Implementacijski zadatak`;

// Doslovni tekst iz RegocDaemon.ts:1831/2040 (sendResponse na popunjene slotove).
const QUEUE_FULL = "⏳ Svi agent slotovi zauzeti (3/3). Pokušaj ponovno za par minuta.";

// TASK-2971: doslovan sadržaj poruke messages.db id=… (regoc→istrazivac, message_type
// 'text', 2026-07-28 10:46:22) — RegocDaemon.ts:1120 sendResponse upisuje status
// u inbox POŠILJATELJA bez ikakvog omota, pa sidro na početak stringa vrijedi.
const DAEMON_STATUS_VERBATIM = `🤖 **REGOČ Daemon Status**

✅ Daemon aktivan (PID: 3683053)
⏱️ Uptime: 0h 6m
📊 Obrađeno poruka: 3
📜 GEMINI.md: Učitan (23 pravila)
📋 Agent Registry: 12 agenata

Kontekst: 0%
Zadnja aktivnost: tester: "Nalaz: nije loop-bug nego stva..." → delegate`;

// Negativna kontrola za isti uzorak: prava specifikacija koja tu obavijest samo
// CITIRA (kao što je opis ovog zadatka) mora proći guard.
const SPEC_QUOTING_STATUS = `DispatchGuard rupa: "REGOČ Daemon Status" ping se izvršava kao zadatak.

ŠTO: LIFECYCLE_PATTERNS ne prepoznaje daemonovu vlastitu statusnu poruku koju
generira RegocDaemon.ts:1646:

🤖 **REGOČ Daemon Status**
✅ Daemon aktivan (PID: 3683053)
📊 Obrađeno poruka: 3

KAKO: dodati sidreni uzorak u LIFECYCLE_PATTERNS i test uz postojeće guard testove.`;

const REAL_SPEC = `Implementiraj dedup-guard u dispatcheru: prije kreiranja taska
provjeri je li sadržaj recikliran izvještaj ili duplikat unutar prozora od 15 min.
Dodaj unit testove i ne restartaj daemon sam.`;

// TASK-3605: DOSLOVAN sadržaj poruke koja je 02.09.2026. 11:30:15 stigla od kosjenke
// i koju je RegocDaemon pretvorio u TASK-3605 ("🎯 Delegating to arhitekt: Arhitektura:
// Done. Summary of TASK-3587…"). Nula CORE emoji-markera → stari guard ju je propustio.
const PLAIN_COMPLETION_REPORT = `Done. Summary of TASK-3587 (s7 subtask of TASK-2569):

**Completed:**
1. **Flags + restart** — \`tierRecipesEnabled\` and \`verificationGateShadow\` flipped to \`true\` in \`features.json\` (backed up first).
2. **Canary E2/E3** — Created TASK-3602/3603, tagged for haiku.
3. **verificationGateLive proof** — Regression suites (8/8, 10/10) pass.

**Final flag state:** \`tierRecipesEnabled=true\`, \`verificationGateShadow=true\`.`;

// Negativna kontrola: prava specifikacija koja SPOMINJE protokol izvještavanja
// (jedan sidreni marker) mora proći — prag je 2.
const SPEC_MENTIONING_STATUS_LINE = `Dodaj u AgentDaemon.buildPrompt() uputu da zadnji redak
odgovora bude REGOC-STATUS: DONE — <što je isporučeno>, jer daemon čita točno taj redak.
Fajlovi: AgentDaemon.ts, tests/AgentDaemon.recipe.test.ts. Kriterij: 10 pass, 0 fail.`;

describe("isCompletionReport (TASK-3605)", () => {
  test("flags a plain-markdown completion report (no CORE emoji markers)", () => {
    expect(isRecycledAgentReport(PLAIN_COMPLETION_REPORT)).toBe(false); // stari guard ga NE hvata
    expect(isCompletionReport(PLAIN_COMPLETION_REPORT)).toBe(true);
    expect(isNonActionableMessage(PLAIN_COMPLETION_REPORT)).toBe(true);
  });

  test("blocks it at the dispatch decision point", () => {
    const v = evaluateDispatch(PLAIN_COMPLETION_REPORT, new Map(), Date.now());
    expect(v.block).toBe(true);
    expect(v.code).toBe("recycled_report");
  });

  test("a spec that merely mentions REGOC-STATUS passes (1 marker < threshold 2)", () => {
    expect(isCompletionReport(SPEC_MENTIONING_STATUS_LINE)).toBe(false);
    expect(isNonActionableMessage(SPEC_MENTIONING_STATUS_LINE)).toBe(false);
  });

  test("genuine specs and quoted-status specs still pass", () => {
    expect(isCompletionReport(REAL_SPEC)).toBe(false);
    expect(isCompletionReport(SPEC_QUOTING_STATUS)).toBe(false);
    expect(isCompletionReport("")).toBe(false);
  });
});

describe("isRecycledAgentReport", () => {
  test("flags a recycled REGOČ report (≥3 markers)", () => {
    expect(isRecycledAgentReport(RECYCLED_REPORT)).toBe(true);
  });

  test("passes a genuine task specification", () => {
    expect(isRecycledAgentReport(REAL_SPEC)).toBe(false);
  });

  test("does not flag content with only 1-2 incidental markers", () => {
    expect(isRecycledAgentReport("📋 SUMMARY: kratka biljeska o featureu")).toBe(false);
    expect(isRecycledAgentReport("📋 SUMMARY i 📊 STATUS spomenuti usput")).toBe(false);
  });

  test("empty content is not a report", () => {
    expect(isRecycledAgentReport("")).toBe(false);
  });
});

// The actual payloads that evaded the SUMMARY-only guard and kept the
// AgentDaemon echo loop alive (TASK-2426/2427 chain, 2026-06-21).
const REZULTAT_REPORT = `✅ **Dizajner** završio zadatak:

📋 REZULTAT: Zatvorio sam TASK-2427 kao no-op.
📊 STATUS: Uspješno
➡️ SLJEDEĆI KORACI: Čekam pravu specifikaciju.`;

const AGENT_STARTED = `✅ **Agent Istrazivac pokrenut**

**Task ID:** TASK-2426
**Agent:** Istrazivac (Researcher)
**Model:** opus`;

const AGENT_FINISHED = `✅ **Arhitekt** završio zadatak: zatvorila phantom task.`;

const DELEGATION_BLOCKED = `🛑 **Delegacija blokirana (dedup-guard)**

Sadržaj koji se delegira je već gotov agent-izvještaj (PAI format).`;

const REFUSAL_NOTICE =
  "🛑 Poruka prepoznata kao završni izvještaj / sistemska obavijest, ne kao specifikacija — NE otvaram novi zadatak. Ako je ovo stvarno novi posao, pošalji ga kao specifikaciju (ŠTO / ZAŠTO / KOJI fajlovi / KRITERIJ gotovosti).";

describe("isAgentLifecycleNotice", () => {
  test("flags 'Agent X pokrenut' start notice", () => {
    expect(isAgentLifecycleNotice(AGENT_STARTED)).toBe(true);
  });
  test("flags 'X završio/završila zadatak' finish notice", () => {
    expect(isAgentLifecycleNotice(AGENT_FINISHED)).toBe(true);
    expect(isAgentLifecycleNotice("✅ **Dizajner** završio zadatak: nešto")).toBe(true);
  });
  test("flags the dedup-guard block notice echoed back", () => {
    expect(isAgentLifecycleNotice(DELEGATION_BLOCKED)).toBe(true);
  });
  test("passes a genuine spec that merely mentions an agent", () => {
    expect(isAgentLifecycleNotice("Dodaj guard u AgentDaemon i pokreni testove.")).toBe(false);
  });

  // TASK-2583 pilot, 2026-07-28 10:39:52: RegocDaemon je potjehu u inbox
  // poslao vlastitu obavijest o zauzetim slotovima; AgentDaemon ju je izvršio
  // kao zadatak (claude --print run) i odgovorio "Nema aktivnog zadatka" —
  // početak echo petlje. RegocDaemon.ts:2680 te obrasce zna, DispatchGuard nije.
  test("flags the daemon's own capacity notice (queue full)", () => {
    expect(isAgentLifecycleNotice(QUEUE_FULL)).toBe(true);
  });
  test("flags the daemon's own error notice", () => {
    expect(isAgentLifecycleNotice("Greška pri obradi zahtjeva: timeout")).toBe(true);
  });
  test("flags the agent-failed notice", () => {
    expect(isAgentLifecycleNotice("❌ Agent Istrazivac neuspješan (exit 1)")).toBe(true);
  });
  // Isti pilot, 10:46:23: istrazivac je potrošila Opus run na daemonov status-ispis.
  test("flags the daemon status dump (RegocDaemon.ts:1646)", () => {
    expect(
      isAgentLifecycleNotice("🤖 **REGOČ Daemon Status**\n\n⏱️ Uptime: 0h 6m\n📊 Obrađeno poruka: 3"),
    ).toBe(true);
  });
  // TASK-2971: gornji uzorak je skraćen. Ovo je DOSLOVAN tekst poruke iz
  // messages.db (regoc→istrazivac, 2026-07-28 10:46:22) na kojoj je AgentDaemon
  // stvarno spawnao Opus sesiju. Regresija se sidri na stvarni artefakt, ne na
  // parafrazu — status nosi i 📊/📋 markere, pa ga kvorum izvještaja NE bi uhvatio.
  test("flags the VERBATIM daemon status message from the 10:46:22 incident", () => {
    expect(isAgentLifecycleNotice(DAEMON_STATUS_VERBATIM)).toBe(true);
    expect(isNonActionableMessage(DAEMON_STATUS_VERBATIM)).toBe(true);
  });
  test("passes a spec that only DESCRIBES those notices (guard-fix task)", () => {
    expect(
      isAgentLifecycleNotice(
        "Popravi zašto se poruka 'Svi agent slotovi zauzeti' izvršava kao zadatak; dodaj obrazac u DispatchGuard.",
      ),
    ).toBe(false);
  });
  // TASK-2971 kriterij (2): sidro na početak poruke postoji upravo zato da opis
  // OVOG zadatka — koji cijeli status-blok citira usred specifikacije — prođe.
  test("passes a spec that QUOTES the status dump inside a larger specification", () => {
    expect(isAgentLifecycleNotice(SPEC_QUOTING_STATUS)).toBe(false);
    expect(isNonActionableMessage(SPEC_QUOTING_STATUS)).toBe(false);
  });

  // TASK-3610: odbijenica koju regoc sam šalje natrag pošiljatelju. Bez ovoga se
  // guard hrani sam sobom (regoc odbije → agent spawna na odbijenicu → spawn pada
  // → '❌ neuspješan' natrag → nova odbijenica); mjereno 683 spawna u 1 h 43 min.
  test("blocks REGOČ's own refusal notice (self-feeding loop, TASK-3610)", () => {
    expect(isAgentLifecycleNotice(REFUSAL_NOTICE)).toBe(true);
    expect(isNonActionableMessage(REFUSAL_NOTICE)).toBe(true);
  });
  test("passes a spec that QUOTES the refusal notice inside a larger specification", () => {
    expect(
      isAgentLifecycleNotice(
        "Popravi petlju: agent spawna na poruku '" + REFUSAL_NOTICE.slice(0, 40) + "'. Dodaj obrazac u DispatchGuard.ts i test.",
      ),
    ).toBe(false);
  });
});

describe("isNonActionableMessage (combined guard at the spawn point)", () => {
  test("catches the REZULTAT-format report that evaded SUMMARY-only markers", () => {
    // Only 1 legacy marker (📊 STATUS) — would NOT trip report quorum alone...
    expect(isNonActionableMessage(REZULTAT_REPORT)).toBe(true);
  });
  test("catches start notice, finish notice, and block notice", () => {
    expect(isNonActionableMessage(AGENT_STARTED)).toBe(true);
    expect(isNonActionableMessage(AGENT_FINISHED)).toBe(true);
    expect(isNonActionableMessage(DELEGATION_BLOCKED)).toBe(true);
  });
  test("catches the full PAI recycled report", () => {
    expect(isNonActionableMessage(RECYCLED_REPORT)).toBe(true);
  });
  test("lets a real task specification through", () => {
    expect(isNonActionableMessage(REAL_SPEC)).toBe(false);
  });
});

describe("normalizeForDedup / hashContent", () => {
  test("same payload from different source agents hashes identically", () => {
    const a = "## Originalni zahtjev od: arhitekt\n\nNapravi X i Y.\n\n**Zašto:** test";
    const b = "## Originalni zahtjev od: inzenjer\n\nNapravi X i Y.\n\n**Zašto:** drugi razlog";
    expect(hashContent(a)).toBe(hashContent(b));
  });

  test("different payloads hash differently", () => {
    expect(hashContent("Napravi feature A")).not.toBe(hashContent("Napravi feature B"));
  });

  test("normalize collapses whitespace and lowercases", () => {
    expect(normalizeForDedup("  Foo   BAR\n\nBaz ")).toBe("foo bar baz");
  });
});

describe("evaluateDispatch", () => {
  const t0 = 1_000_000;

  test("blocks recycled report before any dedup check", () => {
    const seen = new Map<string, DispatchRecord>();
    const v = evaluateDispatch(RECYCLED_REPORT, seen, t0);
    expect(v.block).toBe(true);
    expect(v.code).toBe("recycled_report");
  });

  test("allows a fresh real spec", () => {
    const seen = new Map<string, DispatchRecord>();
    const v = evaluateDispatch(REAL_SPEC, seen, t0);
    expect(v.block).toBe(false);
    expect(v.code).toBe("ok");
  });

  test("blocks a duplicate within the window", () => {
    const seen = new Map<string, DispatchRecord>();
    recordDispatch(REAL_SPEC, { taskId: "TASK-700", agent: "inzenjer", ts: t0 }, seen);
    const v = evaluateDispatch(REAL_SPEC, seen, t0 + 60_000);
    expect(v.block).toBe(true);
    expect(v.code).toBe("duplicate_dispatch");
    expect(v.prior?.agent).toBe("inzenjer");
  });

  test("allows the same content again after the window expires", () => {
    const seen = new Map<string, DispatchRecord>();
    recordDispatch(REAL_SPEC, { taskId: "TASK-700", agent: "inzenjer", ts: t0 }, seen);
    const v = evaluateDispatch(REAL_SPEC, seen, t0 + DISPATCH_DEDUP_WINDOW_MS + 1);
    expect(v.block).toBe(false);
  });

  test("double-dispatch to a SECOND agent is caught (same content, diff source header)", () => {
    const seen = new Map<string, DispatchRecord>();
    const toA = "## Originalni zahtjev od: regoc\n\nObradi senzor podatke.\n\n**Zašto:** A";
    const toB = "## Originalni zahtjev od: tester\n\nObradi senzor podatke.\n\n**Zašto:** B";
    recordDispatch(toA, { taskId: "TASK-800", agent: "istrazivac", ts: t0 }, seen);
    const v = evaluateDispatch(toB, seen, t0 + 5_000);
    expect(v.block).toBe(true);
    expect(v.code).toBe("duplicate_dispatch");
  });
});

// TASK-2701: fixture/prazan task NE smije proci na auto-exec.
// Podloga: incident 2026-07-27 22:42 — `bun test` je upisao ~70 fixtura po runu u
// zivu regoc.db, a P1 auto-exec je na njima spawnao prave Opus sesije.
describe("isEmptyOrFixtureTask", () => {
  const REAL_TITLE = "Auto-exec guard: prazan description ne smije spawnati agenta";
  const REAL_DESC =
    "STO: dodati isEmptyOrFixtureTask u DispatchGuard i pozvati ga u P1 filteru RegocDaemona. KRITERIJ: fixture task se ne spawna.";

  test("prazan description => fixture", () => {
    expect(isEmptyOrFixtureTask("Task 3", "")).toBe(true);
    expect(isEmptyOrFixtureTask("Neki stvarni naslov", "   \n ")).toBe(true);
    expect(isEmptyOrFixtureTask("Neki stvarni naslov", undefined)).toBe(true);
    expect(isEmptyOrFixtureTask("Neki stvarni naslov", null)).toBe(true);
  });

  test("placeholder description iz test-suitea => fixture", () => {
    expect(isEmptyOrFixtureTask("Full Task", "Detailed description")).toBe(true);
    expect(isEmptyOrFixtureTask("Updated Title", "New description")).toBe(true);
    expect(isEmptyOrFixtureTask("Bilo sto", "TBD")).toBe(true);
  });

  test("doslovni fixture naslovi => fixture", () => {
    for (const t of ["Task 1", "Task 2", "Task 3", "Test", "Test Task", "Blocker",
                     "Blocked Task", "Pending 2", "In Progress", "Start Me", "Task to Start"]) {
      expect(isEmptyOrFixtureTask(t, "ima neki tekst koji izgleda kao opis")).toBe(true);
    }
  });

  test("naslov oznacen kao privremen => fixture", () => {
    expect(isEmptyOrFixtureTask("[TEST-R2] stale kandidat (obrisati)", "kanarinac za watchdog")).toBe(true);
  });

  test("prazan naslov => fixture", () => {
    expect(isEmptyOrFixtureTask("", REAL_DESC)).toBe(true);
  });

  test("pravi task s opisom => NIJE fixture", () => {
    expect(isEmptyOrFixtureTask(REAL_TITLE, REAL_DESC)).toBe(false);
  });

  test("pravi task koji samo sadrzi rijec 'test' u naslovu => NIJE fixture", () => {
    expect(isEmptyOrFixtureTask("Testiranje RGMII linka na KSZ9031", REAL_DESC)).toBe(false);
    expect(isEmptyOrFixtureTask("Task queue: dedup guard za auto-exec", REAL_DESC)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-3589: regresija na živi propust 02.09.2026.
// Kosjenkin odgovor u CORE „Minimal Format"-u otvorio je TASK-3589 → 3590 → 3619
// nad samim sobom. Doslovan sadržaj iz regoc.db (GET /api/tasks/TASK-3589).
// ─────────────────────────────────────────────────────────────────────────────

const TASK_3589_VERBATIM = `## Originalni zahtjev od: arhitekt

📋 **SUMMARY:** Sesija je resumirana — mehanički korak TASK-2569 je već završen u prethodnom pozivu.

🗣️ **Arhitekt:** Sesija resumirana. Mehanički korak TASK-2569 je **GOTOV** — svi izlazi kreirani i testirani. Status: DONE.

---

Ako trebate nešto dodatno ili trebate nastaviti s drugim korakom, slobodno navedite. Spremna sam za:
- **Sljedeći korak** (TASK-2584 TierRecipes modul ili integracija gate logike)
- **Verifikaciju** postojećih izlaza
- **Prilagodbe** ako je nešto trebalo drugačije

Koji je sljedeći korak?

---

**Zašto:** Implementacijski zadatak`;

describe("TASK-3589 — minimalni CORE format i podebljani markeri", () => {
  const PRAVA_SPEC =
    "ŠTO: dodati tolerantne markere u DispatchGuard i proširiti ingress TaskWebUI-a. " +
    "KOJI FAJLOVI: src/core/DispatchGuard.ts, src/TaskWebUI.ts. " +
    "KRITERIJ: echo-task se odbija s 422, pravi task prolazi.";

  test("doslovan sadržaj TASK-3589 => recikliran izvještaj (bio je propušten)", () => {
    expect(isRecycledAgentReport(TASK_3589_VERBATIM)).toBe(true);
    expect(isNonActionableMessage(TASK_3589_VERBATIM)).toBe(true);
    expect(evaluateDispatch(TASK_3589_VERBATIM, new Map(), Date.now()).code).toBe("recycled_report");
  });

  test("podebljani markeri se broje jednako kao obični (📋 **SUMMARY:**)", () => {
    const bold = "📋 **SUMMARY:** x\n🔍 **ANALYSIS:** y\n⚡ **ACTIONS:** z";
    const plain = "📋 SUMMARY: x\n🔍 ANALYSIS: y\n⚡ ACTIONS: z";
    expect(isRecycledAgentReport(bold)).toBe(true);
    expect(isRecycledAgentReport(plain)).toBe(true);
  });

  test("podcrtano (__SUMMARY__) se također broji", () => {
    expect(isRecycledAgentReport("📋 __SUMMARY__: a\n📊 __STATUS__: b\n➡️ __NEXT__: c")).toBe(true);
  });

  test("par 📋 SUMMARY + 🗣️ Ime: odlučan je i ispod praga od 3 markera", () => {
    expect(isRecycledAgentReport("📋 SUMMARY: gotovo\n🗣️ Inzenjer: gotovo")).toBe(true);
    expect(isRecycledAgentReport("📋 REZULTAT: gotovo\n🗣️ **Tester:** gotovo")).toBe(true);
  });

  test("sam 📋 SUMMARY bez govorne linije NIJE dovoljan", () => {
    expect(isRecycledAgentReport("📋 SUMMARY: opis promjene koju treba napraviti")).toBe(false);
  });

  test("sama govorna linija bez SUMMARY-ja NIJE dovoljna", () => {
    expect(isRecycledAgentReport("🗣️ Goran: napravi mi X u datoteci Y")).toBe(false);
  });

  test("prava specifikacija (bez CORE markera) prolazi", () => {
    expect(isRecycledAgentReport(PRAVA_SPEC)).toBe(false);
    expect(isNonActionableMessage(PRAVA_SPEC)).toBe(false);
    expect(evaluateDispatch(PRAVA_SPEC, new Map(), Date.now()).block).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-3627: ista vrata, ali na INGRESSU (POST /api/tasks → handleCreateTask).
// Do 02.09.2026. `isEmptyOrFixtureTask` je stajao samo na dispatchu, pa je ingress
// vracao HTTP 201 na `description: ""` (probni TASK-3620/3621 stvoreni u 19:06).
// Ingress mora vratiti RAZLOG, ne samo da/ne — inace posiljatelj ne zna sto popraviti.
// ─────────────────────────────────────────────────────────────────────────────
describe("emptyOrFixtureReason (ingress 422)", () => {
  const REAL_TITLE = "Anti-echo vrata: prazan description prolazi ingress";
  const REAL_DESC =
    "STO: spojiti isEmptyOrFixtureTask na handleCreateTask. ZASTO: prazan task spawna Opus sesiju nad nicim. " +
    "KOJI FAJLOVI: TaskWebUI.ts, DispatchGuard.ts. KRITERIJ: POST s praznim opisom vraca 422.";

  test("prazan opis => empty_description (glavna rupa iz TASK-3620/3621)", () => {
    expect(emptyOrFixtureReason(REAL_TITLE, "")).toBe("empty_description");
    expect(emptyOrFixtureReason(REAL_TITLE, "   \n\t ")).toBe("empty_description");
    expect(emptyOrFixtureReason(REAL_TITLE, undefined)).toBe("empty_description");
    expect(emptyOrFixtureReason(REAL_TITLE, null)).toBe("empty_description");
  });

  test("placeholder opis => placeholder_description", () => {
    for (const d of ["description", "Detailed description", "TBD", "n/a", "test", "-", "..."]) {
      expect(emptyOrFixtureReason(REAL_TITLE, d)).toBe("placeholder_description");
    }
  });

  test("fixture naslov => fixture_title, privremeni => disposable_title", () => {
    // Popis FIXTURE_TITLE je namjerno DOSLOVAN (TASK-2701) — "Critical Task" nije u
    // njemu, takve fixture hvata tek placeholder opis ("Test"). Provjeri oboje.
    expect(emptyOrFixtureReason("Task to Start", REAL_DESC)).toBe("fixture_title");
    expect(emptyOrFixtureReason("Test Task", REAL_DESC)).toBe("fixture_title");
    expect(emptyOrFixtureReason("Critical Task", REAL_DESC)).toBeNull();
    expect(emptyOrFixtureReason("Critical Task", "Test")).toBe("placeholder_description");
    expect(emptyOrFixtureReason("[TEST-R2] kanarinac (obrisati)", REAL_DESC)).toBe("disposable_title");
  });

  test("prazan naslov => empty_title", () => {
    expect(emptyOrFixtureReason("", REAL_DESC)).toBe("empty_title");
    expect(emptyOrFixtureReason(null, REAL_DESC)).toBe("empty_title");
  });

  test("prava specifikacija => null (ingress vraca 201)", () => {
    expect(emptyOrFixtureReason(REAL_TITLE, REAL_DESC)).toBeNull();
    // Naslovi iz zive baze koji sadrze 'test'/'task' ali NISU fixture.
    expect(emptyOrFixtureReason("Testiranje RGMII linka na KSZ9031", REAL_DESC)).toBeNull();
    expect(emptyOrFixtureReason("MUSZG: analitika posjeta, klikova i lijevka u shopu", REAL_DESC)).toBeNull();
  });

  test("svaki razlog ima ljudsko objasnjenje za 422 tijelo", () => {
    for (const r of ["empty_title", "empty_description", "placeholder_description",
                     "fixture_title", "disposable_title"] as const) {
      expect(EMPTY_TASK_REASON_TEXT[r]).toBeTruthy();
      expect(EMPTY_TASK_REASON_TEXT[r].length).toBeGreaterThan(10);
    }
  });

  test("boolean projekcija ostaje u koraku s razlogom (jedan izvor istine)", () => {
    const cases: Array<[string | null, string | null]> = [
      [REAL_TITLE, REAL_DESC], [REAL_TITLE, ""], ["", REAL_DESC],
      ["Task 1", REAL_DESC], [REAL_TITLE, "TBD"], ["Testiranje RGMII linka", REAL_DESC],
    ];
    for (const [t, d] of cases) {
      expect(isEmptyOrFixtureTask(t, d)).toBe(emptyOrFixtureReason(t, d) !== null);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-4753: SCHEDULER-DOJAVA O DOVRŠENOM ZADATKU / PRAZNOM REDU
//
// 07.09.2026. 19:18 RegocScheduler je u 1,3 s stvorio TASK-4742…TASK-4751 iz
// replaya starih dojava iz veljače 2026. Sadržaj svakog je doslovno:
//     Task TASK-F8-00N COMPLETED: <naslov>
//     No more unblocked tasks in queue.
// To nije posao nego obavijest da je posao gotov. Mjereno na tom sadržaju, sva
// četiri dotadašnja vratara su promašila (isRecycledAgentReport/isCompletionReport/
// isAgentLifecycleNotice/isNonActionableMessage = false), pa je auto-exec spawnao
// prave Opus sesije (istrazivac ×7, inzenjer, dizajner) nad nepostojećim poslom. Isti obrazac
// je u veljači već proizveo TASK-359/360/361 (svi cancelled) — 3. pojava klase.
//
// Diskriminator NIJE puka prisutnost fraze (opis OVOG zadatka je citira!), nego
// STRUKTURA: nakon skidanja daemonovog omota svaki preostali redak tijela mora
// biti redak dojave. Spec koji dojavu citira ima i drugi sadržaj → prolazi.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEDULER_ECHO_TASKS: Array<{ id: string; title: string; description: string }> = [
  {
    id: "TASK-4742",
    title: `Zahtjev: Task TASK-F8-001 COMPLETED: Directory Setup
No mor...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-001 COMPLETED: Directory Setup
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4743",
    title: `Zahtjev: Task TASK-F8-002 COMPLETED: Core Types
No more unb...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-002 COMPLETED: Core Types
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4744",
    title: `Zahtjev: Task TASK-F8-003 COMPLETED: TaskManager.ts
No more...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-003 COMPLETED: TaskManager.ts
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4745",
    title: `Zahtjev: Task TASK-F8-004 COMPLETED: RegocScheduler.ts
No m...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-004 COMPLETED: RegocScheduler.ts
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4746",
    title: `Zahtjev: Task TASK-F8-005 COMPLETED: NotificationService.ts...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-005 COMPLETED: NotificationService.ts
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4747",
    title: `Zahtjev: Task TASK-F8-006 COMPLETED: Sucelje Integration
No...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-006 COMPLETED: Sucelje Integration
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4748",
    title: `Zahtjev: Task TASK-F8-007 COMPLETED: Glas Integration
No...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-007 COMPLETED: Glas Integration
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4749",
    title: `Implementacija: Task TASK-F8-008 COMPLETED: Security Implementatio...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-008 COMPLETED: Security Implementation
No more unblocked tasks in queue.

---

**Zašto:** Implementacijski zadatak`,
  },
  {
    id: "TASK-4750",
    title: `Zahtjev: Task TASK-F8-009 COMPLETED: Testing
No more unbloc...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-009 COMPLETED: Testing
No more unblocked tasks in queue.

---

**Zašto:** Općeniti zahtjev - nijedan keyword nije matchao specifičnog agenta`,
  },
  {
    id: "TASK-4751",
    title: `Design: Task TASK-F8-010 COMPLETED: Web UI Setup
No more u...`,
    description: `## Originalni zahtjev od: scheduler

Task TASK-F8-010 COMPLETED: Web UI Setup
No more unblocked tasks in queue.

---

**Zašto:** Frontend/Design zadatak`,
  },
];

/** Gola dojava kakvu scheduler stavi na sabirnicu, prije daemonovog omota. */
const SCHEDULER_NOTICE_BARE = `Task TASK-F8-008 COMPLETED: Security Implementation
No more unblocked tasks in queue.`;

/** Negativna kontrola #1: doslovni ZAŠTO-blok specifikacije OVOG zadatka (TASK-4753).
 *  Citira OBJE fraze, uključujući redak koji počinje s "Task TASK-… COMPLETED:" —
 *  ako guard gleda samo prisutnost fraze, ovaj tekst pada, a s njim i svaki budući
 *  incident-report o ovoj klasi. */
const SPEC_QUOTING_SCHEDULER_NOTICE = `## ZAŠTO (dokaz, 07.09.2026. 19:18)
RegocScheduler je u 1,3 s stvorio 10 zadataka TASK-4742…TASK-4751 iz replaya starih dojava iz veljače 2026. Sadržaj svakog je doslovno:
  Task TASK-F8-00N COMPLETED: <naslov>
  No more unblocked tasks in queue.
To NIJE posao nego obavijest da je posao gotov. Isti obrazac je u veljači već proizveo TASK-359/360/361 (svi cancelled) — dakle ponavlja se.

Izmjereno (bun t4749_check.ts) na tom doslovnom sadržaju:
  isRecycledAgentReport: false
  isCompletionReport: false
  isAgentLifecycleNotice: false
  isNonActionableMessage: false
Sva četiri vratara promaše → evaluateDispatch pušta → auto-exec spawna prave Opus sesije (istrazivac ×7, inzenjer, dizajner) na nepostojećem poslu.`;

/** Negativna kontrola #2: prava specifikacija koja usput spominje "COMPLETED". */
const SPEC_MENTIONING_COMPLETED = `Dodaj u RegocScheduler.ts provjeru da se dojava
"Task <ID> COMPLETED" NE šalje na dispatch nego samo u log. Kad zadnji zadatak lanca
prijeđe u COMPLETED, scheduler danas emitira poruku koja završi kao novi zadatak.
KOJI FAJLOVI: RegocScheduler.ts, DispatchGuard.ts.
KRITERIJ: POST /api/tasks s tim sadržajem vraća 422, a lanac se i dalje zatvara.`;

describe("isSchedulerQueueNotice (TASK-4753)", () => {
  test("svih 10 doslovnih opisa TASK-4742…4751 je odbijeno", () => {
    expect(SCHEDULER_ECHO_TASKS.length).toBe(10);
    for (const t of SCHEDULER_ECHO_TASKS) {
      expect(`${t.id}:${isSchedulerQueueNotice(t.description)}`).toBe(`${t.id}:true`);
      expect(`${t.id}:${isNonActionableMessage(t.description)}`).toBe(`${t.id}:true`);
    }
  });

  test("evaluateDispatch blokira s kodom 'scheduler_notice'", () => {
    for (const t of SCHEDULER_ECHO_TASKS) {
      const v = evaluateDispatch(t.description, new Map(), Date.now());
      expect(`${t.id}:${v.block}:${v.code}`).toBe(`${t.id}:true:scheduler_notice`);
      expect(v.reason.length).toBeGreaterThan(20);
    }
  });

  test("ingress-sonda: opis SAM za sebe je odbijen (TaskWebUI provjerava desc || title+desc)", () => {
    // Naslov je u bazi skraćen ("…No mor..."), pa spojena sonda ne mora pogoditi —
    // vrata drže jer `handleCreateTask` testira i goli opis.
    for (const t of SCHEDULER_ECHO_TASKS) {
      const echoProbeDesc = t.description;
      const echoProbeFull = `${t.title}\n${t.description}`;
      expect(isNonActionableMessage(echoProbeDesc) || isNonActionableMessage(echoProbeFull)).toBe(true);
    }
  });

  test("gola dojava sa sabirnice (bez daemonovog omota) je odbijena", () => {
    expect(isSchedulerQueueNotice(SCHEDULER_NOTICE_BARE)).toBe(true);
    expect(isNonActionableMessage(SCHEDULER_NOTICE_BARE)).toBe(true);
  });

  test("sama obavijest o praznom redu je odbijena, u obje inačice", () => {
    expect(isSchedulerQueueNotice("No more unblocked tasks in queue.")).toBe(true);
    expect(isSchedulerQueueNotice("Queue is empty")).toBe(true);
    expect(isSchedulerQueueNotice("Queue empty.")).toBe(true);
  });

  test("varijanta bez retka o redu, ali s više dovršenih zadataka, je odbijena", () => {
    expect(isSchedulerQueueNotice(
      "Task TASK-F8-001 COMPLETED: Directory Setup\nTask TASK-F8-002 COMPLETED: Core Types",
    )).toBe(true);
  });

  // ── negativna kontrola: nula lažnih pozitiva ──────────────────────────────
  test("specifikacija OVOG zadatka (citira obje fraze) PROLAZI", () => {
    expect(isSchedulerQueueNotice(SPEC_QUOTING_SCHEDULER_NOTICE)).toBe(false);
    expect(isNonActionableMessage(SPEC_QUOTING_SCHEDULER_NOTICE)).toBe(false);
    expect(evaluateDispatch(SPEC_QUOTING_SCHEDULER_NOTICE, new Map(), Date.now()).block).toBe(false);
  });

  test("spec koji usput spominje COMPLETED prolazi", () => {
    expect(isSchedulerQueueNotice(SPEC_MENTIONING_COMPLETED)).toBe(false);
    expect(isNonActionableMessage(SPEC_MENTIONING_COMPLETED)).toBe(false);
  });

  test("postojeći korpus se ne mijenja — nijedan raniji uzorak nije scheduler-dojava", () => {
    for (const s of [REAL_SPEC, SPEC_QUOTING_STATUS, SPEC_MENTIONING_STATUS_LINE,
                     RECYCLED_REPORT, PLAIN_COMPLETION_REPORT, AGENT_STARTED, DAEMON_STATUS_VERBATIM]) {
      expect(isSchedulerQueueNotice(s)).toBe(false);
    }
  });

  test("prazan sadržaj nije dojava", () => {
    expect(isSchedulerQueueNotice("")).toBe(false);
    expect(isSchedulerQueueNotice("   \n\n  ")).toBe(false);
  });
});
