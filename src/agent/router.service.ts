import { Injectable, Logger, Inject } from '@nestjs/common';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { RouterOutput, RouterOutputSchema } from './schemas/router-output.schema';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { AbortUtils } from '../shared/abort.utils';

import { LangfuseCallbackProvider } from '../shared/langfuse-callback.provider';

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly CACHE_TTL = 3600; // 1 hour for intent routing cache

  private get SYSTEM_PROMPT() {
    return `
Bạn là một bộ phân loại intent cho ứng dụng chat AI assistant (ai_zalo). 
Phân tích câu hỏi của người dùng và xác định intent phù hợp nhất để hệ thống có thể kích hoạt đúng công cụ.
Thời gian hiện tại của hệ thống: ${new Date().toISOString()}

Các intent có sẵn:
1. "ask": Người dùng hỏi về nội dung, thông tin, hoặc những gì đã được thảo luận trong lịch sử chat. 
   VD: "ai nói gì về deadline?", "thông tin về ngân sách dự án là bao nhiêu?", "tìm thông tin về X".
2. "translate": Người dùng muốn dịch một tin nhắn cụ thể sang ngôn ngữ khác. 
   VD: "dịch tin nhắn này sang tiếng Anh", "translate to Japanese", "dịch cái này sang tiếng Hàn".
   Lưu ý: Nếu người dùng không chỉ định tin nhắn cụ thể nhưng từ ngữ cho thấy họ muốn dịch, hãy trích xuất targetLang.
3. "summary": Người dùng muốn tóm tắt lại nội dung cuộc trò chuyện. 
   VD: "tóm tắt cuộc hội thoại", "recap tin nhắn gần đây", "hôm nay mọi người nói gì thế?".
4. "clarify": Câu hỏi quá mơ hồ, quá ngắn hoặc không đủ thông tin để xác định intent. 
   VD: "...", "hm", "ok", "này".
5. "general_chat": Các câu chào hỏi hoặc trò chuyện xã giao không cần dùng đến các công cụ trên. 
   VD: "xin chào", "bạn là ai?", "bạn khỏe không?".

Yêu cầu:
- Trả về confidence cao (0.8 - 1.0) khi intent rõ ràng.
- Trả về confidence thấp (< 0.7) nếu bạn không chắc chắn.
- Nếu là intent "ask", hãy viết lại câu hỏi người dùng thành một search query ngắn gọn, súc tích trong trường params.searchQuery.
- Nếu là intent "translate", hãy cố gắng trích xuất targetLang (vi, en, ja, ko, zh, fr, de, es, th) trong trường params.targetLang.
- NẾU người dùng hỏi kèm thời gian (VD: "hôm nay", "từ sáng", "tuần trước"), HÃY BẮT BUỘC TRÍCH XUẤT ra startDate và endDate dưới dạng ISO 8601 string chuẩn xác. Dùng "Thời gian hiện tại" để tính toán.
`;
  }

  constructor(
    private readonly openai: LlmGatewayService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly langfuseCallback: LangfuseCallbackProvider,
  ) { }

  /**
   * Classify user intent using GPT-5 Nano structured output with optional reasoning streaming
   */
  async classify(
    text: string,
    context?: { conversationId?: string; signal?: AbortSignal },
    onThought?: (chunk: string) => void
  ): Promise<RouterOutput> {
    this.logger.debug(`Classifying intent for: "${text}"`);

    // Hash text to use as cache key
    const hashedText = crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
    const cacheKey = `router:cache:${hashedText}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug(`Router cache hit for: "${text}"`);
        const result = JSON.parse(cached) as RouterOutput;
        if (onThought && result.reasoning) {
          onThought(result.reasoning);
        }
        return result;
      }
    } catch (err) {
      this.logger.warn(`Redis cache get failed: ${err}`);
    }

    const prompt = `
Dưới đây là câu hỏi của người dùng:
"${text}"

Hãy phân loại intent và trích xuất các tham số cần thiết.
${context?.conversationId ? `Conversation ID: ${context.conversationId}` : ''}
`;

    try {
      let result: RouterOutput;
      const callbacks = this.langfuseCallback?.handler ? [this.langfuseCallback.handler] : undefined;

      const structuredModel = this.openai.getLangchainModel({ 
        temperature: 0,
        structuredSchema: RouterOutputSchema,
        structuredName: 'router_output'
      });
      
      const response = await (structuredModel as any).invoke(this.SYSTEM_PROMPT + prompt, { 
        signal: context?.signal,
        callbacks 
      });

      result = response as RouterOutput;

      this.logger.log(`Intent classified: ${result.intent} (Confidence: ${result.confidence})`);

      try {
        // Cache for 5 minutes (300 seconds)
        await this.redis.setex(cacheKey, 300, JSON.stringify(result));
      } catch (err) {
        this.logger.warn(`Redis cache set failed: ${err}`);
      }

      return result;
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Router classification cancelled by user`);
        throw err;
      }
      this.logger.error(`Router classification failed: ${err.message}`);
      // Fallback to clarify if LLM fails
      return {
        intent: 'clarify',
        confidence: 0,
        reasoning: 'Lỗi hệ thống khi phân loại intent.',
        params: {
          targetLang: null,
          messageId: null,
          searchQuery: null,
          startDate: null,
          endDate: null,
          startMessageId: null,
          endMessageId: null,
        },
      };
    }
  }

  /**
   * Rewrite an ambiguous user message for better classification
   */
  async rewriteForClarity(text: string, signal?: AbortSignal): Promise<string> {
    this.logger.debug(`Rewriting for clarity: "${text}"`);

    const prompt = `
Bạn là một trợ lý AI giúp làm rõ ý định người dùng.
Người dùng vừa gửi một tin nhắn rất ngắn hoặc mơ hồ: "${text}"

Hãy viết lại tin nhắn này thành một câu đầy đủ, rõ ràng hơn để hệ thống AI khác có thể hiểu được ý định (như hỏi đáp, dịch thuật, tóm tắt). 
Nếu không thể đoán được, hãy cố gắng mở rộng nó một cách logic dựa trên ngữ cảnh ứng dụng chat.

Chỉ trả về nội dung câu đã viết lại, không giải thích thêm.
`;

    try {
      return await this.openai.generateText(prompt, { temperature: 0.3, signal });
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Rewrite for clarity cancelled by user`);
        throw err;
      }
      this.logger.error(`Rewrite for clarity failed: ${err.message}`);
      return text;
    }
  }
}
