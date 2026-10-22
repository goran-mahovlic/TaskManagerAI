/**
 * secret-detect.ts — JEDINI IZVOR ISTINE za prepoznavanje tajni u REGOČ hookovima.
 *
 * NASTALO IZ: TASK-3043 (Malik, 29.07.2026.), na nalaz TASK-3041.
 *
 * ZAŠTO POSTOJI
 *   Transkript sesije piše sam harness; nijedan hook ne može prepisati već zapisan
 *   redak. Dakle "maskiranje pri zapisu" arhitektonski NE POSTOJI. Jedina obrana koja
 *   stvarno djeluje je da tajna nikad ne uđe u `tool_result` — a to znači presresti
 *   NAREDBU prije izvršenja. Ovaj modul je detektor koji to omogućuje.
 *
 * DVA NAČINA DETEKCIJE
 *   1) needle-based (VISOKA preciznost, 0 lažnih pozitiva) — točne ŽIVE vrijednosti
 *      učitane iz credential storeova. Isti princip kao regoc/tools/secret_exposure_scan.py.
 *   2) pattern-based (heuristika) — generički oblici (AKIA…, ghp_…, JWT, PEM blok).
 *      Koristi se SAMO za upozorenje, nikad za tvrdu blokadu.
 *
 * ŽELJEZNO PRAVILO
 *   Ovaj modul NIKAD ne vraća ni ne ispisuje vrijednost tajne — samo ime varijable,
 *   izvor i SHA-256 prefiks. Inače bi sam detektor postao kanal curenja
 *   (detektor se poziva iz hooka čiji stdout/stderr ide u transkript).
 */

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const HOME = process.env.HOME || homedir();

/** Storeovi iz kojih se čitaju ŽIVE vrijednosti. Ista lista kao secret_exposure_scan.py. */
export const CREDENTIAL_STORES = [
  join(HOME, '.claude', 'regoc', 'credentials.env'),
  join(HOME, 'app', 'espacenet-mcp', '.env'),
  join(HOME, '.env'),
  join(HOME, '.claude', '.env'),
];

/** Imena varijabli koja smatramo osjetljivima (isti regex kao scan alat). */
const SENSITIVE_NAME = /(PASSWORD|PASSWD|SECRET|KEY|TOKEN|PASS)$/;

/** Kraće od ovoga je previše generično da bi se tražilo kao needle (lažni pozitivi). */
const MIN_NEEDLE_LEN = 8;

/**
 * Poznate slabe lozinke koje se ne nalaze ni u jednom .env-u. NIKAD doslovno u kodu (kod ide u javni
 * komplet, TASK-5706 N1): čitaju se iz lokalne datoteke izvan svakog repozitorija, jedna po retku
 * (`~/.claude/regoc/data/slabe_lozinke.local`, prava 600). Nema datoteke = nema dodatnih needlea.
 */
const WEAK_NEEDLES_FILE = join(HOME, '.claude', 'regoc', 'data', 'slabe_lozinke.local');
function extraWeakNeedles(): string[] {
  try {
    if (!existsSync(WEAK_NEEDLES_FILE)) return [];
    return readFileSync(WEAK_NEEDLES_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export interface Needle {
  /** Vrijednost — NIKAD se ne smije logirati ni ispisati. */
  readonly value: string;
  /** npr. "NEXTCLOUD_PASSWORD@credentials.env" */
  readonly label: string;
  /** SHA-256 prefiks (12 hex) — sigurna referenca u logu/poruci. */
  readonly fp: string;
}

export interface NeedleHit {
  label: string;
  fp: string;
}

export interface PatternHit {
  name: string;
  /** SHA-256 prefiks POGOTKA, ne sam pogodak. */
  fp: string;
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 12);
}

let needlesCache: Needle[] | null = null;

/**
 * Učitaj žive vrijednosti iz credential storeova.
 * Fail-open: nedostupan/neispravan store → prazna lista (guard se degradira na
 * pattern-detekciju, ne ruši tool poziv).
 */
export function loadNeedles(): Needle[] {
  if (needlesCache) return needlesCache;

  const byValue = new Map<string, Set<string>>();

  for (const store of CREDENTIAL_STORES) {
    if (!existsSync(store)) continue;
    let content: string;
    try {
      content = readFileSync(store, 'utf-8');
    } catch {
      continue;
    }
    for (const raw of content.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_0-9]+)\s*=\s*(.*)$/.exec(raw.trim());
      if (!m) continue;
      const name = m[1];
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (!SENSITIVE_NAME.test(name)) continue;
      if (value.length < MIN_NEEDLE_LEN) continue;
      // Placeholderi iz predložaka nisu tajne.
      if (/^(your_|<|\$|changeme|placeholder)/i.test(value)) continue;
      const label = `${name}@${store.split('/').pop()}`;
      if (!byValue.has(value)) byValue.set(value, new Set());
      byValue.get(value)!.add(label);
    }
  }

  for (const weak of extraWeakNeedles()) {
    if (!byValue.has(weak)) byValue.set(weak, new Set(['WEAK_VM_PASSWORD@manual']));
  }

  needlesCache = [...byValue.entries()].map(([value, labels]) => ({
    value,
    label: [...labels].sort().join('/'),
    fp: fingerprint(value),
  }));
  return needlesCache;
}

