import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AskService } from '../ask/ask.service';

export function createAskTool(askService: AskService) {
  return tool(
    async ({ question, conversationId, userId, startDate, endDate }) => {
      const messages = await askService.retrieveOnly(conversationId, userId, question, startDate, endDate);

      return JSON.stringify({ context: messages });
    },
    {
      name: 'search_chat_history',
      description:
        'Tìm kiếm thông tin trong lịch sử chat của cuộc trò chuyện hiện tại. ' +
        'Dùng khi người dùng hỏi về những gì đã được thảo luận trước đó. ' +
        'Ví dụ: "thông tin về deadline?", "ngân sách dự án là bao nhiêu?". Có thể nhận diện thời gian nếu câu hỏi có mốc thời gian.',
      schema: z.object({
        question: z.string().describe('Câu hỏi về lịch sử chat'),
        conversationId: z.string().describe('ID của cuộc trò chuyện'),
        userId: z.string().describe('ID của người dùng hiện tại đang yêu cầu tìm kiếm'),
        startDate: z.string().optional().describe('Thời gian bắt đầu (nếu có, định dạng ISO)'),
        endDate: z.string().optional().describe('Thời gian kết thúc (nếu có, định dạng ISO)'),
      }),
    },
  );
}
