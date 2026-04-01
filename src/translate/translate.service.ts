import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import {
  TranslateResult,
  ValidationError,
  TranslateError,
} from './translate.types';

@Injectable()
export class TranslateService {
  private readonly logger = new Logger(TranslateService.name);
  private readonly supportedLangs: Record<string, string> = {
    'vi': 'Vietnamese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese',
    'fr': 'French',
    'de': 'German',
    'es': 'Spanish',
    'th': 'Thai',
  };

  constructor(
    private readonly gemini: GeminiService,
  ) { }

  async translate(text: string, targetLang: string): Promise<TranslateResult> {
    this.logger.log(`Translating to ${targetLang}: ${text.substring(0, 50)}...`);

    // Validate target language
    const normalizedTarget = targetLang.toLowerCase().trim();
    if (!Object.keys(this.supportedLangs).includes(normalizedTarget)) {
      throw new ValidationError(
        `Unsupported language: ${targetLang}. Supported: ${Object.keys(this.supportedLangs).join(', ')}`,
      );
    }

    // Validate text length
    if (!text || text.trim().length === 0) {
      throw new ValidationError('Text to translate cannot be empty');
    }

    const truncatedText = text.substring(0, 5000); // hard limit

    const startTime = Date.now();
    try {
      const translated = await this.geminiTranslate(
        truncatedText,
        normalizedTarget,
      );

      const duration = Date.now() - startTime;
      this.logger.debug(`Translation to ${normalizedTarget} completed in ${duration}ms`);

      return {
        originalText: text,
        translatedText: translated,
        sourceLang: 'auto',
        targetLang: normalizedTarget,
        skipped: false,
        engine: 'gemini',
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      this.logger.error(`Gemini translation failed after ${duration}ms: ${err.message}`);

      if (err.message?.includes('timeout') || err.message?.includes('AbortError')) {
        throw new TranslateError(`Dịch thuật bị quá hạn (timeout). Có thể do máy chủ đang quá tải. Vui lòng thử lại sau.`);
      }
      throw new TranslateError(`Dịch thuật thất bại: ${err.message}`);
    }
  }

  private async geminiTranslate(
    text: string,
    targetLang: string,
  ): Promise<string> {
    const langName = this.supportedLangs[targetLang] ?? targetLang;
    const prompt = `Bạn là một dịch giả chuyên nghiệp, sành điệu và am hiểu văn hóa Việt Nam - Quốc tế. Nhiệm vụ:
  1. Dịch đoạn văn bản người dùng đưa sang ngôn ngữ đích: ${langName}.
  2. BẮT BUỘC giữ nguyên TÊN RIÊNG (tên người, địa danh) hoặc DANH TỪ CÔNG NGHỆ.
  3. Linh hoạt dịch mượt mà các từ lóng (slang) và từ viết tắt sao cho hợp ngữ cảnh.
  4. CHỈ in ra kết quả bản dịch cuối cùng, không kèm giải thích, chào hỏi hay dấu ngoặc kép.

Nội dung cần dịch:
${text}`;

    return await this.gemini.generateText(prompt);
  }
}
