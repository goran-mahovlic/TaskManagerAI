/**
 * J9 (GAP_20260924 F13) na pravom poslužitelju: prazna instalacija, nijedna adresa RAG-a.
 *
 *   • GET /api/rag/backend/status → 200, pgvector {configured:false}, bez mrežnog poziva
 *   • lozinka iz okoline NIKAD ne izlazi kroz status ni config (samo passwordSet)
 *   • PUT config pa GET config — zapis u $TM_HOME/config, bez lozinke
 *   • PUT config s ključem `password` se odbija
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { podigni, spusti, type Posluzitelj } from './helpers/posluzitelj'

const LOZINKA = 'tajna-koja-ne-smije-izaci-9f3a'

describe('RAG backend API — prazna instalacija', () => {
  let p: Posluzitelj | null = null
  beforeAll(async () => {
    p = await podigni({}, { TM_PGVECTOR_PASSWORD: LOZINKA, TM_CHROMA_HOST: '', TM_RAG_BACKEND: '' })
  }, 30_000)
  afterAll(() => spusti(p))

  test('status s praznom konfiguracijom → 200 i pgvector nije podešen', async () => {
    const r = await fetch(`${p!.url}/api/rag/backend/status`)
    expect(r.status).toBe(200)
    const tekst = await r.text()
    expect(tekst).not.toContain(LOZINKA)
    const d = JSON.parse(tekst)
    expect(d.pgvector.configured).toBe(false)
    expect(d.pgvector.passwordSet).toBe(true)
    expect(d).toHaveProperty('chromadb')
  })

  test('config nikad ne vraća lozinku', async () => {
    const r = await fetch(`${p!.url}/api/rag/backend/config`)
    expect(r.status).toBe(200)
    const tekst = await r.text()
    expect(tekst).not.toContain(LOZINKA)
    expect(JSON.parse(tekst).pgvector.passwordSet).toBe(true)
  })

  test('PUT config upisuje adresu u $TM_HOME/config bez lozinke', async () => {
    const r = await fetch(`${p!.url}/api/rag/backend/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'pg.primjer.invalid', port: 5432, database: 'rag', user: 'rag' }),
    })
    expect(r.status).toBe(200)
    const d = await (await fetch(`${p!.url}/api/rag/backend/config`)).json() as any
    expect(d.pgvector.configured).toBe(true)
    expect(d.pgvector.host).toBe('pg.primjer.invalid')
    const datoteka = join(p!.dom, 'config', 'rag-backend.json')
    expect(existsSync(datoteka)).toBe(true)
    expect(readFileSync(datoteka, 'utf-8')).not.toContain(LOZINKA)
  })

  test('PUT config s ključem password se odbija', async () => {
    const r = await fetch(`${p!.url}/api/rag/backend/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: 'pg.primjer.invalid', port: 5432, database: 'rag', user: 'rag', password: 'x' }),
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })
}, { timeout: 60_000 })
