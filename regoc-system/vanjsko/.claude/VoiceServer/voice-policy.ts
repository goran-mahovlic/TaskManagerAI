/**
 * voice-policy.ts — SSOT za odluku "smije li se ovo izgovoriti i kojim glasom".
 *
 * Jedini izvor istine za:
 *   - koji agenti UOPĆE imaju glas (allowlist iz REGOC_AGENTS.json → agents.<id>.voice.enabled)
 *   - koji događaji se izgovaraju (voice-policy.json → events)
 *   - tihi sati i debounce (da glas NE ide uvijek)
 *   - koji je LOKALNI glas (Piper model) za pojedinog agenta
 *
 * Koriste ga i VoiceServer (server.ts) i pozivatelji (RegocDaemon, AgentWorker),
 * da logika filtriranja postoji SAMO na jednom mjestu.
 *
 * Nema mrežnih poziva. evaluateVoice() je čista funkcija (testabilna).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';

// ============================================================
// Tipovi
// ============================================================

export interface EventPolicy {
  enabled: boolean;
  /** Override globalnog debouncea za taj tip događaja (sekunde). */
  min_interval_seconds?: number;
  /** Smije li se izgovoriti i u tihim satima (npr. eskalacija). */
  bypass_quiet_hours?: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" */
  from: string;
  /** "HH:MM" */
  to: string;
}

export interface PiperSettings {
  /** Legacy Piper CLI (koristi se samo ako synth_script nije postavljen). */
  bin: string;
  voices_dir: string;
  default_model: string;
  /** Ljudski opis zadanog modela (za /health), npr. "K2 ep5306". */
  default_model_label?: string;
  /** Python iz venva s piper-tts (Python API — nužan za fonemsku pripremu). */
  python?: string;
  /** regoc_piper_synth.py: normalizacija + fonemi + sinteza po rečenicama (recept 04.10.2026.). */
  synth_script?: string;
}

export interface VoicePolicy {
  enabled: boolean;
  backend: 'piper' | 'espeak' | 'none';
  /** Cloud TTS (ElevenLabs) je OPT-IN. Default false = ništa ne izlazi iz mreže. */
  allow_cloud_tts: boolean;
  default_agent: string;
  piper: PiperSettings;
  events: Record<string, EventPolicy>;
  min_interval_seconds: number;
  quiet_hours: QuietHours;
}

export interface AgentVoice {
  /** Ima li agent glas UOPĆE. Default-deny: sve osim eksplicitnog true je nijemo. */
  enabled: boolean;
  /** Naziv Piper modela (bez .onnx) u voices_dir, ili apsolutna putanja. */
  local_model?: string;
  length_scale?: number;
  noise_scale?: number;
  noise_w?: number;
  volume?: number;
  /** Deterministička normalizacija teksta (brojevi, nadnevci, kratice). Zadano: uključeno. */
  normalize?: boolean;
  /** Fonemska priprema (hr_accent + lexicon_hr.json). Zadano: uključeno. */
  phonemes?: boolean;
  /** Digitalna tišina između rečenica / iza odlomka (sekunde). */
  sentence_silence?: number;
  paragraph_silence?: number;
  /** Legacy ElevenLabs postavke — koriste se SAMO ako je allow_cloud_tts=true. */
  cloud?: { voice_id?: string; voice_name?: string; stability?: number; similarity_boost?: number };
}

export interface AgentEntry {
  id: string;
  name: string;
  voice?: AgentVoice & Record<string, unknown>;
}

export type AgentVoiceMap = Record<string, AgentEntry>;

export interface VoiceDecision {
  allowed: boolean;
  /** Strojno čitljiv razlog (za logove i testove). */
  reason:
    | 'ok'
    | 'voice_disabled'
    | 'unknown_agent'
    | 'agent_muted'
    | 'event_muted'
    | 'quiet_hours'
    | 'debounced'
    | 'empty_message';
  agentId: string | null;
  /** Efektivni debounce koji vrijedi za ovaj događaj (sekunde). */
  intervalSeconds: number;
}

export interface EvaluateInput {
  agentId?: string | null;
  event?: string | null;
  message?: string;
  policy: VoicePolicy;
  agents: AgentVoiceMap;
  /** Epoch ms. Default: sada. */
  now?: number;
  /** Epoch ms zadnje izgovorene poruke TOG agenta, ili null. */
  lastSpokenAt?: number | null;
}

