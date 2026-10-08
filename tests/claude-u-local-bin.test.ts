// TASK-5364 (izmjereno na node-A): daemon i ploča pod systemd-om imaju PATH bez ~/.local/bin, a
// `claude` i `glas` žive upravo ondje. Ploča je zato na kartici Standby javljala
// „no Claude CLI on this machine" iako je Claude prijavljen.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { davateljiDezurnog } from '../src/DezurniConfig'
import { nadjiClaude } from '../src/razgovor/Izvrsitelj'

let home: string
let mc: string
// Kao na node-A, ali bez stvarnih sistemskih mapa — stroj na kojem test radi smije imati claude u /usr/local/bin.
const PATH_SYSTEMD = '/nema-ovdje/.bun/bin:/nema-ovdje/usr/bin'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-local-bin-'))
  mc = join(home, 'model-config.json')
  writeFileSync(mc, JSON.stringify({ providers: { anthropic: { enabled: true } } }))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function claudeULocalBin(): string {
  const mapa = join(home, '.local', 'bin')
  mkdirSync(mapa, { recursive: true })
  const f = join(mapa, 'claude')
  writeFileSync(f, '#!/bin/sh\n')
  chmodSync(f, 0o755)
  return f
}

describe('claude izvan PATH-a usluge (TASK-5364)', () => {
  test('nadjiClaude nalazi ~/.local/bin/claude kad ga PATH nema', () => {
    const f = claudeULocalBin()
    expect(nadjiClaude({ HOME: home, PATH: PATH_SYSTEMD })).toBe(f)
  })

  test('Standby: anthropic je spreman kad je claude samo u ~/.local/bin', () => {
    claudeULocalBin()
    const a = davateljiDezurnog(mc, join(home, 'nema.env'), { HOME: home, PATH: PATH_SYSTEMD }).anthropic
    expect(a.spreman).toBe(true)
    expect(a.zastoKey).toBe('dez_zasto_anthropic_ok')
  })

  test('Standby: bez claudea nigdje → pošteno „nema"', () => {
    const a = davateljiDezurnog(mc, join(home, 'nema.env'), { HOME: home, PATH: '/nema-ovdje' }).anthropic
    expect(a.spreman).toBe(false)
    expect(a.zastoKey).toBe('dez_zasto_anthropic_nema')
  })
})
