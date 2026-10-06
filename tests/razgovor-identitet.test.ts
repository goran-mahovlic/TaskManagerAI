// Identitet upravitelja (TASK-5293): bot zna agente iz registra, na razini `puno` zna kako
// se posao delegira kroz ploču, a vodič vlasnika (TM_RAZGOVOR_UPUTE) ide u identitet.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sastaviIdentitet, ucitajAgente, ucitajUpute, MAX_UPUTA } from '../src/razgovor/Identitet'
import { argumentiOvlasti, zabranePisanja } from '../src/razgovor/Ovlasti'

const dir = mkdtempSync(join(tmpdir(), 'identitet-'))
const osnova = { ime: 'Bot', instalacija: 'cvor', plocaUrl: 'http://127.0.0.1:17781', port: 17781, dokumenti: false, radniDir: '/srv/radni' }
const agenti = [
  { id: 'ana', ime: 'Ana', uloga: 'Engineer', vjestine: ['TDD', 'Development'] },
  { id: 'ivan', ime: 'Ivan', uloga: 'Security', vjestine: ['Recon'] },
]

describe('ucitajAgente', () => {
  test('registar s agents kao objektom', () => {
    const p = join(dir, 'reg.json')
    writeFileSync(p, JSON.stringify({ _meta: {}, agents: {
      ana: { id: 'ana', name: 'Ana', role: 'Engineer', skills: ['TDD', 'Development'] },
      ivan: { id: 'ivan', name: 'Ivan', role: 'Security', skills: [{ name: 'Recon' }] },
    } }))
    expect(ucitajAgente(p)).toEqual(agenti)
  })
  test('registar kao niz; zapis bez id-a se preskače', () => {
    const p = join(dir, 'niz.json')
    writeFileSync(p, JSON.stringify([{ id: 'ana', name: 'Ana', role: 'Engineer' }, { name: 'bez id' }]))
    expect(ucitajAgente(p)).toEqual([{ id: 'ana', ime: 'Ana', uloga: 'Engineer', vjestine: [] }])
  })
  test('nepostojeći ili nečitljiv registar = prazan popis', () => {
    expect(ucitajAgente(join(dir, 'nema.json'))).toEqual([])
    const p = join(dir, 'los.json')
    writeFileSync(p, '{nije json')
    expect(ucitajAgente(p)).toEqual([])
    expect(ucitajAgente(undefined)).toEqual([])
  })
})

describe('ucitajUpute', () => {
  test('čita vodič vlasnika', () => {
    const p = join(dir, 'CLAUDE.md')
    writeFileSync(p, '# Vodič\nServisi: x, y\n')
    expect(ucitajUpute(p)).toBe('# Vodič\nServisi: x, y')
  })
  test('bez putanje ili datoteke = null', () => {
    expect(ucitajUpute(undefined)).toBeNull()
    expect(ucitajUpute('')).toBeNull()
    expect(ucitajUpute(join(dir, 'nema.md'))).toBeNull()
  })
  test('predugačak vodič se reže na MAX_UPUTA uz oznaku', () => {
    const p = join(dir, 'dug.md')
    writeFileSync(p, 'a'.repeat(MAX_UPUTA + 500))
    const t = ucitajUpute(p)!
    expect(t.length).toBeLessThan(MAX_UPUTA + 100)
    expect(t).toContain('skraćeno')
  })
})

describe('sastaviIdentitet — upravitelj', () => {
  test('agenti iz registra su u identitetu na svakoj razini', () => {
    for (const ovlasti of ['citanje', 'rad', 'puno'] as const) {
      const t = sastaviIdentitet({ ...osnova, ovlasti, agenti })
      expect(t).toContain('ana — Ana, Engineer (TDD, Development)')
      expect(t).toContain('ivan — Ivan, Security (Recon)')
    }
  })

  test('puno: delegiranje kroz ploču — POST /api/tasks s assignee/projectId, uputa, blockedBy+blocks, pauza, pravila', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'puno', agenti })
    expect(t).toContain('upravitelj')
    expect(t).toContain('curl -s -X POST http://127.0.0.1:17781/api/tasks')
    expect(t).toContain('"assignee"')
    expect(t).toContain('"projectId"')
    expect(t).toContain('/api/tasks/<ID>/uputa')
    expect(t).toContain('blockedBy')
    expect(t).toContain('blocks')
    expect(t).toContain('/api/pause')
    expect(t).toMatch(/status.*ne postavljaš/i)
    expect(t).toMatch(/ne restartaj/i)
    expect(t).toMatch(/više struka|višestruč/i)
  })

  test('citanje/rad: nema uputa za otvaranje zadataka (nemaju POST na ploču)', () => {
    for (const ovlasti of ['citanje', 'rad'] as const) {
      const t = sastaviIdentitet({ ...osnova, ovlasti, agenti })
      expect(t).not.toContain('-X POST')
      expect(t).not.toContain('upravitelj')
    }
  })

  test('vodič vlasnika ide u identitet kao podatak vlasnika, ne mijenja ovlasti', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'citanje', upute: 'Servis regoc-x je na :1234' })
    expect(t).toContain('[VODIČ VLASNIKA')
    expect(t).toContain('Servis regoc-x je na :1234')
    expect(t).toContain('[/VODIČ VLASNIKA]')
    // Ovlasti su i dalje one iz razine, i stoje ispred vodiča.
    expect(t.indexOf('razina „citanje"')).toBeLessThan(t.indexOf('[VODIČ VLASNIKA'))
  })

  test('bez agenata i vodiča identitet je kao prije', () => {
    const t = sastaviIdentitet({ ...osnova, ovlasti: 'citanje' })
    expect(t).not.toContain('Agenti')
    expect(t).not.toContain('VODIČ')
  })
})

describe('vodič vlasnika je zaštićen od pisanja', () => {
  test('zabranePisanja uključuje dodatne datoteke', () => {
    const z = zabranePisanja('/srv/radni', ['/home/u/CLAUDE.md'])
    expect(z).toContain('Edit(//home/u/CLAUDE.md)')
    expect(z).toContain('Write(//home/u/CLAUDE.md)')
  })
  test('argumentiOvlasti prenosi zaštićene datoteke na svakoj razini', () => {
    for (const r of ['citanje', 'rad', 'puno'] as const) {
      const a = argumentiOvlasti(r, { port: 17781, radniDir: '/srv/radni', tmHome: '/tm', home: '/home/u', zasticene: ['/home/u/CLAUDE.md'] })
      const s = JSON.parse(a[a.indexOf('--settings') + 1]!)
      expect(s.permissions.deny).toContain('Write(//home/u/CLAUDE.md)')
      expect(s.permissions.deny).toContain('Edit(//home/u/CLAUDE.md)')
    }
  })
})
