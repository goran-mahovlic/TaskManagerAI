// src/core/LiveDbGuard.ts
//
// ZADNJA LINIJA OBRANE: test-proces ne smije otvoriti ZIVU regoc.db za pisanje.
//
// ZASTO POSTOJI (TASK-3020, nalaz iz TASK-2560):
//   `bun test` je kroz TaskManager/TaskManagerSQL bez eksplicitnog dbPath-a pisao
//   fixture taskove ("Full Task", "Task 1", "Pending 2"...) ravno u produkcijsku
//   bazu orkestratora. Posljedica NIJE bila samo prljava statistika:
//   pending fixture s assigneejem je RegocDaemon.processP1Tasks pokupio kao pravi
//   zadatak i 2026-07-27 spawnao tri Opus sesije na smecu (TASK-2794/2829/2947),
//   a fixture s priority=1 je trigger auto_queue_p1_tasks gurao u execution_queue.
//   Postojece mitigacije (TASK-2701 heuristika po tasksDir-u, TASK-2950 db-fixture)
//   su per-callsite i po konvenciji — ovaj guard je strukturni backstop koji hvata
//   i buduci test koji na njih zaboravi.
//
// DIZAJN — dvije provjere koje MORAJU obje biti istinite da bi guard opalio:
//   1. Vrtimo li se u test-runneru.
//   2. Cilja li putanja BAS zivu produkcijsku bazu.
//
// Zasto se PRAVI home cita iz /etc/passwd, a ne iz $HOME:
//   e2e testovi (completion-guard-e2e, project-inheritance-e2e, task-field-aliases,
//   prompt-project-live) namjerno podizu TaskWebUI s podmetnutim HOME-om, pa im je
//   `$HOME/.taskmanager/data/tasks.db` VLASTITA sandbox baza koju smiju pisati.
//   Guard vezan uz $HOME bi njih lazno blokirao, a pravu bazu propustio kad je HOME
//   podmetnut. os.homedir()/os.userInfo() u Bunu 1.3.6 slijede $HOME (izmjereno),
//   pa je passwd jedini izvor koji spoofing ne moze pomaknuti.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Dodatne zive baze (npr. orkestrator koji na istom stroju vrti vlastitu plocu) — popis
 * putanja odvojen dvotockom. TASK-5108: prije je to bio tvrdi raspored mapa jedne
 * instalacije; paket ga ne smije podrazumijevati, pa se zadaje izricito.
 */
const LIVE_DB_ENV = 'TM_LIVE_DB';

/** Izlaz za nuzdu: test koji SVJESNO smije dirati zivu bazu (npr. readonly probe). */
const ESCAPE_HATCH_ENV = 'REGOC_ALLOW_LIVE_DB_IN_TEST';

/**
 * Pravi home korisnika iz /etc/passwd — imun na podmetnuti $HOME.
 * Fallback na os.homedir() ako passwd nije citljiv (ne-Linux, distroless).
 */
export function realHomedir(): string {
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (uid >= 0) {
      const line = fs
        .readFileSync('/etc/passwd', 'utf-8')
        .split('\n')
        .find((l) => l.split(':')[2] === String(uid));
      const home = line?.split(':')[5];
      if (home) return home;
    }
  } catch {
    /* pad na os.homedir() */
  }
  return os.homedir();
}

/** Zive baze zadane kroz `TM_LIVE_DB` — cita se pri svakoj provjeri. */
export function dodatneZiveBaze(): string[] {
  return String(process.env[LIVE_DB_ENV] || '').split(':').map((p) => p.trim()).filter(Boolean);
}

/**
 * Zadana baza paketa (`core/paths.ts` bez TM_HOME/TM_DB) pod PRAVIM home-om.
 * TASK-5011: otkad paket bez varijabli okoline otvara `~/.taskmanager/data/tasks.db`,
 * to je ziva baza svakog korisnika paketa — test bez izricite putanje ne smije u nju.
 */
export const PAKET_DB_PATH = path.join(realHomedir(), '.taskmanager', 'data', 'tasks.db');

/**
 * Vrtimo li se pod test-runnerom.
 *
 * POZOR: `BUN_TEST` NE POSTOJI u Bunu 1.3.6 (izmjereno — undefined pod `bun test`),
 * iako ga dokumentacija incidenta spominje. Pouzdan signal je NODE_ENV=test, koji
 * `bun test` postavlja sam. Ostali se drze kao sigurnosna mreza za druge runnere.
 * Provjereno da nijedan produkcijski proces (RegocDaemon, TaskWebUI) nema NODE_ENV=test.
 */
export function isTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_TEST === '1' ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.VITEST !== undefined
  );
}

/** Usporedi putanje preko realpath-a (hvata simlinkove), uz pad na resolve(). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

/**
 * Baci ako test-proces pokusava otvoriti zivu produkcijsku bazu.
 *
 * @param dbPath putanja koju pozivatelj sprema otvoriti
 * @param opener ime pozivatelja, samo za poruku (npr. "TaskManagerSQL")
 */
export function assertNotLiveDbInTest(dbPath: string, opener: string): void {
  if (!isTestRuntime()) return;
  if (process.env[ESCAPE_HATCH_ENV] === '1') return;
  const ziva = [PAKET_DB_PATH, ...dodatneZiveBaze()].find((p) => samePath(dbPath, p));
  if (!ziva) return;

  throw new Error(
    `[LiveDbGuard] ${opener} je pod test-runnerom pokusao otvoriti ZIVU bazu ${ziva}.\n` +
      'Testovi moraju koristiti izoliranu bazu: `new ' +
      opener +
      '(dbPath)` uz tests/helpers/db-fixture.ts\n' +
      '  import { createEmptyTaskDb, makeFixtureRoot } from "./helpers/db-fixture";\n' +
      '  const dbPath = createEmptyTaskDb(path.join(makeFixtureRoot("moj-test"), "t.db"));\n' +
      `Ako test SVJESNO smije dirati zivu bazu, postavi ${ESCAPE_HATCH_ENV}=1.`
  );
}
