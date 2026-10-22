#!/usr/bin/env bun
/**
 * SecurityValidator.hook.ts — sigurnosna vrata za pozive alata i korisničke promptove.
 *
 * TRIGGER: PreToolUse (Bash, Edit, MultiEdit, Write, Read) + UserPromptSubmit
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZAŠTO POSTOJI SLOJ ZA TAJNE (TASK-3043, na nalaz TASK-3041)
 * ───────────────────────────────────────────────────────────────────────────
 * TASK-3041 je dokazao: ŽIVE lozinke i API ključevi leže u čistom tekstu u
 * ~/.claude/projects/**.jsonl. Mehanizam maskiranja NE POSTOJI i ne može postojati
 * kao hook — transkript piše sam harness, a hook ne može prepisati već zapisan redak.
 *
 * Zato je jedina obrana koja stvarno djeluje PREVENCIJA: presresti naredbu PRIJE
 * izvršenja da tajna nikad ne uđe u `tool_result`. To radi handleBash() → judgeBashForSecrets().
 *
 * Ovaj hook je do 29.07.2026. bio MRTAV KOD — postojao je na disku, ali nije bio
 * registriran ni u settings.json ni u settings.local.json (isti obrazac kao
 * DispatchGuard.ts prije TASK-2425). Registracija je dio TASK-3043.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BRANA BRISANJA (ADR-0020 §5.2, TASK-5397)
 *   09.10.2026. obrisan je ~/.tmp/tts_curlic (46,6 GB okoline i modela, bez kopije): ova kuka nije
 *   razlikovala alat od otpada. Sad svaka Bash naredba s rm/unlink/shred/find -delete/rsync --delete
 *   čiji je cilj ispod HOME-a prolazi `presudaNaredbe()` (regoc/tools/servisi/brana_brisanja.ts) i propušta se
 *   samo ako brana za SVAKI cilj kaže DA. Brana je fail-CLOSED (nepovratan ishod); ostatak kuke ostaje
 *   fail-open. Nerazrješiv cilj ($VAR bez vrijednosti) izvan zaštićene zone propušta se uz zapis.
 *   TASK-5403 (Malik H1/H2): brana se učitava dinamički u radniku (lib/brana_radnik.ts) s vlastitim rokom
 *   (10 s, REGOC_BRANA_ROK_MS) — istek roka ili kvar modula = exit 2 za naredbe koje brišu; ostalo radi dalje.
 *
 * IZLAZ (PreToolUse):
 *   - exit 2 + stderr        → tvrda blokada (podržano u svim verzijama harnessa)
 *   - permissionDecision:ask → traži potvrdu korisnika
 *   - {"continue": true}     → propusti (NE forsira "allow", permission sustav i dalje radi)
 *
 * IZLAZ (UserPromptSubmit):
 *   - exit 2 + stderr        → SAMO kad je u promptu doslovna ŽIVA vrijednost iz storea
 *   - additionalContext      → upozorenje kod heurističkog pogotka (bez blokade)
 *
 * NUSPOJAVE:
 *   - Audit log: MEMORY/SECURITY/YYYY/MM/security-YYYYMMDD.jsonl (APPEND, jedan red = jedan događaj)
 *     Prije TASK-3043 je svaki događaj pisao ZASEBAN fajl → `sudo` alert bi u tjedan dana
 *     napravio tisuće fajlova i log postao neupotrebljiv.
 *
 * RUKOVANJE GREŠKAMA:
 *   - fail-open na parse/timeout (blokiranje cijelog sustava je gora šteta od promašenog uzorka)
 *   - fail-safe na katastrofalne operacije i na tajne (exit 2)
 *   - NIKAD ne ispisuje vrijednost tajne — samo ime varijable i SHA-256 prefiks
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { paiPath } from './lib/paths';
import {
  judgeBashForSecrets,
  findLiveSecrets,
  findSecretPatterns,
  SAFE_ALTERNATIVE_HINT,
  type SecretsConfig,
} from './lib/secret-detect';
// ADR-0020 §5.2 (TASK-5397): brana brisanja — jedina logika je u regoc/tools/servisi/brana_brisanja.ts.
// TASK-5403 (Malik H1/H2): NE statički uvoz — kvar modula srušio bi cijelu kuku (i zaštitu tajni). Brana se
// učitava dinamički u radniku (lib/brana_radnik.ts) s vlastitim rokom; v. sudBrane().
const BRANA_MODUL = `${import.meta.dir}/../regoc/tools/servisi/brana_brisanja.ts`;
const BRANA_RADNIK = `${import.meta.dir}/lib/brana_radnik.ts`;
/** Vlastiti rok kuke za branu; harnessov je 15 s (settings.json), a njegov istek PROPUŠTA naredbu. */
const BRANA_ROK_MS = Number(process.env.REGOC_BRANA_ROK_MS) || 10_000;
/** Kad se brana ne može učitati: ovo blokira (fail-closed), ostalo prolazi po starom (H2). */
const BRISANJE_GRUBO = /\b(rm|rmdir|unlink|shred|find|rsync|xargs|mv|eval|rmtree|rmSync|unlinkSync|clean)\b|\b(bash|sh|zsh|dash)\s+-\w*c\b/;

