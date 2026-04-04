import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';

export function createTranslateTool(
  translateService: TranslateService,
) {
  return tool(
    async ({ textToTranslate, targetLang }) => {
      try {
        if (!textToTranslate || !textToTranslate.trim()) {
          return 'Không tìm thấy văn bản để dịch.';
        }

        const result = await translateService.translate(
          textToTranslate.trim(),
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
        'Dịch thẳng văn bản sang ngôn ngữ khác. ' +
        'Dùng khi user yêu cầu dịch (translate, dịch, 翻訳). ' +
        'Bạn PHẢI trích xuất hoặc cung cấp nội dung cần dịch vào trường textToTranslate và mã ngôn ngữ đích (vi, en, ja, ko, zh, fr, de, es, th).',
      schema: z.object({
        textToTranslate: z.string().describe('Nội dung văn bản cần dịch'),
        targetLang: z
          .enum(['vi', 'en', 'ja', 'ko', 'zh', 'fr', 'de', 'es', 'th'])
          .describe('Mã ngôn ngữ đích'),
      }),
    },
  );
}
