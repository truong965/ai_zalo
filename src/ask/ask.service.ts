import { Injectable, Logger, Inject } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../shared/qdrant.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { SummaryService } from '../summary/summary.service';

type AskMessage = {
  id: string;
  content: string;
  senderName: string;
  createdAt: string;
};

type RetrievalPlan = {
  recentLimit: number;
  qdrantLimit: number;
  maxRewriteQueries: number;
};

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);
  private readonly SESSION_TTL = 1800; // 30 mins
  private readonly CACHE_TTL = 300; // 5 mins (Answer cache)
  private readonly PASS_1_PLAN: RetrievalPlan = { recentLimit: 20, qdrantLimit: 10, maxRewriteQueries: 0 };
  private readonly PASS_2_PLAN: RetrievalPlan = { recentLimit: 60, qdrantLimit: 20, maxRewriteQueries: 2 };

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly qdrantService: QdrantService,
    private readonly geminiService: GeminiService,
    private readonly internalClient: InternalClientService,
    private readonly summaryService: SummaryService,
  ) {}

  async ask(conversationId: string, userId: string, question: string, isStreaming = false) {
    if (!question || question.trim().length < 3) {
      return {
        answer: "Câu hỏi quá ngắn. Vui lòng nhập ít nhất 3 ký tự.",
        sources: []
      };
    }

    this.logger.log(`Answering question for conversation ${conversationId}: "${question}"`);
    
    try {
      // 0. Check Answer Cache
      const hashedQuestion = crypto.createHash('sha256').update(question.trim().toLowerCase()).digest('hex');
      const cacheKey = `ask:cache:${conversationId}:${hashedQuestion}`;
      
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.logger.debug(`Answer cache hit for conversation ${conversationId}`);
          return JSON.parse(cached);
        }
      } catch (e) {
        this.logger.warn(`Redis cache fetch failed: ${e.message}`);
      }

      // 0.1 Fetch user session memory (Multi-turn context)
      const sessionKey = `ask_session:${userId || 'anonymous'}:${conversationId}`;
      let history: { q: string, a: string }[] = [];
      try {
        const rawHistory = await this.redis.get(sessionKey);
        if (rawHistory) history = JSON.parse(rawHistory);
      } catch (e) {
        this.logger.warn(`Redis session fetch failed: ${e.message}`);
      }

      const isSummaryIntent = this.detectSummaryIntent(question);

      // 1) Pass 1 retrieval
      const pass1Context = await this.retrieveContext(conversationId, userId, question, this.PASS_1_PLAN);
      if (pass1Context.length === 0) {
        return {
          answer: "Tôi không tìm thấy tin nhắn nào liên quan đến câu hỏi này trong lịch sử chat.",
          sources: []
        };
      }

      // 2) Build prompt and generate answer
      let historyString = '';
      if (history.length > 0) {
        historyString = `\nLịch sử trò chuyện gần đây của bạn với người dùng:\n` + 
          history.map(h => `User: ${h.q}\nAssistant: ${h.a}`).join('\n') + `\n`;
      }

      let contextMessages = pass1Context;
      let prompt = this.buildAskPrompt(question, historyString, contextMessages);
      let answer = '';

      if (isStreaming) {
        answer = await this.streamAnswer(prompt, conversationId);
      } else {
        answer = await this.geminiService.generateText(prompt);
      }

      // 3) If answer seems weak/insufficient, do a broader retrieval and try again.
      if (!isStreaming && this.isInsufficientAnswer(answer)) {
        this.logger.warn(`Pass 1 answer may be insufficient. Retrying with broader context for conversation ${conversationId}`);
        const pass2Context = await this.retrieveContext(conversationId, userId, question, this.PASS_2_PLAN);
        if (pass2Context.length > 0) {
          contextMessages = pass2Context;
          prompt = this.buildAskPrompt(question, historyString, contextMessages);
          answer = await this.geminiService.generateText(prompt);
        }
      }

      // 4) Tool fallback: if user likely asks for summary and answer is still weak, route to Summary tool.
      if (!isStreaming && isSummaryIntent && this.isInsufficientAnswer(answer)) {
        this.logger.warn(`Routing ask -> summary fallback for conversation ${conversationId}`);
        const summary = await this.summaryService.summarize(conversationId);
        answer = summary.summary;
      }

      // 5. Save to Redis Session
      history.push({ q: question, a: answer });
      if (history.length > 3) history = history.slice(-3); // Keep last 3 turns
      this.redis.set(sessionKey, JSON.stringify(history), 'EX', this.SESSION_TTL).catch(err => 
        this.logger.warn(`Failed to save session memory: ${err.message}`)
      );

      // 6. Return answer and top sources for reference
      const sourceMessages = contextMessages.slice(-5);

      const sources = sourceMessages.map(m => ({
        messageId: m.id,
        username: m.senderName,
        text: m.content,
        createdAt: m.createdAt
      }));

      const result = { answer, sources };

      // 7. Cache the final answer (Async, don't block)
      this.redis.set(cacheKey, JSON.stringify(result), 'EX', this.CACHE_TTL).catch(err =>
        this.logger.warn(`Failed to save answer cache: ${err.message}`)
      );

      return result;

    } catch (err: any) {
      this.logger.error(`Failed to process ask query: ${err.message}`);
      throw err;
    }
  }

  private buildAskPrompt(question: string, historyString: string, contextMessages: AskMessage[]): string {
    const contextString = contextMessages
      .map(m => `[${m.senderName}] lúc ${new Date(m.createdAt).toLocaleString('vi-VN')}: ${m.content}`)
      .join('\n');

    return `Bạn là một trợ lý AI thông minh phụ trách phân tích lịch sử nhóm chat.
Dưới đây là các tin nhắn được trích xuất từ lịch sử hội thoại.
Nếu thông tin trong ngữ cảnh KHÔNG liên quan đến câu hỏi, hãy mạnh dạn trả lời rằng bạn không tìm thấy thông tin phù hợp. Tuyệt đối không bịa đặt.
Nếu tìm thấy câu trả lời, hãy trích dẫn tên người dùng và thời gian khi nhắc đến luận điểm của họ.${historyString}

== NGỮ CẢNH CHAT ==
<context>
${contextString}
</context>

== CÂU HỎI ==
${question}

Trả lời:`;
  }

  private async streamAnswer(prompt: string, conversationId: string): Promise<string> {
    this.logger.debug(`Starting stream for conversation ${conversationId}`);
    this.redis.publish(`bot-stream:${conversationId}`, JSON.stringify({ event: 'start' })).catch(err => 
      this.logger.warn(`Redis publish failed: ${err.message}`)
    );

    let answer = '';
    const stream = this.geminiService.streamText(prompt);
    for await (const chunk of stream) {
      answer += chunk;
      this.redis.publish(`bot-stream:${conversationId}`, JSON.stringify({ event: 'chunk', text: chunk })).catch(err => 
        this.logger.warn(`Redis stream publish failed: ${err.message}`)
      );
    }

    this.redis.publish(`bot-stream:${conversationId}`, JSON.stringify({ event: 'done' })).catch(err => 
      this.logger.warn(`Redis publish failed: ${err.message}`)
    );

    return answer;
  }

  private async retrieveContext(
    conversationId: string,
    userId: string,
    question: string,
    plan: RetrievalPlan,
  ): Promise<AskMessage[]> {
    const queries = [question, ...(await this.rewriteQueries(question, plan.maxRewriteQueries))];
    const mergedMap = new Map<string, AskMessage>();

    const recentMessagesRaw = await this.internalClient.getMessages({
      conversationId,
      limit: plan.recentLimit,
      sort: 'desc',
      userId,
    });
    const recentMessages = ((recentMessagesRaw as any[]) || []).reverse();

    for (const m of recentMessages) {
      const normalized = this.normalizeRawMessage(m);
      if (normalized) mergedMap.set(normalized.id, normalized);
    }

    for (const q of queries) {
      try {
        const queryVector = await this.geminiService.embed(q, TaskType.RETRIEVAL_QUERY);
        const searchResults = await this.qdrantService.search(queryVector, {
          conversationId,
          limit: plan.qdrantLimit,
        });

        for (const hit of (searchResults || [])) {
          const normalized = this.normalizeQdrantHit(hit);
          if (normalized) mergedMap.set(normalized.id, normalized);
        }
      } catch (err: any) {
        this.logger.warn(`Context retrieval failed for query "${q}": ${err.message}`);
      }
    }

    return Array.from(mergedMap.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  private async rewriteQueries(question: string, maxRewriteQueries: number): Promise<string[]> {
    if (!maxRewriteQueries || maxRewriteQueries <= 0) return [];

    try {
      const prompt = `Bạn là bộ tạo truy vấn cho semantic search.
Từ câu hỏi sau, hãy tạo tối đa ${maxRewriteQueries} truy vấn thay thế ngắn gọn để tăng recall.
Chỉ trả về từng dòng là một truy vấn, không đánh số, không giải thích.

Câu hỏi gốc: ${question}`;

      const rewritten = await this.geminiService.generateText(prompt, { temperature: 0.2, maxTokens: 120 });
      return rewritten
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => s.length > 4)
        .slice(0, maxRewriteQueries);
    } catch (err: any) {
      this.logger.warn(`Query rewrite failed: ${err.message}`);
      return [];
    }
  }

  private normalizeRawMessage(m: any): AskMessage | null {
    const id = m?.id?.toString?.() || m?.messageId?.toString?.();
    const content = m?.content || m?.text;
    if (!id || !content) return null;

    return {
      id,
      content,
      senderName: m?.sender?.displayName || m?.userId || m?.senderId || 'User',
      createdAt: m?.createdAt || new Date().toISOString(),
    };
  }

  private normalizeQdrantHit(hit: any): AskMessage | null {
    const id = hit?.id?.toString?.();
    const content = hit?.payload?.text || hit?.payload?.originalText;
    if (!id || !content) return null;

    return {
      id,
      content,
      senderName: hit?.payload?.senderName || 'User',
      createdAt: hit?.payload?.createdAt || new Date().toISOString(),
    };
  }

  private detectSummaryIntent(question: string): boolean {
    return /(tóm tắt|summary|ý chính|key point|điểm chính|kết luận|tổng hợp)/i.test(question);
  }

  private isInsufficientAnswer(answer: string): boolean {
    const normalized = (answer || '').trim();
    if (!normalized) return true;
    if (normalized.length < 40) return true;

    return /(không tìm thấy|không đủ thông tin|không có dữ liệu|không rõ|không xác định|khó xác định)/i.test(normalized);
  }
}
