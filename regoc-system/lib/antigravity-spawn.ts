/**
 * antigravity-spawn — daemon vozi model `antigravity:<model>` kroz Antigravity CLI (TASK-5738).
 *
 * agy token Google prijave sprema u Keychain/secret-service koji usluga (launchd/systemd) ne
 * vidi; uz SSH_CONNECTION/SSH_CLIENT/SSH_TTY u okolini prelazi na datotečnu pohranu (izmjereno
 * 23.10.2026., agy 1.4.6). Prijava s ploče (Config → Prijava) nosi istu oznaku, pa spawn čita
 * isti token. Način ključa (GEMINI_API_KEY + modelProvider gemini u settings.json agy-ja) radi
 * kroz GEMINI_API_KEY koji daemon ionako stavlja u okolinu spawna.
 *
 * Paket ima isti dogovor u src/core/Antigravity.ts (razgovor, ploča).
 */

/** Model `antigravity:zadano` = bez --model (agy bira svoj). */
export const AGY_MODEL_ZADANO = 'zadano'

export function agyArgumentiSpawna(model: string, prompt: string): string[] {
  const a = ['agy', '-p', prompt, '--output-format', 'text', '--dangerously-skip-permissions']
  if (model && model !== AGY_MODEL_ZADANO) a.push('--model', model)
  return a
}

/** Okolina spawna (mijenja na mjestu): SSH oznaka za datotečnu pohranu, bez prijave u Claude. */
export function agyOkolinaSpawna(env: Record<string, string>): void {
  if (!env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY) env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  delete env.ANTHROPIC_API_KEY
}