/** Koje ŽIVE tajne se doslovno pojavljuju u tekstu. Vraća samo oznake i otiske. */
export function findLiveSecrets(text: string): NeedleHit[] {
  if (!text) return [];
  const hits: NeedleHit[] = [];
  for (const n of loadNeedles()) {
    if (text.includes(n.value)) hits.push({ label: n.label, fp: n.fp });
  }
  return hits;
}

export interface PromptPatternDef {
  name: string;
  pattern: string;
}

/** Heuristička detekcija generičkih oblika tajni. Samo za UPOZORENJE. */
export function findSecretPatterns(text: string, defs: PromptPatternDef[]): PatternHit[] {
  if (!text) return [];
  const hits: PatternHit[] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    let re: RegExp;
    try {
      re = new RegExp(def.pattern, 'g');
    } catch {
      continue; // neispravan regex u konfiguraciji ne smije srušiti guard
    }
    for (const m of text.matchAll(re)) {
      const key = `${def.name}:${fingerprint(m[0])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name: def.name, fp: fingerprint(m[0]) });
    }
  }
  return hits;
}

export interface SecretsConfig {
  dumpCommands: string[];
  storePaths: string[];
  envDumpCommands: string[];
  envVarEcho: string;
  promptPatterns: PromptPatternDef[];
}

export interface BashSecretVerdict {
  /** null = naredba je čista */
  reason: string | null;
  /** koji je uzorak okinuo (za audit log) */
  matched?: string;
}

/**
 * Omotači koji stoje ISPRED prave naredbe. Bez njih bi `sudo cat .env` ili
 * `timeout 60 cat .env` prošli kroz sidro na poziciju naredbe.
 */
const COMMAND_WRAPPERS =
  '(?:(?:sudo|command|nohup|setsid|time|nice|stdbuf|xargs|timeout|env)(?:\\s+-{1,2}[A-Za-z-]+)*(?:\\s+\\d+[smhd]?)?\\s+)*';

/**
 * Glagol mora biti na POZICIJI NAREDBE (početak, ili iza ; | & && || ( novi red),
 * eventualno iza omotača poput `sudo`.
 *
 * ZAŠTO NIJE DOVOLJNA GRANICA RIJEČI (dokazano 29.07.2026.)
 *   Uzorak `(^|\s)verb(\s|$)` okida na PROZI. Hrvatska riječ "od" je ujedno naredba `od`
 *   (octal dump), pa je rečenica "…5 od 46 fajlova u credentials.env…" bila blokirana kao
 *   pokušaj dumpanja storea — u praksi je blokirala izvještaj o zatvaranju TASK-3043.
 *   Isto vrijedi za `nl`, `ag`, `tac`, `cut`, `sort`, `tee`. Pravo curenje je UVIJEK na
 *   poziciji naredbe, pa sidro ne gubi nijedan stvarni slučaj.
 */
function dumpVerbPattern(verb: string): string {
  return `(?:^|[|;&(\\n]|&&|\\|\\|)\\s*${COMMAND_WRAPPERS}${verb}(?:\\s|$)`;
}

function anyMatch(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return p;
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) return p;
    }
  }
  return null;
}

/**
 * Presudi hoće li bash naredba ISPISATI tajnu u tool_result.
 *
 * Okida na:
 *   (a) glagol koji dumpa sadržaj + putanja credential storea u ISTOJ naredbi,
 *   (b) dump cijelog environmenta (`env`, `printenv`, `export -p`, `set`),
 *   (c) `echo $NESTO_PASSWORD`.
 *
 * NE okida na `ls -la .env`, `stat`, `test -f`, `chmod` — metapodaci nisu tajna,
 * a guard koji zabranjuje i njih se u praksi isključi (i time ne štiti ništa).
 */
export function judgeBashForSecrets(command: string, cfg: SecretsConfig): BashSecretVerdict {
  if (!command) return { reason: null };

  const envDump = anyMatch(command, cfg.envDumpCommands || []);
  if (envDump) {
    return {
      reason: 'Naredba ispisuje CIJELI environment — sve tajne procesa završile bi u transkriptu (trajno, nemaskirano).',
      matched: envDump,
    };
  }

  if (cfg.envVarEcho) {
    try {
      if (new RegExp(cfg.envVarEcho, 'i').test(command)) {
        return {
          reason: 'Naredba ekspandira osjetljivu env varijablu u stdout — vrijednost bi ušla u transkript.',
          matched: cfg.envVarEcho,
        };
      }
    } catch { /* neispravan regex → preskoči */ }
  }

  const storeHit = anyMatch(command, cfg.storePaths || []);
  if (!storeHit) return { reason: null };

  const dumpHit = anyMatch(command, (cfg.dumpCommands || []).map(dumpVerbPattern));
  if (!dumpHit) return { reason: null };

  return {
    reason: 'Naredba ispisuje sadržaj credential storea — vrijednost bi trajno ostala u transkriptu (harness ga piše, hook ga ne može maskirati).',
    matched: `${storeHit} + dump`,
  };
}

/** Poruka koja agenta usmjeri na siguran put umjesto da samo kaže "ne". */
export const SAFE_ALTERNATIVE_HINT =
  'Sigurna zamjena: `python3 ~/.claude/regoc/tools/secret_probe.py --name IME_VARIJABLE` ' +
  '(potvrdi postojanje + SHA-256 prefiks, bez ispisa vrijednosti; okolina procesa: `--pid <pid> --prefix IME_`), ili proslijedi tajnu ' +
  'procesu preko env varijable bez ispisa (npr. `set -a; . store; set +a; alat`).';