type Brana = { blokirano: { cilj: string; razlog: string }[]; upozorenja: string[]; provjereno: number };

function sudBrane(command: string, cwd: string): Promise<Brana> {
  const blok = (razlog: string): Brana => ({ blokirano: [{ cilj: command.slice(0, 80), razlog }], upozorenja: [], provjereno: 0 });
  const kvar = (poruka: string): Brana => BRISANJE_GRUBO.test(command)
    ? blok(`brana se nije mogla učitati ni izvršiti (fail-closed): ${poruka}`)
    : { blokirano: [], upozorenja: [`brana nedostupna (${poruka}) — naredba ne briše, propuštena`], provjereno: 0 };
  return new Promise((resolve) => {
    let radnik: Worker | null = null;
    let gotovo = false;
    const kraj = (b: Brana) => {
      if (gotovo) return;
      gotovo = true;
      clearTimeout(sat);
      try { radnik?.terminate(); } catch { /* već ugašen */ }
      resolve(b);
    };
    const sat = setTimeout(() => kraj(blok(`brana nije stigla odlučiti u ${BRANA_ROK_MS / 1000} s (fail-closed) — ` +
      'briši manjim skupinama, kroz petlju sa smije_brisati (brana_brisanja.sh) ili premjesti u karantenu (tmp_red.sh karantena)')), BRANA_ROK_MS);
    try {
      radnik = new Worker(BRANA_RADNIK);
      radnik.onmessage = (e: MessageEvent) => kraj(e.data?.ok ? e.data.brana as Brana : kvar(String(e.data?.greska)));
      radnik.onerror = (e: ErrorEvent) => { e.preventDefault?.(); kraj(kvar(e.message || 'radnik brane pao')); };
      radnik.postMessage({ modul: BRANA_MODUL, command, cwd });
    } catch (e) {
      kraj(kvar((e as Error).message));
    }
  });
}

// ========================================
// Security Event Logging (append-only JSONL, jedan fajl po danu)
// ========================================

interface SecurityEvent {
  timestamp: string;
  session_id: string;
  event_type: 'block' | 'confirm' | 'alert' | 'warn';
  tool: string;
  category: 'bash_command' | 'path_access' | 'secret_exposure' | 'user_prompt';
  /** Naredba/putanja — skraćeno. NIKAD vrijednost tajne. */
  target: string;
  pattern_matched?: string;
  reason?: string;
  action_taken: string;
  /** Oznake pogođenih tajni ("NEXTCLOUD_PASSWORD@credentials.env"), bez vrijednosti. */
  secrets?: string[];
}

function getSecurityLogPath(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return paiPath('MEMORY', 'SECURITY', year, month, `security-${year}${month}${day}.jsonl`);
}

function logSecurityEvent(event: SecurityEvent): void {
  try {
    const logPath = getSecurityLogPath();
    const dir = logPath.substring(0, logPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, JSON.stringify(event) + '\n');
  } catch {
    // Neuspjeh logiranja ne smije blokirati operaciju.
    console.error('Warning: Failed to log security event');
  }
}

