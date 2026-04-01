import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { SummaryService } from '../summary/summary.service';

export function createSummaryTool(summaryService: SummaryService) {
  return tool(
    async ({ conversationId }) => {
      const result = await summaryService.summarize(conversationId);
      const cacheNote = result.fromCache ? ' (từ cache)' : '';
      return `📝 Tóm tắt ${result.messageCount} tin nhắn gần nhất${cacheNote}:\n\n${result.summary}`;
    },
    {
      name: 'summarize_chat',
      description:
        'Tóm tắt nội dung cuộc trò chuyện hiện tại. ' +
        'Sử dụng khi người dùng yêu cầu digest, recap hoặc muốn biết tin nhắn gần đây nói về cái gì.',
      schema: z.object({
        conversationId: z.string().describe('ID của cuộc trò chuyện'),
      }),
    },
  );
}