// ============================================================
// Defaulti — vrijede ako voice-policy.json nedostaje ili je nepotpun.
// Namjerno suženi: cloud OFF, nepoznati događaji nijemi.
// ============================================================

export const DEFAULT_POLICY: VoicePolicy = {
  enabled: true,
  backend: 'piper',
  allow_cloud_tts: false,
  default_agent: 'regoc',
  piper: {
    bin: '~/.local/bin/piper',
    voices_dir: '~/.local/share/piper-voices',
    default_model: 'hr_regoc',
    python: '~/.local/share/regoc-piper/venv/bin/python',
    synth_script: '~/.claude/VoiceServer/piper/regoc_piper_synth.py',
  },
  events: {
    // Direktan odgovor korisniku: on je za tipkovnicom, pa tihi sati ovdje ne vrijede.
    assistant_response: { enabled: true, min_interval_seconds: 0, bypass_quiet_hours: true },
    agent_task_completed: { enabled: true, min_interval_seconds: 180 },
    agent_task_failed: { enabled: true, min_interval_seconds: 120, bypass_quiet_hours: true },
    escalation: { enabled: true, min_interval_seconds: 0, bypass_quiet_hours: true },
    system: { enabled: false },
    default: { enabled: false },
  },
  min_interval_seconds: 120,
  quiet_hours: { enabled: true, from: '22:00', to: '07:00' },
};

export const POLICY_PATH = join(homedir(), '.claude', 'VoiceServer', 'voice-policy.json');
export const AGENTS_PATH = join(homedir(), '.claude', 'regoc', 'REGOC_AGENTS.json');

// ============================================================
// Pomoćne funkcije
// ============================================================

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Skida hrvatske dijakritike i sređuje case, za usporedbu imena agenata. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/č|ć/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Izvuče ime agenta iz poruke tipa "Grga je završio zadatak".
 * Nužno jer stariji pozivatelji ne šalju `agent` polje — bez ovoga bi
 * prošli kroz default_agent i dobili glas koji im ne pripada.
 */
export function sniffAgentFromMessage(message: string | undefined, agents: AgentVoiceMap): string | null {
  if (!message) return null;
  const m = message.match(/^\s*\*{0,2}([\p{L}]+)\*{0,2}\s+je\s+(zavr[šs]i|dovr[šs]i|javi)/iu);
  if (!m) return null;
  const wanted = normalizeName(m[1]);
  for (const [id, entry] of Object.entries(agents)) {
    if (normalizeName(id) === wanted || normalizeName(entry.name || '') === wanted) return id;
  }
  return null;
}

/** "HH:MM" → minute od ponoći; -1 ako je format neispravan. */
function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '');
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return -1;
  return h * 60 + min;
}