// ========================================
// Types
// ========================================

interface HookInput {
  session_id: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | string;
  prompt?: string;
}

interface Pattern {
  pattern: string;
  reason: string;
}

interface PatternsConfig {
  version: string;
  philosophy: { mode: string; principle: string };
  bash: { blocked: Pattern[]; confirm: Pattern[]; alert: Pattern[] };
  secrets: SecretsConfig;
  paths: {
    zeroAccess: string[];
    readOnly: string[];
    confirmWrite: string[];
    alertWrite: string[];
    noDelete: string[];
  };
  projects: Record<string, unknown>;
}

// ========================================
// Config Loading — kaskada USER → SYSTEM
// ========================================

const USER_PATTERNS_PATH = paiPath('USER', 'PAISECURITYSYSTEM', 'patterns.yaml');
const SYSTEM_PATTERNS_PATH = paiPath('PAISECURITYSYSTEM', 'patterns.example.yaml');

const EMPTY_SECRETS: SecretsConfig = {
  dumpCommands: [],
  storePaths: [],
  envDumpCommands: [],
  envVarEcho: '',
  promptPatterns: [],
};

function emptyConfig(principle: string): PatternsConfig {
  return {
    version: '0.0',
    philosophy: { mode: 'permissive', principle },
    bash: { blocked: [], confirm: [], alert: [] },
    secrets: EMPTY_SECRETS,
    paths: { zeroAccess: [], readOnly: [], confirmWrite: [], alertWrite: [], noDelete: [] },
    projects: {},
  };
}

let patternsCache: PatternsConfig | null = null;
let patternsSource: 'user' | 'system' | 'none' = 'none';

function getPatternsPath(): string | null {
  if (existsSync(USER_PATTERNS_PATH)) { patternsSource = 'user'; return USER_PATTERNS_PATH; }
  if (existsSync(SYSTEM_PATTERNS_PATH)) { patternsSource = 'system'; return SYSTEM_PATTERNS_PATH; }
  patternsSource = 'none';
  return null;
}

export function loadPatterns(): PatternsConfig {
  if (patternsCache) return patternsCache;

  const patternsPath = getPatternsPath();
  if (!patternsPath) return emptyConfig('No patterns loaded - fail open');

  try {
    const parsed = parseYaml(readFileSync(patternsPath, 'utf-8')) as Partial<PatternsConfig>;
    // Normalizacija: stariji patterns.example.yaml nema `secrets` ni `alertWrite`.
    patternsCache = {
      ...emptyConfig('normalized'),
      ...parsed,
      bash: { blocked: [], confirm: [], alert: [], ...(parsed.bash || {}) },
      secrets: { ...EMPTY_SECRETS, ...(parsed.secrets || {}) },
      paths: {
        zeroAccess: [], readOnly: [], confirmWrite: [], alertWrite: [], noDelete: [],
        ...(parsed.paths || {}),
      },
    } as PatternsConfig;
    return patternsCache;
  } catch (error) {
    console.error(`Failed to parse ${patternsSource} patterns.yaml:`, error);
    return emptyConfig('Parse error - fail open');
  }
}

// ========================================
// Pattern Matching
// ========================================

function matchesPattern(command: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(command);
  } catch {
    return command.toLowerCase().includes(pattern.toLowerCase());
  }
}

function expandTilde(path: string): string {
  return path.startsWith('~') ? path.replace('~', homedir()) : path;
}

export function matchesPathPattern(filePath: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  const expandedPath = expandTilde(filePath);

  if (pattern.includes('*')) {
    const regexPattern = expandedPattern
      .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
      .replace(/\*/g, '<<<SINGLESTAR>>>')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/<<<DOUBLESTAR>>>/g, '.*')
      .replace(/<<<SINGLESTAR>>>/g, '[^/]*');
    try {
      return new RegExp(`^${regexPattern}$`).test(expandedPath);
    } catch {
      return false;
    }
  }

  return expandedPath === expandedPattern ||
    expandedPath.startsWith(expandedPattern.endsWith('/') ? expandedPattern : expandedPattern + '/');
}

