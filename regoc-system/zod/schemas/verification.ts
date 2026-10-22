import { z } from 'zod'
import { AgentIdSchema } from './task'

// Evidence schema - OBAVEZNI numericki dokazi
export const FileEvidenceSchema = z.object({
  path: z.string().min(1),
  line_count: z.number().int().nonnegative(),
  pattern: z.string().optional(),
  pattern_matches: z.number().int().nonnegative().optional(),
  command_used: z.string().optional(), // npr. "wc -l" ili "grep -c"
})

// Claim type enum
export const ClaimTypeSchema = z.enum([
  'file_comparison', 'feature_comparison', 'version_comparison'
])

// Winner enum
export const WinnerSchema = z.enum([
  'source_a', 'source_b', 'equal', 'incomparable'
])

// Comparison claim schema
export const ComparisonClaimSchema = z.object({
  claim_type: ClaimTypeSchema,

  evidence: z.object({
    source_a: FileEvidenceSchema,
    source_b: FileEvidenceSchema,
  }),

  conclusion: z.object({
    winner: WinnerSchema,
    metric: z.string(), // npr. "line_count", "pattern_matches"
    reason: z.string().min(10),
  }),

  verified_at: z.string().datetime(),
  verified_by: z.string(), // agent ID

}).refine(data => {
  // Validacija: winner mora odgovarati brojevima!
  const metric = data.conclusion.metric as 'line_count' | 'pattern_matches';

  // Get values based on metric
  let a_value: number | undefined;
  let b_value: number | undefined;

  if (metric === 'line_count') {
    a_value = data.evidence.source_a.line_count;
    b_value = data.evidence.source_b.line_count;
  } else if (metric === 'pattern_matches') {
    a_value = data.evidence.source_a.pattern_matches;
    b_value = data.evidence.source_b.pattern_matches;
  }

  if (typeof a_value !== 'number' || typeof b_value !== 'number') {
    return true; // Skip validation if metric is not numeric
  }

  switch (data.conclusion.winner) {
    case 'source_a': return a_value > b_value;
    case 'source_b': return b_value > a_value;
    case 'equal': return a_value === b_value;
    case 'incomparable': return true;
    default: return true;
  }
}, {
  message: "HALUCINACIJA DETEKTIRANA: Zakljucak ne odgovara numerickoj evidenciji!"
});

// Model enum
export const ModelSchema = z.enum(['opus', 'sonnet', 'haiku'])

// Agent output schema - za bilo koji strukturirani output
export const VerifiedAgentOutputSchema = z.object({
  agent_id: z.string(),
  task_description: z.string(),

  // Ako ima usporedbe, moraju biti verificirane
  comparisons: z.array(ComparisonClaimSchema).optional(),

  // Slobodni tekst zakljucak
  summary: z.string(),

  // Metadata
  timestamp: z.string().datetime(),
  model: ModelSchema,
})

// Type exports
export type FileEvidence = z.infer<typeof FileEvidenceSchema>
export type ClaimType = z.infer<typeof ClaimTypeSchema>
export type Winner = z.infer<typeof WinnerSchema>
export type ComparisonClaim = z.infer<typeof ComparisonClaimSchema>
export type Model = z.infer<typeof ModelSchema>
export type VerifiedAgentOutput = z.infer<typeof VerifiedAgentOutputSchema>
