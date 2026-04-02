import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AskService } from '../ask/ask.service';

export function createAskTool(askService: AskService) {
  return tool(
    async ({ question, conversationId, userId }) => {
      const result = await askService.ask(conversationId, userId, question);

      const sourcesText = result.sources
        .map((s, i) => `[${i + 1}] ${s.username}: "${(s.text || '').substring(0, 100)}..." (${new Date(s.createdAt).toLocaleDateString('vi-VN')})`)
        .join('\n');

      return `${result.answer}\n\n📌 Nguồn tham khảo:\n${sourcesText}`;
    },
    {
      name: 'search_chat_history',
      description:
        'Tìm kiếm thông tin trong lịch sử chat của cuộc trò chuyện hiện tại. ' +
        'Dùng khi người dùng hỏi về những gì đã được thảo luận trước đó. ' +
        'Ví dụ: "thông tin về deadline?", "ngân sách dự án là bao nhiêu?".',
      schema: z.object({
        question: z.string().describe('Câu hỏi về lịch sử chat'),
        conversationId: z.string().describe('ID của cuộc trò chuyện'),
        userId: z.string().describe('ID của người dùng hiện tại đang yêu cầu tìm kiếm'),
      }),
    },
  );
}