// ========================================
// Odluke
// ========================================

type Verdict = { action: 'allow' | 'block' | 'confirm' | 'alert'; reason?: string; matched?: string };

export function validateBashCommand(command: string): Verdict {
  const patterns = loadPatterns();

  // Tajne idu PRVE: curenje je nepovratno (transkript se ne može prepisati),
  // dok je npr. `rm -rf` barem vidljiv i lokalan.
  const secretVerdict = judgeBashForSecrets(command, patterns.secrets);
  if (secretVerdict.reason) {
    return { action: 'block', reason: secretVerdict.reason, matched: secretVerdict.matched };
  }

  for (const p of patterns.bash.blocked) {
    if (matchesPattern(command, p.pattern)) return { action: 'block', reason: p.reason, matched: p.pattern };
  }
  for (const p of patterns.bash.confirm) {
    if (matchesPattern(command, p.pattern)) return { action: 'confirm', reason: p.reason, matched: p.pattern };
  }
  for (const p of patterns.bash.alert) {
    if (matchesPattern(command, p.pattern)) return { action: 'alert', reason: p.reason, matched: p.pattern };
  }
  return { action: 'allow' };
}

type PathAction = 'read' | 'write' | 'delete';

export function validatePath(filePath: string, action: PathAction): Verdict {
  const patterns = loadPatterns();

  for (const p of patterns.paths.zeroAccess) {
    if (matchesPathPattern(filePath, p)) return { action: 'block', reason: `Zero access path: ${p}`, matched: p };
  }

  if (action === 'write' || action === 'delete') {
    for (const p of patterns.paths.readOnly) {
      if (matchesPathPattern(filePath, p)) return { action: 'block', reason: `Read-only path: ${p}`, matched: p };
    }
  }

  if (action === 'write') {
    for (const p of patterns.paths.confirmWrite) {
      if (matchesPathPattern(filePath, p)) {
        return { action: 'confirm', reason: `Writing to protected file requires confirmation: ${p}`, matched: p };
      }
    }
    for (const p of patterns.paths.alertWrite) {
      if (matchesPathPattern(filePath, p)) {
        return { action: 'alert', reason: `Audit: izmjena sigurnosno osjetljive konfiguracije (${p})`, matched: p };
      }
    }
  }

  if (action === 'delete') {
    for (const p of patterns.paths.noDelete) {
      if (matchesPathPattern(filePath, p)) return { action: 'block', reason: `Cannot delete protected path: ${p}`, matched: p };
    }
  }

  return { action: 'allow' };
}

// ========================================
// Izlazni protokol
// ========================================

function emitAllow(): void {
  console.log(JSON.stringify({ continue: true }));
}

function emitAsk(reason: string, detail: string): void {
  // hookSpecificOutput je aktualni PreToolUse protokol. Stari `{"decision":"ask"}`
  // NIJE bio valjan enum (legacy je poznavao samo approve/block) → tiho je propadao.
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `⚠️ ${reason}\n\n${detail}`,
    },
  }));
}

/** Tvrda blokada: exit 2 + stderr je jedini oblik podržan u SVIM verzijama harnessa. */
function emitBlock(reason: string, detail: string): never {
  console.error(`🚨 BLOKIRANO: ${reason}`);
  console.error(detail);
  process.exit(2);
}

// ========================================
// Rukovatelji alata
// ========================================

function toolPath(input: HookInput): string {
  return typeof input.tool_input === 'string'
    ? input.tool_input
    : ((input.tool_input?.file_path as string) || '');
}

