import { Injectable, Logger } from '@nestjs/common';
import { OpenAIService } from '../shared/openai.service';
import { RouterOutput, RouterOutputSchema } from './schemas/router-output.schema';

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  private readonly SYSTEM_PROMPT = `
Bạn là một bộ phân loại intent cho ứng dụng chat AI assistant (ai_zalo). 
Phân tích câu hỏi của người dùng và xác định intent phù hợp nhất để hệ thống có thể kích hoạt đúng công cụ.

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
`;

  constructor(private readonly openai: OpenAIService) {}

  /**
   * Classify user intent using GPT-5 Nano structured output
   */
  async classify(text: string, context?: { conversationId?: string }): Promise<RouterOutput> {
    this.logger.debug(`Classifying intent for: "${text}"`);
    
    const prompt = `
Dưới đây là câu hỏi của người dùng:
"${text}"

Hãy phân loại intent và trích xuất các tham số cần thiết.
${context?.conversationId ? `Conversation ID: ${context.conversationId}` : ''}
`;

    try {
      const result = await this.openai.structured(
        this.SYSTEM_PROMPT + prompt,
        RouterOutputSchema,
        'router_output'
      );

      this.logger.log(`Intent classified: ${result.intent} (Confidence: ${result.confidence})`);
      return result;
    } catch (err: any) {
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
        },
      };
    }
  }

  /**
   * Rewrite an ambiguous user message for better classification
   */
  async rewriteForClarity(text: string): Promise<string> {
    this.logger.debug(`Rewriting for clarity: "${text}"`);

    const prompt = `
Bạn là một trợ lý AI giúp làm rõ ý định người dùng.
Người dùng vừa gửi một tin nhắn rất ngắn hoặc mơ hồ: "${text}"

Hãy viết lại tin nhắn này thành một câu đầy đủ, rõ ràng hơn để hệ thống AI khác có thể hiểu được ý định (như hỏi đáp, dịch thuật, tóm tắt). 
Nếu không thể đoán được, hãy cố gắng mở rộng nó một cách logic dựa trên ngữ cảnh ứng dụng chat.

Chỉ trả về nội dung câu đã viết lại, không giải thích thêm.
`;

    try {
      return await this.openai.chat([{ role: 'user', content: prompt }], { temperature: 0.3 });
    } catch (err: any) {
      this.logger.error(`Rewrite for clarity failed: ${err.message}`);
      return text;
    }
  }
}
