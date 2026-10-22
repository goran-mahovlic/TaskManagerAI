#!/usr/bin/env bun
/**
 * ============================================================================
 * INFERENCE - Unified inference tool with three run levels
 * ============================================================================
 *
 * PURPOSE:
 * Single inference tool with configurable speed/capability trade-offs:
 * - Fast: Haiku - quick tasks, simple generation, basic classification
 * - Standard: Sonnet - balanced reasoning, typical analysis
 * - Smart: Opus - deep reasoning, strategic decisions, complex analysis
 *
 * USAGE:
 *   bun Inference.ts --level fast <system_prompt> <user_prompt>
 *   bun Inference.ts --level standard <system_prompt> <user_prompt>
 *   bun Inference.ts --level smart <system_prompt> <user_prompt>
 *   bun Inference.ts --json --level fast <system_prompt> <user_prompt>
 *
 * OPTIONS:
 *   --level <fast|standard|smart>  Run level (default: standard)
 *   --json                         Expect and parse JSON response
 *   --timeout <ms>                 Custom timeout (default varies by level)
 *
 * DEFAULTS BY LEVEL:
 *   fast:     model=haiku,   timeout=15s
 *   standard: model=sonnet,  timeout=30s
 *   smart:    model=opus,    timeout=90s
 *
 * BILLING: Uses Claude CLI with subscription (not API key)
 *
 * ============================================================================
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from 'os'

export type InferenceLevel = 'fast' | 'standard' | 'smart';

export interface InferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  expectJson?: boolean;
  timeout?: number;
  /**
   * TASK-2568: 'local' prisiljava LOKALNU Ollamu za ovaj JEDAN poziv (mehanički
   * korak — klasifikacija/ekstrakcija — koji ne treba plaćeni model i ne smije
   * pasti kad Anthropic API ode u rate-limit). 'auto' (default) = staro ponašanje.
   */
  backend?: 'auto' | 'local';
}

export interface InferenceResult {
  success: boolean;
  output: string;
  parsed?: unknown;
  error?: string;
  latencyMs: number;
  level: InferenceLevel;
}

// Level configurations
const LEVEL_CONFIG: Record<InferenceLevel, { model: string; defaultTimeout: number }> = {
  fast: { model: 'haiku', defaultTimeout: 15000 },
  standard: { model: 'sonnet', defaultTimeout: 30000 },
  smart: { model: 'opus', defaultTimeout: 90000 },
};

/**
 * Ollama backend (appliance/headless: nema claude CLI-ja). Aktivira se env-om
 * REGOC_INFERENCE_PROVIDER=ollama; koristi OLLAMA_HOST + REGOC_INFERENCE_MODEL (default qwen3:8b).
 * Backward-safe: bez env-a se koristi originalni claude CLI put.
 */
/**
 * Adresa i model lokalne Ollame. Redoslijed: env (appliance) → `model-config.json`
 * (izvor istine za REGOČ, `providers.ollama.baseUrl` + `componentOverrides.classifier`)
 * → localhost. Bez ovoga bi u kontejneru gađao 127.0.0.1:11434, gdje Ollame nema.
 */
function readModelConfig(): any {
  try {
    const HOME = process.env.HOME || homedir();
    return JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'));
  } catch { return null; }
}