async function handleBash(input: HookInput): Promise<void> {
  const command = typeof input.tool_input === 'string'
    ? input.tool_input
    : ((input.tool_input?.command as string) || '');

  if (!command) return emitAllow();

  let result = validateBashCommand(command);
  if (result.action !== 'block') {
    const cwd = (input as HookInput & { cwd?: string }).cwd || process.cwd();
    const brana = await sudBrane(command, cwd);
    if (brana.blokirano.length) {
      const popis = brana.blokirano.map(b => `  • ${b.cilj} — NE: ${b.razlog}`).join('\n');
      logSecurityEvent({
        timestamp: new Date().toISOString(), session_id: input.session_id, event_type: 'block', tool: 'Bash',
        category: 'path_access', target: command.slice(0, 500), pattern_matched: 'brana_brisanja',
        reason: brana.blokirano.map(b => `${b.cilj}: ${b.razlog}`).join('; ').slice(0, 500),
        action_taken: 'Hard block - exit 2 (brana brisanja)',
      });
      emitBlock('brana brisanja (ADR-0020) — cilj se ne smije obrisati', `${popis}\n\n` +
        'Ništa veliko ni trajno ne briše se izravno. Ako ovo stvarno treba maknuti, premjesti u karantenu (RAID, povratno):\n' +
        '  bash ~/.claude/regoc/tools/servisi/tmp_red.sh karantena <putanja> "<razlog>"\n' +
        'Provjera jedne putanje: bash ~/.claude/regoc/tools/servisi/brana_brisanja.sh <putanja>');
    }
    if (brana.upozorenja.length) {
      logSecurityEvent({
        timestamp: new Date().toISOString(), session_id: input.session_id, event_type: 'alert', tool: 'Bash',
        category: 'path_access', target: command.slice(0, 500), pattern_matched: 'brana_brisanja',
        reason: brana.upozorenja.join('; ').slice(0, 500), action_taken: 'Logged alert, allowed execution',
      });
    }
  }
  const isSecret = result.matched?.includes('dump') || result.reason?.includes('transkript');
  const base = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    tool: 'Bash',
    category: (isSecret ? 'secret_exposure' : 'bash_command') as SecurityEvent['category'],
    target: command.slice(0, 500),
    pattern_matched: result.matched,
    reason: result.reason,
  };

  switch (result.action) {
    case 'block':
      logSecurityEvent({ ...base, event_type: 'block', action_taken: 'Hard block - exit 2' });
      emitBlock(result.reason!, isSecret
        ? `Naredba: ${command.slice(0, 160)}\n\n${SAFE_ALTERNATIVE_HINT}`
        : `Naredba: ${command.slice(0, 160)}`);
      break;

    case 'confirm':
      logSecurityEvent({ ...base, event_type: 'confirm', action_taken: 'Prompted user for confirmation' });
      emitAsk(result.reason!, `Naredba: ${command.slice(0, 200)}`);
      break;

    case 'alert':
      logSecurityEvent({ ...base, event_type: 'alert', action_taken: 'Logged alert, allowed execution' });
      console.error(`⚠️ ALERT: ${result.reason}`);
      emitAllow();
      break;

    default:
      emitAllow();
  }
}

function handlePathTool(input: HookInput, tool: string, action: PathAction): void {
  const filePath = toolPath(input);
  if (!filePath) return emitAllow();

  const result = validatePath(filePath, action);
  const base = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id,
    tool,
    category: 'path_access' as const,
    target: filePath,
    pattern_matched: result.matched,
    reason: result.reason,
  };

  switch (result.action) {
    case 'block':
      logSecurityEvent({ ...base, event_type: 'block', action_taken: 'Hard block - exit 2' });
      emitBlock(result.reason!, `Putanja: ${filePath}\n\n${SAFE_ALTERNATIVE_HINT}`);
      break;

    case 'confirm':
      logSecurityEvent({ ...base, event_type: 'confirm', action_taken: 'Prompted user for confirmation' });
      emitAsk(result.reason!, `Putanja: ${filePath}`);
      break;

    case 'alert':
      logSecurityEvent({ ...base, event_type: 'alert', action_taken: 'Logged alert, allowed write' });
      console.error(`⚠️ AUDIT: ${result.reason}`);
      emitAllow();
      break;

    default:
      emitAllow();
  }
}

// ========================================
// UserPromptSubmit — L1 na strani korisnika
// ========================================

/**
 * Prompt je JEDINO mjesto gdje se tajna može zaustaviti PRIJE nego uđe u transkript
 * (exit 2 na UserPromptSubmit poništava prompt). Zato:
 *   - doslovna ŽIVA vrijednost iz storea → BLOKADA (preciznost 100%, nema lažnih pozitiva)
 *   - heuristički uzorak (AKIA…, ghp_…, JWT) → UPOZORENJE, prompt prolazi
 * Obrnuto bi značilo da heuristika povremeno pojede legitiman prompt — a to je put
 * u "isključi taj hook", pa onda ne štiti ništa.
 */
