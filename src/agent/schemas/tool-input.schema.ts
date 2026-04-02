import { z } from 'zod';

/**
 * Schema for Translate Input validation
 */
export const TranslateInputSchema = z.object({
  messageId: z.string().min(1, 'messageId is required'),
  targetLang: z.enum(['vi', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'th']),
  conversationId: z.string().uuid(),
  userId: z.string(),
});

/**
 * Schema for Ask Input validation
 */
export const AskInputSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string(),
  text: z.string().min(3, 'Question must be at least 3 characters'),
  stream: z.boolean().optional().default(false),
});

/**
 * Schema for Summary Input validation
 */
export const SummaryInputSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string(),
});

export type TranslateInput = z.infer<typeof TranslateInputSchema>;
export type AskInput = z.infer<typeof AskInputSchema>;
export type SummaryInput = z.infer<typeof SummaryInputSchema>;