function ollamaHost(): string {
  if (process.env.OLLAMA_HOST) return process.env.OLLAMA_HOST.replace(/\/+$/, '');
  const u = readModelConfig()?.providers?.ollama?.baseUrl;
  return (typeof u === 'string' && u ? u : 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

function ollamaModelFromConfig(): string | null {
  const spec = readModelConfig()?.componentOverrides?.classifier;
  if (typeof spec !== 'string' || !spec.startsWith('ollama:')) return null;
  return spec.slice('ollama:'.length);
}

async function inferenceOllama(options: InferenceOptions): Promise<InferenceResult> {
  const level = options.level || 'standard';
  const startTime = Date.now();
  const timeout = options.timeout || LEVEL_CONFIG[level].defaultTimeout;
  const host = ollamaHost();
  const model = process.env.REGOC_INFERENCE_MODEL || ollamaModelFromConfig() || 'qwen3:8b';
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: options.userPrompt },
        ],
        stream: false,
        think: false,
        // Model ostaje rezidentan (default 30 min) -> samo PRVI poziv nakon idle je hladan.
        // Bez ovoga se qwen3:8b izbaci nakon 5 min i svaki sljedeci poziv hladno ucita
        // (~19s load), sto pod opterecenjem .4 prelazi timeout -> "AI inference failed -> regex".
        keep_alive: process.env.REGOC_OLLAMA_KEEPALIVE || '30m',
        ...(options.expectJson ? { format: 'json' } : {}),
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    });
    clearTimeout(to);
    const j = await res.json() as any;
    const output = String(j?.message?.content || '').trim();
    const latencyMs = Date.now() - startTime;
    if (!output) return { success: false, output: '', error: 'Empty Ollama response', latencyMs, level };
    if (options.expectJson) {
      const m = output.match(/\{[\s\S]*\}/);
      if (m) {
        try { return { success: true, output, parsed: JSON.parse(m[0]), latencyMs, level }; }
        catch { return { success: false, output, error: 'Failed to parse JSON response', latencyMs, level }; }
      }
      return { success: false, output, error: 'No JSON found in response', latencyMs, level };
    }
    return { success: true, output, latencyMs, level };
  } catch (e: any) {
    return { success: false, output: '', error: String(e?.message || e), latencyMs: Date.now() - startTime, level };
  }
}

/**
 * Run inference with configurable level
 */
export async function inference(options: InferenceOptions): Promise<InferenceResult> {
  // Appliance: preusmjeri na Ollamu (nema claude CLI-ja) — bez env-a ostaje claude put.
  if (process.env.REGOC_INFERENCE_PROVIDER === 'ollama') return inferenceOllama(options);
  // TASK-2568: pojedinačni mehanički poziv izričito traži lokalni model.
  if (options.backend === 'local') return inferenceOllama(options);
  const level = options.level || 'standard';
  const config = LEVEL_CONFIG[level];
  const startTime = Date.now();
  const timeout = options.timeout || config.defaultTimeout;

  return new Promise((resolve) => {
    // Build clean environment for claude CLI
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;  // Force subscription auth
    delete env.CLAUDECODE;          // Prevent nested session detection
    delete env.CLAUDE_CODE_ENTRYPOINT; // Prevent nested session detection

    const args = [
      '--print',
      '--model', config.model,
      '--tools', '',  // Disable tools for faster response
      '--output-format', 'text',
      '--setting-sources', '',  // Disable hooks to prevent recursion
      '--system-prompt', options.systemPrompt,
      options.userPrompt,
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        success: false,
        output: '',
        error: `Timeout after ${timeout}ms`,
        latencyMs: Date.now() - startTime,
        level,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (code !== 0) {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          latencyMs,
          level,
        });
        return;
      }

      const output = stdout.trim();

      // Parse JSON if requested
      if (options.expectJson) {
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            resolve({
              success: true,
              output,
              parsed,
              latencyMs,
              level,
            });
            return;
          } catch {
            resolve({
              success: false,
              output,
              error: 'Failed to parse JSON response',
              latencyMs,
              level,
            });
            return;
          }
        }
        resolve({
          success: false,
          output,
          error: 'No JSON found in response',
          latencyMs,
          level,
        });
        return;
      }

      resolve({
        success: true,
        output,
        latencyMs,
        level,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        output: '',
        error: err.message,
        latencyMs: Date.now() - startTime,
        level,
      });
    });
  });
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse flags
  let expectJson = false;
  let timeout: number | undefined;
  let level: InferenceLevel = 'standard';
  const positionalArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      expectJson = true;
    } else if (args[i] === '--level' && args[i + 1]) {
      const requestedLevel = args[i + 1].toLowerCase();
      if (['fast', 'standard', 'smart'].includes(requestedLevel)) {
        level = requestedLevel as InferenceLevel;
      } else {
        console.error(`Invalid level: ${args[i + 1]}. Use fast, standard, or smart.`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  if (positionalArgs.length < 2) {
    console.error('Usage: bun Inference.ts [--level fast|standard|smart] [--json] [--timeout <ms>] <system_prompt> <user_prompt>');
    process.exit(1);
  }

  const [systemPrompt, userPrompt] = positionalArgs;

  const result = await inference({
    systemPrompt,
    userPrompt,
    level,
    expectJson,
    timeout,
  });

  if (result.success) {
    if (expectJson && result.parsed) {
      console.log(JSON.stringify(result.parsed));
    } else {
      console.log(result.output);
    }
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
