/**
 * Adapters — izvedbe portova koje paket isporučuje.
 *
 * Jezgra ne zna ni za HTTP ni za Telegram; ovdje su izvedbe koje ih vežu uz ovaj paket, pa
 * `scripts/orchestrator.ts` radi bez ijednog retka koda kod korisnika.
 *
 * `HttpBoard` namjerno ide kroz REST API, a ne u SQLite izravno (ADR-0001 L5): baš zato da
 * vratari ploče (`CompletionGuard`, `TaskCreateBreaker`, `DispatchGuard`…) vrijede i za
 * posao koji otvara stroj. Orkestrator koji zaobiđe vlastita vrata prvi ih i probije.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { appendFileSync } from 'fs'
import { osigurajMapu, stanjePutanja } from '../paths'
import { obavijestiZadatak, posaljiTelegramPoruku } from '../../TelegramConfig'
import type {
  Board, CreateTaskInput, Logger, Message, MessageBus, Notifier, Origin, Task, TaskPatch,
} from './Ports'

// ─── Ploča preko REST API-ja ─────────────────────────────────────────────────

export class HttpBoard implements Board {
  private base: string
  private rokMs: number

  constructor(baseUrl: string, rokMs = 15000) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.rokMs = rokMs
  }

  private async zovi(put: string, init?: RequestInit): Promise<any> {
    const kontrola = new AbortController()
    const prekid = setTimeout(() => kontrola.abort(), this.rokMs)
    try {
      const resp = await fetch(this.base + put, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
        signal: kontrola.signal,
      })
      const tekst = await resp.text()
      let tijelo: any = null
      try { tijelo = tekst ? JSON.parse(tekst) : null } catch { tijelo = { raw: tekst } }
      return { ok: resp.ok, status: resp.status, tijelo }
    } finally {
      clearTimeout(prekid)
    }
  }

  private uTask(t: any): Task {
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      assignee: t.assignee ?? null,
      projectId: t.projectId ?? t.project_id ?? null,
      priority: t.priority,
      tags: t.tags,
      createdAt: t.createdAt ?? t.created_at,
      startedAt: t.startedAt ?? t.started_at ?? null,
    }
  }

  async get(id: string): Promise<Task | null> {
    const r = await this.zovi(`/api/tasks/${encodeURIComponent(id)}`)
    return r.ok && r.tijelo ? this.uTask(r.tijelo) : null
  }

  async list(status: string): Promise<Task[]> {
    const r = await this.zovi(`/api/tasks?status=${encodeURIComponent(status)}`)
    if (!r.ok) return []
    const popis = Array.isArray(r.tijelo) ? r.tijelo : (r.tijelo?.tasks || [])
    return popis.map((t: any) => this.uTask(t))
  }

  async update(id: string, patch: TaskPatch): Promise<boolean> {
    const r = await this.zovi(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify(patch),
    })
    return !!r.ok
  }

  async create(input: CreateTaskInput): Promise<{ id: string } | null> {
    const r = await this.zovi('/api/tasks', { method: 'POST', body: JSON.stringify(input) })
    const id = r.tijelo?.id || r.tijelo?.task?.id
    return r.ok && id ? { id } : null
  }

  /**
   * `in_progress → pending` NIJE dopušten prijelaz kroz PUT (ploča ga odbija s 409), pa ide
   * kroz namjensku rutu. Ako je ploča starija i te rute nema, vraća se `false` — a to je
   * točan podatak, za razliku od PUT-a koji bi „uspio" bez učinka.
   */
  async reclaim(id: string, reason: string, by: string): Promise<boolean> {
    const r = await this.zovi(`/api/tasks/${encodeURIComponent(id)}/reclaim`, {
      method: 'POST', body: JSON.stringify({ reason, by }),
    })
    return !!r.ok
  }
}

// ─── Red poruka ──────────────────────────────────────────────────────────────

/**
 * Paket nema vlastiti međuagentski red poruka — njegov ulaz je `POST /api/ingest`, koji
 * zadatak otvara odmah. Ova izvedba to i kaže umjesto da glumi prazan red koji nikad ništa
 * ne isporuči. Instalacija koja ima svoj red (npr. `messages.db`) podmeće vlastitu izvedbu.
 */
export class PraznaMagistrala implements MessageBus {
  async pending(): Promise<Message[]> { return [] }
  async claim(): Promise<boolean> { return false }
  async complete(): Promise<void> { /* nema što */ }
  async send(): Promise<string> { return '' }
}

// ─── Dojava ──────────────────────────────────────────────────────────────────

/** Dojava kroz Telegram integraciju paketa. Bez postavljenog bota tiho ne šalje ništa. */
export class TelegramNotifier implements Notifier {
  async notify(text: string, _origin?: Origin): Promise<boolean> {
    const r = await posaljiTelegramPoruku(text)
    return r.ok
  }

  async notifyZadatak(taskId: string, naslov: string, status: string): Promise<boolean> {
    const r = await obavijestiZadatak(taskId, naslov, status)
    return r.ok
  }
}

/** Dojava koja ne šalje ništa — zadano za instalaciju bez ijednog kanala. */
export class TihiNotifier implements Notifier {
  async notify(): Promise<boolean> { return false }
}

// ─── Dnevnik ─────────────────────────────────────────────────────────────────

/**
 * Dnevnik s vremenskom oznakom, jedan redak po događaju, dopisivanje (`appendFileSync`).
 * Zapis bez datuma ne može se poredati ni usporediti s ničim — a upravo se u forenzici
 * kvara traži redoslijed.
 */
export class DatotecniLogger implements Logger {
  private put: string
  private naEkran: boolean

  constructor(put?: string, naEkran = true) {
    this.put = put || process.env.TM_ORCHESTRATOR_LOG || stanjePutanja('orchestrator.log')
    this.naEkran = naEkran
    osigurajMapu(this.put)
  }

  log(redak: string): void {
    const zapis = `[${new Date().toISOString()}] ${redak}\n`
    if (this.naEkran) console.log(redak)
    try { appendFileSync(this.put, zapis, 'utf-8') } catch { /* dnevnik ne smije oboriti rad */ }
  }
}

export const SistemskiSat = { now: () => Date.now() }
