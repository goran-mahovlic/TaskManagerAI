#!/usr/bin/env bun
/**
 * VerifiedComparison - Automatsko prikupljanje dokaza za usporedbe
 * Sprjecava agent halucinacije zahtijevajuci numericku evidenciju
 *
 * Usage:
 *   bun VerifiedComparison.ts <file_a> <file_b> [pattern]
 *
 * Example:
 *   bun VerifiedComparison.ts /path/to/a.py /path/to/b.py "retry|watchdog"
 */

import { $ } from 'bun'
import { ComparisonClaimSchema, type ComparisonClaim, type FileEvidence } from './zod/schemas/verification'

export async function gatherFileEvidence(
  filePath: string,
  pattern?: string
): Promise<FileEvidence> {
  // Check if file exists
  const fileExists = await Bun.file(filePath).exists();
  if (!fileExists) {
    return {
      path: filePath,
      line_count: 0,
      pattern: pattern,
      pattern_matches: pattern ? 0 : undefined,
      command_used: 'file_not_found',
    };
  }

  // Line count
  let lineCount = 0;
  try {
    const wcResult = await $`wc -l < ${filePath}`.text();
    lineCount = parseInt(wcResult.trim()) || 0;
  } catch {
    lineCount = 0;
  }

  // Pattern matches (if pattern provided)
  let patternMatches = 0;
  if (pattern) {
    try {
      const grepResult = await $`grep -cE ${pattern} ${filePath}`.text();
      patternMatches = parseInt(grepResult.trim()) || 0;
    } catch {
      // grep returns exit code 1 when no matches found
      patternMatches = 0;
    }
  }

  return {
    path: filePath,
    line_count: lineCount,
    pattern: pattern,
    pattern_matches: pattern ? patternMatches : undefined,
    command_used: pattern ? `wc -l && grep -cE "${pattern}"` : 'wc -l',
  };
}

export async function createVerifiedComparison(
  fileA: string,
  fileB: string,
  pattern?: string,
  agentId: string = 'system'
): Promise<ComparisonClaim> {
  // 1. Prikupi evidenciju AUTOMATSKI (ne vjeruj agentu!)
  const evidenceA = await gatherFileEvidence(fileA, pattern);
  const evidenceB = await gatherFileEvidence(fileB, pattern);

  // 2. Odredi pobjednika na temelju brojeva
  const metric = pattern ? 'pattern_matches' : 'line_count';
  const valueA = pattern ? evidenceA.pattern_matches! : evidenceA.line_count;
  const valueB = pattern ? evidenceB.pattern_matches! : evidenceB.line_count;

  let winner: 'source_a' | 'source_b' | 'equal';
  if (valueA > valueB) winner = 'source_a';
  else if (valueB > valueA) winner = 'source_b';
  else winner = 'equal';

  // 3. Kreiraj claim
  const claim: ComparisonClaim = {
    claim_type: 'file_comparison',
    evidence: {
      source_a: evidenceA,
      source_b: evidenceB,
    },
    conclusion: {
      winner,
      metric,
      reason: `${metric}: A=${valueA}, B=${valueB} -> ${winner === 'equal' ? 'jednaki' : winner + ' ima vise'}`,
    },
    verified_at: new Date().toISOString(),
    verified_by: agentId,
  };

  // 4. ZOD validacija (dvostruka provjera)
  const validated = ComparisonClaimSchema.safeParse(claim);
  if (!validated.success) {
    console.error('ZOD VALIDATION ERRORS:');
    validated.error.issues.forEach(issue => {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    });
    throw new Error(`ZOD VALIDATION FAILED: ${validated.error.message}`);
  }

  return validated.data;
}

// Test za detekciju halucinacija
export function testHallucinationDetection(): boolean {
  console.log('\n=== TEST: Halucinacija detekcija ===\n');

  // Pokusaj kreirati lazan claim gdje A ima manje ali tvrdi da je pobjednik
  const falseClaimData = {
    claim_type: 'file_comparison' as const,
    evidence: {
      source_a: { path: '/fake/a.py', line_count: 10, pattern_matches: 5 },
      source_b: { path: '/fake/b.py', line_count: 100, pattern_matches: 50 },
    },
    conclusion: {
      winner: 'source_a' as const, // LAZNO! B ima vise
      metric: 'pattern_matches',
      reason: 'A ima vise matcheva (LAZNO!)',
    },
    verified_at: new Date().toISOString(),
    verified_by: 'test',
  };

  const result = ComparisonClaimSchema.safeParse(falseClaimData);

  if (!result.success) {
    console.log('USPJESNO DETEKTIRANA HALUCINACIJA!');
    console.log('Error:', result.error.issues[0]?.message);
    return true;
  } else {
    console.log('GRESKA: Halucinacija nije detektirana!');
    return false;
  }
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);

  // Special test mode
  if (args[0] === '--test') {
    const passed = testHallucinationDetection();
    process.exit(passed ? 0 : 1);
  }

  if (args.length < 2) {
    console.log('VerifiedComparison - Sprjecava agent halucinacije\n');
    console.log('Usage:');
    console.log('  bun VerifiedComparison.ts <file_a> <file_b> [pattern]');
    console.log('  bun VerifiedComparison.ts --test\n');
    console.log('Example:');
    console.log('  bun VerifiedComparison.ts /path/to/github.py /path/to/gitlab.py "retry|watchdog|WDT"');
    process.exit(1);
  }

  const [fileA, fileB, pattern] = args;

  try {
    console.log(`\nUsporedba datoteka:`);
    console.log(`  A: ${fileA}`);
    console.log(`  B: ${fileB}`);
    if (pattern) console.log(`  Pattern: ${pattern}`);
    console.log('');

    const result = await createVerifiedComparison(fileA, fileB, pattern, 'cli');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('ERROR:', error);
    process.exit(1);
  }
}
