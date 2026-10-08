/**
 * Sposobnosti → neobavezne ovisnosti (TASK-5358, uputa #200).
 *
 * Neobavezna knjižnica (`optionalDependencies`) ne smije rušiti osnovnu instalaciju — ali kad
 * je sposobnost UKLJUČENA u postavkama čvora, instalacija je mora sama povući. Poruka
 * korisniku „pokreni bun add …" nije rješenje: vlasnik ne radi u ljusci čvora.
 *
 * Ovdje je samo PRESLIKA (koja sposobnost treba koju knjižnicu) i provjera razrješivosti;
 * instalaciju izvodi `scripts/sposobnosti.ts` (zove ga `install.sh` i ažuriranje čvora).
 *
 * Autorica: Jelena (Engineer), TASK-5358.
 */

import { loadEmailConfig, type EmailPostavke } from './EmailConfig'

export interface Potreba { sposobnost: string; paketi: string[] }

/** Koje knjižnice trebaju uključene sposobnosti. Isključena sposobnost ne traži ništa. */
export function potrebneOvisnosti(o: { email?: EmailPostavke } = {}): Potreba[] {
  const out: Potreba[] = []
  const e = o.email ?? loadEmailConfig()
  if (e.ukljucen) {
    if (e.smjer === 'izlaz' || e.smjer === 'oba') out.push({ sposobnost: 'e-pošta: slanje (SMTP)', paketi: ['nodemailer'] })
    if (e.smjer === 'ulaz' || e.smjer === 'oba') out.push({ sposobnost: 'e-pošta: provjera (IMAP)', paketi: ['imapflow', 'mailparser'] })
  }
  return out
}

/** Je li paket razrješiv iz mape paketa (bez učitavanja). */
export function imaPaket(ime: string, iz: string): boolean {
  try { Bun.resolveSync(ime, iz); return true } catch { return false }
}

export function nedostaju(potrebe: Potreba[], iz: string, ima: (p: string, iz: string) => boolean = imaPaket): string[] {
  return [...new Set(potrebe.flatMap(p => p.paketi))].filter(p => !ima(p, iz))
}
