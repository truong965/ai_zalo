import { z } from 'zod';

/**
 * Schema for Translate Input validation
 */
export const TranslateInputSchema = z.object({
  messageId: z.string().min(1, 'messageId is required').optional(),
  text: z.string().min(1, 'text is required').optional(),
  targetLang: z.enum(['vi', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'th']),
  conversationId: z.string().uuid(),
  userId: z.string(),
}).refine((input) => Boolean(input.messageId || input.text), {
  message: 'Either messageId or text must be provided',
  path: ['messageId'],
});

/**
 * Schema for Ask Input validation
 */
export const AskInputSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string(),
  text: z.string().min(3, 'Question must be at least 3 characters'),
  stream: z.boolean().optional().default(false),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

/**
 * Schema for Summary Input validation
 */
export const SummaryInputSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startMessageId: z.string().optional(),
  endMessageId: z.string().optional(),
});

export type TranslateInput = z.infer<typeof TranslateInputSchema>;
export type AskInput = z.infer<typeof AskInputSchema>;
export type SummaryInput = z.infer<typeof SummaryInputSchema>;