function handleUserPrompt(input: HookInput): void {
  const prompt = input.prompt || '';
  if (!prompt) return emitAllow();

  const live = findLiveSecrets(prompt);
  if (live.length > 0) {
    const labels = live.map(h => `${h.label} (sha256:${h.fp})`);
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      event_type: 'block',
      tool: 'UserPromptSubmit',
      category: 'user_prompt',
      target: `<prompt ${prompt.length} znakova>`,
      reason: 'Živa tajna iz credential storea u promptu',
      action_taken: 'Prompt blocked - exit 2',
      secrets: labels,
    });
    console.error('🚨 BLOKIRANO: prompt sadrži ŽIVU tajnu iz credential storea.');
    console.error(`Pogođeno: ${labels.join(', ')}`);
    console.error('Transkript piše harness i NE MOŽE se naknadno maskirati — zato je prompt zaustavljen prije slanja.');
    console.error('Pošalji ponovo bez vrijednosti (referenciraj ime varijable, npr. "NEXTCLOUD_PASSWORD iz credentials.env").');
    process.exit(2);
  }

  const heuristic = findSecretPatterns(prompt, loadPatterns().secrets.promptPatterns || []);
  if (heuristic.length > 0) {
    const names = [...new Set(heuristic.map(h => h.name))];
    logSecurityEvent({
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      event_type: 'warn',
      tool: 'UserPromptSubmit',
      category: 'user_prompt',
      target: `<prompt ${prompt.length} znakova>`,
      reason: `Heuristički oblik tajne: ${names.join(', ')}`,
      action_taken: 'Warned, prompt allowed',
      secrets: heuristic.map(h => `${h.name} (sha256:${h.fp})`),
    });
    console.error(`⚠️ UPOZORENJE: prompt izgleda kao da sadrži tajnu (${names.join(', ')}).`);
    console.error('Vrijednost je sada TRAJNO u transkriptu (~/.claude/projects/**.jsonl) — rotiraj je ako je živa.');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext:
          `[SIGURNOST] U promptu je prepoznat oblik tajne (${names.join(', ')}). ` +
          'Ta vrijednost je sada u transkriptu i ne može se maskirati. ' +
          'Upozori korisnika da je rotira i nikad je ne ponavljaj u odgovoru.',
      },
    }));
    return;
  }

  emitAllow();
}

// ========================================
// Main
// ========================================

async function main(): Promise<void> {
  let input: HookInput;

  try {
    // 1000 ms, ne 100 ms: pod opterećenjem je 100 ms znalo isteći → hook fail-open,
    // tj. sigurnosna vrata otvorena upravo kad je sustav najopterećeniji.
    // clearTimeout (Malik L3, TASK-5403): neponišten sat držao je proces živim još ~1 s nakon odluke
    let sat: ReturnType<typeof setTimeout> | undefined;
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((_, reject) => { sat = setTimeout(() => reject(new Error('timeout')), 1000); }),
    ]).finally(() => clearTimeout(sat));

    if (!text.trim()) return emitAllow();
    input = JSON.parse(text);
  } catch {
    return emitAllow(); // fail-open na parse/timeout
  }

  if (input.hook_event_name === 'UserPromptSubmit' || (!input.tool_name && input.prompt !== undefined)) {
    return handleUserPrompt(input);
  }

  switch (input.tool_name) {
    case 'Bash':
      return handleBash(input);
    case 'Edit':
    case 'MultiEdit':
      return handlePathTool(input, input.tool_name, 'write');
    case 'Write':
      return handlePathTool(input, 'Write', 'write');
    case 'Read':
      return handlePathTool(input, 'Read', 'read');
    default:
      return emitAllow();
  }
}

// Pokreni samo kad se izvršava kao hook; kod importa (testovi) izvezi funkcije.
if (import.meta.main) {
  main().catch(() => emitAllow());
}