/** Radi i preko ponoći (22:00 → 07:00). */
export function isQuietNow(quiet: QuietHours, now: number): boolean {
  if (!quiet?.enabled) return false;
  const from = parseHHMM(quiet.from);
  const to = parseHHMM(quiet.to);
  if (from < 0 || to < 0 || from === to) return false;

  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();

  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

function resolveEventPolicy(policy: VoicePolicy, event: string | null | undefined): EventPolicy {
  const events = policy.events || {};
  const key = event && events[event] ? event : 'default';
  return events[key] ?? { enabled: false };
}

// ============================================================
// Glavna odluka — čista funkcija
// ============================================================

/**
 * Tko je govornik: eksplicitni `agent` > ime iz poruke > default agent.
 * Izdvojeno da pozivatelj može dohvatiti debounce-stanje PRIJE evaluacije.
 */
export function resolveAgentId(
  agentId: string | null | undefined,
  message: string | undefined,
  policy: VoicePolicy,
  agents: AgentVoiceMap
): string | null {
  return (
    (agentId && agentId.trim()) ||
    sniffAgentFromMessage(message, agents) ||
    policy.default_agent ||
    null
  );
}

export function evaluateVoice(input: EvaluateInput): VoiceDecision {
  const { policy, agents } = input;
  const now = input.now ?? Date.now();

  const deny = (reason: VoiceDecision['reason'], agentId: string | null, intervalSeconds = 0): VoiceDecision => ({
    allowed: false,
    reason,
    agentId,
    intervalSeconds,
  });

  if (!policy?.enabled) return deny('voice_disabled', null);

  const message = (input.message ?? '').trim();
  if (!message) return deny('empty_message', null);

  const agentId = resolveAgentId(input.agentId, message, policy, agents);
  if (!agentId) return deny('unknown_agent', null);

  const agent = agents[agentId] ?? agents[normalizeName(agentId)];
  if (!agent) return deny('unknown_agent', agentId);

  // Default-deny: glas ima samo agent kojemu je eksplicitno uključen.
  if (agent.voice?.enabled !== true) return deny('agent_muted', agentId);

  const eventPolicy = resolveEventPolicy(policy, input.event);
  if (!eventPolicy.enabled) return deny('event_muted', agentId);

  const intervalSeconds =
    typeof eventPolicy.min_interval_seconds === 'number'
      ? eventPolicy.min_interval_seconds
      : policy.min_interval_seconds ?? 0;

  if (!eventPolicy.bypass_quiet_hours && isQuietNow(policy.quiet_hours, now)) {
    return deny('quiet_hours', agentId, intervalSeconds);
  }

  if (
    intervalSeconds > 0 &&
    typeof input.lastSpokenAt === 'number' &&
    now - input.lastSpokenAt < intervalSeconds * 1000
  ) {
    return deny('debounced', agentId, intervalSeconds);
  }

  return { allowed: true, reason: 'ok', agentId, intervalSeconds };
}

// ============================================================
// Učitavanje konfiguracije s diska
// ============================================================

function mergePolicy(raw: any): VoicePolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY };
  return {
    ...DEFAULT_POLICY,
    ...raw,
    piper: { ...DEFAULT_POLICY.piper, ...(raw.piper ?? {}) },
    quiet_hours: { ...DEFAULT_POLICY.quiet_hours, ...(raw.quiet_hours ?? {}) },
    events: { ...DEFAULT_POLICY.events, ...(raw.events ?? {}) },
  };
}

export function loadPolicy(path: string = POLICY_PATH): VoicePolicy {
  try {
    if (!existsSync(path)) return { ...DEFAULT_POLICY };
    const policy = mergePolicy(JSON.parse(readFileSync(path, 'utf-8')));
    // Env override je jedini način da cloud TTS proradi bez ručne izmjene configa.
    if (process.env.VOICE_ALLOW_CLOUD === '1') policy.allow_cloud_tts = true;
    if (process.env.VOICE_DISABLE === '1') policy.enabled = false;
    return policy;
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function loadAgents(path: string = AGENTS_PATH): AgentVoiceMap {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const out: AgentVoiceMap = {};
    for (const [id, entry] of Object.entries<any>(raw?.agents ?? {})) {
      out[id] = { id, name: entry?.name ?? id, voice: entry?.voice };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Putanja do Piper .onnx modela za agenta (ili null ako ga nema na disku).
 */
export function resolveLocalModel(
  agentId: string | null,
  policy: VoicePolicy,
  agents: AgentVoiceMap
): { model: string; config: string } | null {
  const agent = agentId ? agents[agentId] : null;
  const name = agent?.voice?.local_model || policy.piper.default_model;
  if (!name) return null;

  const model = isAbsolute(name)
    ? name
    : join(expandHome(policy.piper.voices_dir), name.endsWith('.onnx') ? name : `${name}.onnx`);

  if (!existsSync(model)) return null;
  return { model, config: `${model}.json` };
}

/** Inference parametri za agenta (Piper), s razumnim defaultima. */
export function resolveVoiceParams(agentId: string | null, agents: AgentVoiceMap): {
  length_scale?: number;
  noise_scale?: number;
  noise_w?: number;
  volume?: number;
  normalize?: boolean;
  phonemes?: boolean;
  sentence_silence?: number;
  paragraph_silence?: number;
} {
  const v: Partial<AgentVoice> = (agentId ? agents[agentId]?.voice : undefined) ?? {};
  return {
    length_scale: v.length_scale,
    noise_scale: v.noise_scale,
    noise_w: v.noise_w,
    volume: v.volume,
    normalize: v.normalize,
    phonemes: v.phonemes,
    sentence_silence: v.sentence_silence,
    paragraph_silence: v.paragraph_silence,
  };
}
