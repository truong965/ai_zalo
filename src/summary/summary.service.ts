import { Injectable, Logger, Inject } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import Redis from 'ioredis';

export interface SummaryResult {
  summary: string;
  messageCount: number;
  fromTimestamp: string;
  fromCache: boolean;
}

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);
  private readonly CACHE_TTL = 1800; // 30 minutes
  private readonly DEFAULT_MESSAGE_COUNT = 50;

  constructor(
    private readonly geminiService: GeminiService,
    private readonly internalClient: InternalClientService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async summarize(conversationId: string, userId: string): Promise<SummaryResult> {
    const cacheKey = this.buildCacheKey(conversationId);
    
    // 1. Check cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.debug(`Summary cache hit for conversation ${conversationId}`);
        return { ...JSON.parse(cached), fromCache: true };
      }
    } catch (err: any) {
      this.logger.warn(`Redis cache check failed: ${err.message}`);
    }

    // 2. Fetch messages from Zalo Backend
    this.logger.log(`Fetching messages to summarize conversation: ${conversationId}`);
    const messages = await this.internalClient.getMessages({
      conversationId,
      limit: this.DEFAULT_MESSAGE_COUNT,
      userId, // Mandatory for security
    });

    if (!messages || messages.length === 0) {
      return {
        summary: 'Chưa có đủ tin nhắn trong cuộc trò chuyện này để thực hiện tóm tắt.',
        messageCount: 0,
        fromTimestamp: new Date().toISOString(),
        fromCache: false,
      };
    }

    // 3. Build conversation text
    let conversationText = messages
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((m: any) => {
        const time = new Date(m.createdAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        // Use userId if username is not available
        return `[${m.sender?.displayName || m.userId || m.senderId} ${time}]: ${m.content || m.text}`;
      })
      .join('\n');

    // 4. Truncate if too long (max ~50000 chars for Gemini context window safely)
    if (conversationText.length > 50000) {
      this.logger.warn(`Conversation text truncated for ${conversationId} (length: ${conversationText.length})`);
      conversationText = conversationText.substring(conversationText.length - 50000);
    }

    // 5. Generate summary via Gemini
    const prompt = `Bạn là một trợ lý ảo thông minh. Hãy tóm tắt nội dung chính của cuộc trò chuyện sau đây.
Yêu cầu kết quả trả về bằng Tiếng Việt, trình bày dưới dạng:
1. **Chủ Đề Chính**: (1-2 câu)
2. **Các Điểm Quan Trọng**: (danh sách gạch đầu dòng, tối đa 5 điểm)
3. **Quyết Định/Hành Động**: (nếu có)

Nội dung hội thoại:
<context>
${conversationText}
</context>`;

    try {
      const summary = await this.geminiService.generateText(prompt);

      const result: SummaryResult = {
        summary,
        messageCount: messages.length,
        fromTimestamp: messages[0].createdAt,
        fromCache: false,
      };

      // 5. Cache result
      await this.redis.setex(cacheKey, this.CACHE_TTL, JSON.stringify(result));

      return result;
    } catch (err: any) {
      this.logger.error(`Gemini summary generation failed: ${err.message}`);
      throw err;
    }
  }

  private buildCacheKey(conversationId: string): string {
    const now = new Date();
    // Group by 30-minute buckets for better cache efficiency
    const bucket = Math.floor(now.getMinutes() / 30);
    // Format: YYYYMMDDHH + bucket (0 or 1)
    const timeRef = now.toISOString().substring(0, 13).replace(/[-T]/g, '') + bucket;
    return `summary:${conversationId}:${timeRef}`;
  }
}
