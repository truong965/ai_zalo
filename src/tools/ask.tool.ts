import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RetrieverService } from '../ask/retriever.service';

export function createAskTool(retrieverService: RetrieverService) {
  return tool(
    async ({ question, conversationId, userId, startDate, endDate }) => {
      // Simply retrieve context without grading or retry loops.
      // This logic delegates grading and rewriting to the LangGraph node.
      const messages = await retrieverService.retrieveOnly(conversationId, userId, question, startDate, endDate);

      if (!messages || messages.length === 0) {
        return "INCORRECT_CONTEXT: KHÔNG TÌM THẤY TÀI LIỆU PHÙ HỢP TRONG LỊCH SỬ. Hãy thông báo cho user là không tìm thấy thông tin.";
      }

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
