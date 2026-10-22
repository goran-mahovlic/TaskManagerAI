/**
 * voice-client.ts — Jedini način na koji pozivatelji (RegocDaemon, AgentWorker, hookovi)
 * traže glasovnu notifikaciju.
 *
 * Radi rani gate lokalno (bez mrežnog poziva ako agent nema glas), pa šalje
 * `agent` i `event` VoiceServeru koji je konačni autoritet. Filtar postoji na oba
 * mjesta namjerno: ovdje da se ne troši poziv, tamo da ga nitko ne može zaobići.
 */

import { evaluateVoice, loadAgents, loadPolicy, type AgentVoiceMap, type VoicePolicy } from './voice-policy';

const VOICE_SERVER = process.env.VOICE_SERVER_URL || 'http://localhost:8888/notify';
const CONFIG_TTL_MS = 60_000;

let cachedPolicy: VoicePolicy | null = null;
let cachedAgents: AgentVoiceMap | null = null;
let cachedAt = 0;

function config(): { policy: VoicePolicy; agents: AgentVoiceMap } {
  const now = Date.now();
  if (!cachedPolicy || !cachedAgents || now - cachedAt > CONFIG_TTL_MS) {
    cachedPolicy = loadPolicy();
    cachedAgents = loadAgents();
    cachedAt = now;
  }
  return { policy: cachedPolicy, agents: cachedAgents };
}

export interface VoiceRequest {
  /** ID agenta iz REGOC_AGENTS.json (npr. 'kosjenka'). */
  agent?: string | null;
  /** Tip događaja iz voice-policy.json events (npr. 'agent_task_completed'). */
  event?: string;
  message: string;
  title?: string;
}

/**
 * Pošalje glasovnu notifikaciju ako je agent na allowlisti i događaj propušten.
 * Nikad ne baca — glas je nuspojava, ne smije srušiti pozivatelja.
 *
 * @returns true ako je zahtjev poslan serveru, false ako je odbijen lokalno.
 */
export async function requestVoice(req: VoiceRequest): Promise<boolean> {
  try {
    const { policy, agents } = config();
    const decision = evaluateVoice({
      agentId: req.agent ?? null,
      event: req.event ?? 'default',
      message: req.message,
      policy,
      agents,
    });

    // Debounce se provjerava na serveru (on drži stanje); ovdje odbijamo
    // samo ono što je trajno nijemo — allowlist, event, tihi sati.
    if (!decision.allowed && decision.reason !== 'debounced') return false;

    await fetch(VOICE_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: req.title,
        message: req.message,
        agent: decision.agentId,
        event: req.event ?? 'default',
        voice_enabled: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}
