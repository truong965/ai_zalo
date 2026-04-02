import { z } from 'zod';

/**
 * Relevance judgment for retrieved documents
 */
export const RelevanceJudgmentSchema = z.object({
  verdict: z.enum(['CORRECT', 'AMBIGUOUS', 'INCORRECT']),
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type RelevanceJudgment = z.infer<typeof RelevanceJudgmentSchema>;

/**
 * Query rewrite output
 */
export const RewrittenQueriesSchema = z.object({
  queries: z.array(z.string().min(3).max(200)).min(1).max(3),
  reasoning: z.string(),
});

export type RewrittenQueries = z.infer<typeof RewrittenQueriesSchema>;
