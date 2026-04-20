import { Injectable, Logger } from '@nestjs/common';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { SessionCacheService } from '../sessions/session-cache.service';
import {
  TranslateResult,
  ValidationError,
  TranslateError,
} from './translate.types';

type TranslateContext = {
  conversationId?: string;
  userId?: string;
  messageId?: string;
  requestId?: string;
};

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
    private readonly llm: LlmGatewayService,
    private readonly internalClient: InternalClientService,
    private readonly sessionCache: SessionCacheService,
  ) { }

  async translate(text: string, targetLang: string, context?: TranslateContext): Promise<TranslateResult> {
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

    const detectedSource = this.detectLikelySourceLang(text);
    if (detectedSource !== 'unknown' && detectedSource === normalizedTarget) {
      this.logger.debug(
        `Skip translation: source and target are both ${normalizedTarget}`,
      );

      const skippedResult: TranslateResult = {
        originalText: text,
        translatedText: text,
        sourceLang: detectedSource,
        targetLang: normalizedTarget,
        skipped: true,
        engine: 'none',
        fromCache: false,
      };

      if (context?.conversationId && context.userId && context.messageId) {
        const hasAccess = await this.internalClient.validateAccess(context.conversationId, context.userId);
        if (!hasAccess) {
          throw new ValidationError('User does not have access to this conversation');
        }

        await this.sessionCache.setTranslationCache(context.messageId, normalizedTarget, skippedResult);
      }

      return skippedResult;
    }

    if (context?.messageId) {
      const cached = await this.sessionCache.getTranslationCache(context.messageId, normalizedTarget);
      if (cached) {
        return {
          ...(cached as TranslateResult),
          fromCache: true,
        };
      }
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

      const result: TranslateResult = {
        originalText: text,
        translatedText: translated,
        sourceLang: 'auto',
        targetLang: normalizedTarget,
        skipped: false,
        engine: 'llm-gateway',
        fromCache: false,
      };

      if (context?.conversationId && context.userId && context.messageId) {
        const hasAccess = await this.internalClient.validateAccess(context.conversationId, context.userId);
        if (!hasAccess) {
          throw new ValidationError('User does not have access to this conversation');
        }

        await this.sessionCache.setTranslationCache(context.messageId, normalizedTarget, result);
      }

      return result;
    } catch (err: any) {
      const duration = Date.now() - startTime;
      this.logger.error(`LLM translation failed after ${duration}ms: ${err.message}`);

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
    const prompt = `Bạn là một dịch giả chuyên nghiệp, rõ ràng và chính xác. Nhiệm vụ:
  1. Dịch đoạn văn bản người dùng đưa sang ngôn ngữ đích: ${langName}.
  2. BẮT BUỘC giữ nguyên TÊN RIÊNG (tên người, địa danh) hoặc DANH TỪ CÔNG NGHỆ.
  3. Linh hoạt dịch mượt mà các từ lóng (slang) và từ viết tắt sao cho hợp ngữ cảnh.
  4. CHỈ in ra kết quả bản dịch cuối cùng, không kèm giải thích, chào hỏi, lời dẫn hay dấu ngoặc kép.
  5. Giữ văn phong tự nhiên, không thêm câu mở đầu như "Chào bạn" hay "Xin chào".

Nội dung cần dịch:
${text}`;

    return await this.llm.generateText(prompt);
  }

  private detectLikelySourceLang(text: string): 'vi' | 'en' | 'unknown' {
    const normalized = text.toLowerCase();

    // Fast-path for Vietnamese diacritics.
    if (/[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/u.test(normalized)) {
      return 'vi';
    }

    const tokens = normalized.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (tokens.length === 0) {
      return 'unknown';
    }

    const viHints = new Set([
      'toi',
      'ban',
      'minh',
      'khong',
      'trong',
      'nhung',
      'voi',
      'la',
      'duoc',
      'roi',
      'nhe',
      'nha',
    ]);
    const enHints = new Set([
      'the',
      'and',
      'you',
      'are',
      'is',
      'to',
      'of',
      'in',
      'for',
      'that',
      'with',
      'this',
    ]);

    let viScore = 0;
    let enScore = 0;

    for (const token of tokens) {
      if (viHints.has(token)) viScore += 1;
      if (enHints.has(token)) enScore += 1;
    }

    if (viScore >= 2 && viScore > enScore) {
      return 'vi';
    }

    if (enScore >= 2 && enScore > viScore) {
      return 'en';
    }

    return 'unknown';
  }
}
