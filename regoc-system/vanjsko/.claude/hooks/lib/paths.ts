/**
 * Centralized Path Resolution
 *
 * Handles environment variable expansion for portable REGOČ configuration.
 * Claude Code doesn't expand $HOME in settings.json env values, so we do it here.
 *
 * Usage:
 *   import { getRegocDir, getSettingsPath } from './lib/paths';
 *   const regocDir = getRegocDir(); // Always returns expanded absolute path
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();

  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

/**
 * Get the REGOČ directory (expanded)
 * Priority: REGOC_DIR env var → PAI_DIR (backward compat) → ~/.claude
 */
export function getRegocDir(): string {
  const envRegocDir = process.env.REGOC_DIR || process.env.PAI_DIR;

  if (envRegocDir) {
    return expandPath(envRegocDir);
  }

  return join(homedir(), '.claude');
}

// Backward compatibility alias
export const getPaiDir = getRegocDir;

/**
 * Get the settings.json path
 */
export function getSettingsPath(): string {
  return join(getPaiDir(), 'settings.json');
}

/**
 * Get a path relative to REGOC_DIR
 */
export function regocPath(...segments: string[]): string {
  return join(getRegocDir(), ...segments);
}

// Backward compatibility alias
export const paiPath = regocPath;

/**
 * Get the hooks directory
 */
export function getHooksDir(): string {
  return paiPath('hooks');
}

/**
 * Get the skills directory
 */
export function getSkillsDir(): string {
  return paiPath('skills');
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  return paiPath('MEMORY');
}
