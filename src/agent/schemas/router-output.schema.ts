import { z } from 'zod';

/**
 * Output schema for GPT-5 Nano Intent Router
 */
export const RouterOutputSchema = z.object({
  intent: z.enum(['ask', 'translate', 'summary', 'clarify', 'general_chat'])
    .describe('Mục đích của câu hỏi người dùng: tìm kiếm lịch sử (ask), dịch tin nhắn (translate), tóm tắt (summary), cần hỏi lại vì mơ hồ (clarify), hoặc trò chuyện xã giao (general_chat).'),
  
  confidence: z.number().min(0).max(1)
    .describe('Độ tin tưởng vào việc phân loại intent từ 0.0 đến 1.0.'),
  
  reasoning: z.string()
    .describe('1-2 câu giải thích tại sao lại chọn intent này.'),
  
  params: z.object({
    targetLang: z.string().nullable()
      .describe('Mã ngôn ngữ đích nếu intent là translate (VD: en, ja, vi). Nếu không có, để null.'),
    messageId: z.string().nullable()
      .describe('UUID của tin nhắn cần dịch nếu intent là translate. Nếu không có, để null.'),
    searchQuery: z.string().nullable()
      .describe('Câu truy vấn đã được tối ưu hóa để tìm kiếm trong lịch sử chat nếu intent là ask. Nếu không có, để null.'),
  }).describe('Các tham số bổ sung được trích xuất từ câu hỏi.'),
});

export type RouterOutput = z.infer<typeof RouterOutputSchema>;
