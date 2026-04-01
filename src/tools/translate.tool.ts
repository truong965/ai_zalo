import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';

export function createTranslateTool(
  translateService: TranslateService,
  internalClient: InternalClientService,
) {
  return tool(
    async ({ messageId, targetLang }) => {
      try {
        // Fetch original message
        const messages: any[] = (await internalClient.getMessages({
          messageIds: [messageId],
        })) as any;
        
        if (!messages || !messages.length) {
          return 'Không tìm thấy tin nhắn gốc để dịch.';
        }

        const result = await translateService.translate(
          messages[0].content || messages[0].text,
          targetLang,
        );

        if (result.skipped) {
          return `Tin nhắn đã ở ngôn ngữ ${targetLang}, không cần dịch.`;
        }

        return JSON.stringify({
          originalText: result.originalText,
          translatedText: result.translatedText,
          sourceLang: result.sourceLang,
          targetLang: result.targetLang,
          engine: result.engine,
        });
      } catch (error: any) {
        return `Lỗi khi dịch tin nhắn: ${error.message}`;
      }
    },
    {
      name: 'translate_message',
      description:
        'Dịch nội dung một tin nhắn chat sang ngôn ngữ khác. ' +
        'Dùng khi user yêu cầu dịch tin nhắn (translate, dịch, 翻訳). ' +
        'Cần messageId của tin nhắn cần dịch và mã ngôn ngữ đích (vi, en, ja, ko, zh, fr, de, es, th).',
      schema: z.object({
        messageId: z.string().describe('UUID của tin nhắn cần dịch'),
        targetLang: z
          .enum(['vi', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'th'])
          .describe('Mã ngôn ngữ đích'),
      }),
    },
  );
}
