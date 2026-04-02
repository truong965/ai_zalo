import { z } from 'zod';

/**
 * Zod schema for the Critic evaluator's structured output.
 * GPT-5 Nano will use this to provide a consistent quality check.
 */
export const CriticOutputSchema = z.object({
  groundedness: z.number().min(0).max(1)
    .describe('Mức độ mà câu trả lời được hỗ trợ bởi ngữ cảnh. 1.0 = hoàn toàn dựa trên context.'),
  
  completeness: z.number().min(0).max(1)
    .describe('Mức độ mà câu trả lời trả lời đầy đủ câu hỏi.'),
  
  hallucination_risk: z.number().min(0).max(1)
    .describe('Mức độ nghi ngờ câu trả lời chứa thông tin bịa đặt. 0.0 = không bịa.'),
  
  hallucinations: z.array(z.string())
    .describe('Danh sách cụ thể các claim trong câu trả lời không có trong context.'),
  
  verdict: z.enum(['PASS', 'FAIL', 'PARTIAL'])
    .describe('PASS nếu groundedness >= 0.7 và hallucination_risk < 0.3. FAIL nếu ngược lại.'),
  
  reasoning: z.string()
    .describe('Giải thích ngắn gọn tại sao đánh giá như vậy.'),
});

export type CriticOutput = z.infer<typeof CriticOutputSchema>;
