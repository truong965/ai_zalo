import { Injectable, Logger, Inject } from '@nestjs/common';
import { InternalClientService } from '../internal-client/internal-client.service';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { SummaryService } from '../summary/summary.service';
import { AiFeatureType } from '../../prisma/generated/client';
import { SessionCacheService } from '../sessions/session-cache.service';
import { AIUnifiedResponseEvents } from '../shared/contracts/unified-stream.contract';
import { RetrieverService, AskMessage } from './retriever.service';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { AbortUtils } from '../shared/abort.utils';

type StreamAnswerResult = {
  answer: string;
  interrupted: boolean;
  errorMessage?: string;
};

type AskStaleState = {
  stale: boolean;
  newMessageCount: number;
};

@Injectable()
export class AskService {
  private readonly logger = new Logger(AskService.name);
  private readonly CACHE_TTL = 300; // 5 mins (Answer cache)

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly internalClient: InternalClientService,
    private readonly summaryService: SummaryService,
    private readonly sessionCache: SessionCacheService,
    private readonly retrieverService: RetrieverService,
    private readonly llmGateway: LlmGatewayService,
  ) { }

  async ask(
    conversationId: string,
    userId: string,
    question: string,
    isStreaming = false,
    requestId?: string,
    emitUnifiedEvents = true,
    signal?: AbortSignal,
  ) {
    if (!question || question.trim().length < 3) {
      const content = 'Câu hỏi quá ngắn. Vui lòng nhập ít nhất 3 ký tự.';
      const unifiedBase = this.internalClient.createUnifiedBasePayload({
        requestId,
        conversationId,
        type: 'ask',
      });

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.STARTED,
          payload: { ...unifiedBase, message: 'Started processing ask request' },
        });

        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.COMPLETED,
          payload: { ...unifiedBase, content },
        });
      }

      return { answer: content, sources: [] };
    }

    this.logger.log(`Answering question for conversation ${conversationId}: "${question}"`);

    try {
      const hasAccess = await this.internalClient.validateAccess(conversationId, userId);
      if (!hasAccess) {
        throw new Error('User does not have access to this conversation');
      }

      const session = await this.ensureAskSession(conversationId, userId);
      const unifiedBase = this.internalClient.createUnifiedBasePayload({
        requestId,
        conversationId,
        type: 'ask',
        sessionId: session.id,
      });

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.STARTED,
          payload: { ...unifiedBase, message: 'Started processing ask request' },
        });
      }

      const historyString = await this.buildHistoryStringFromDb(session.id);
      const staleState = await this.getAskStaleState(
        conversationId,
        userId,
        session.lastMessageIdSynced,
      );

      await this.sessionCache.addSessionMessage(session.id, 'user', question, {
        requestType: 'ask',
        streaming: isStreaming,
      });

      // 0. Check Answer Cache
      const hashedQuestion = crypto.createHash('sha256').update(question.trim().toLowerCase()).digest('hex');
      const cacheKey = `ask:cache:${conversationId}:${hashedQuestion}`;

      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.logger.debug(`Answer cache hit for conversation ${conversationId}`);
          const cachedResult = JSON.parse(cached);
          await this.sessionCache.addSessionMessage(
            session.id,
            'assistant',
            cachedResult.answer,
            { fromCache: true, sourceCount: cachedResult.sources?.length ?? 0 },
          );
          await this.syncLatestConversationMarker(session.id, conversationId, userId);

          if (emitUnifiedEvents) {
            await this.internalClient.notifyUnifiedResponse({
              conversationId,
              userId,
              event: AIUnifiedResponseEvents.COMPLETED,
              payload: { ...unifiedBase, content: cachedResult.answer },
            });
          }

          return { ...cachedResult, sessionId: session.id, fromCache: true, ...staleState };
        }
      } catch (e: any) {
        this.logger.warn(`Redis cache fetch failed: ${e?.message || 'unknown error'}`);
      }

      const isSummaryIntent = this.detectSummaryIntent(question);

      // 1) Pass 1 retrieval
      const pass1Context = await this.retrieverService.retrieveContext(
        conversationId,
        userId,
        question,
        this.retrieverService.PASS_1_PLAN,
      );
      if (pass1Context.length === 0) {
        const content = "Tôi không tìm thấy tin nhắn nào liên quan đến câu hỏi này trong lịch sử chat.";

        if (emitUnifiedEvents) {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.COMPLETED,
            payload: { ...unifiedBase, content },
          });
        }

        return { answer: content, sources: [], ...staleState };
      }

      // 2) Build prompt and generate answer
      let contextMessages = pass1Context;
      let prompt = this.buildAskPrompt(question, historyString, contextMessages);
      let answer = '';
      let streamInterrupted = false;
      let streamingFallback = false;
      let streamErrorMessage: string | undefined;

      if (isStreaming) {
        const streamResult = await this.streamAnswer(
          prompt,
          conversationId,
          userId,
          unifiedBase,
          emitUnifiedEvents,
          signal,
        );
        answer = streamResult.answer;
        streamInterrupted = streamResult.interrupted;
        streamErrorMessage = streamResult.errorMessage;

        if (streamInterrupted && !answer.trim()) {
          this.logger.warn(
            `Streaming interrupted with empty output for conversation ${conversationId}. Falling back to non-stream generation.`,
          );
          streamingFallback = true;
          try {
            answer = await this.llmGateway.generateText(prompt, { signal });
          } catch (fallbackError: any) {
            this.logger.error(
              `Fallback generation failed after stream interruption for conversation ${conversationId}: ${fallbackError.message}`,
            );
            answer = 'Xin loi, qua trinh tra loi bi gian doan. Vui long thu lai sau.';
          }
        }
      } else {
        answer = await this.llmGateway.generateText(prompt, { signal });
      }

      // 3) If answer seems weak/insufficient, do a broader retrieval and try again.
      if (!isStreaming && this.isInsufficientAnswer(answer)) {
        if (signal?.aborted) throw new Error('AI Request Cancelled');
        
        this.logger.warn(`Pass 1 answer may be insufficient. Retrying with broader context for conversation ${conversationId}`);
        
        if (emitUnifiedEvents) {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.THOUGHT,
            payload: {
              ...unifiedBase,
              thoughtDelta: `Câu trả lời chưa đủ chi tiết, tôi đang tìm kiếm thêm thông tin mở rộng...\n`,
            },
          });
        }

        const pass2Context = await this.retrieverService.retrieveContext(conversationId, userId, question, this.retrieverService.PASS_2_PLAN);
        if (pass2Context.length > 0) {
          contextMessages = pass2Context;
          prompt = this.buildAskPrompt(question, historyString, contextMessages);
          answer = await this.llmGateway.generateText(prompt, { signal });
        }
      }

      // 4) Tool fallback: if user likely asks for summary and answer is still weak, route to Summary tool.
      if (!isStreaming && isSummaryIntent && this.isInsufficientAnswer(answer)) {
        this.logger.warn(`Routing ask -> summary fallback for conversation ${conversationId}`);
        const summary = await this.summaryService.summarize(
          conversationId, 
          userId, 
          undefined, 
          undefined, 
          undefined, 
          undefined, 
          requestId, 
          false, 
          true, 
          signal
        );
        answer = summary.summary;
      }

      // 6. Return answer and top sources for reference
      const sourceMessages = contextMessages.slice(-5);

      const sources = sourceMessages.map(m => ({
        messageId: m.id,
        username: m.senderName,
        text: m.content,
        createdAt: m.createdAt
      }));

      const result = {
        answer,
        sources,
        context: contextMessages,
        isCompressed: !!(pass1Context as any).isCompressed,
        sessionId: session.id,
        ...staleState,
      };

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.COMPLETED,
          payload: { ...unifiedBase, content: answer },
        });
      }

      await this.sessionCache.addSessionMessage(session.id, 'assistant', answer, {
        sourceCount: sources.length,
        sourceIds: sources.map((s) => s.messageId),
        compressed: !!(pass1Context as any).isCompressed,
        streaming: isStreaming,
        streamingInterrupted: streamInterrupted,
        streamingFallback,
        streamErrorMessage,
      });

      await this.syncLatestConversationMarker(session.id, conversationId, userId);

      // 7. Cache the final answer (Async, don't block)
      this.redis.set(cacheKey, JSON.stringify({ answer, sources }), 'EX', this.CACHE_TTL).catch(err =>
        this.logger.warn(`Failed to save answer cache: ${err.message}`)
      );

      return result;

    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Ask query cancelled by user for conversation ${conversationId}`);
        throw err;
      }
      this.logger.error(`Failed to process ask query: ${err.message}`);

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.ERROR,
          payload: {
            ...this.internalClient.createUnifiedBasePayload({
              requestId,
              conversationId,
              type: 'ask',
            }),
            code: 'ASK_PROCESSING_FAILED',
            message: err?.message || 'Failed to process ask request',
            retriable: true,
          },
        });
      }

      throw err;
    }
  }

  private buildAskPrompt(question: string, historyString: string, context: AskMessage[] | string): string {
    let contextString = '';

    if (typeof context === 'string') {
      contextString = context;
    } else {
      if ((context as any).isCompressed && (context as any).compressedText) {
        contextString = (context as any).compressedText;
      } else {
        contextString = context
          .map(m => `[${m.senderName}] lúc ${new Date(m.createdAt).toLocaleString('vi-VN')}: ${m.content}`)
          .join('\n');
      }
    }

    return `Bạn là một trợ lý AI thông minh phụ trách phân tích lịch sử nhóm chat. 
Ngày hiện tại là: ${new Date().toLocaleString('vi-VN')}.
Dưới đây là các dữ liệu được trích xuất từ lịch sử hội thoại.

QUY TRÌNH TRẢ LỜI:
1. Hãy trả lời trực tiếp vào câu hỏi dựa trên dữ liệu ngữ cảnh được cung cấp.
2. Khi nhắc đến người nhắn tin, hãy sử dụng chính Tên Hiển Thị của họ từ TRONG NGỮ CẢNH (VD: nếu ngữ cảnh có "[Trương] nói...", thì gọi là "Trương", KHÔNG gọi bằng các mã ID).
3. Nếu thông vị trong ngữ cảnh KHÔNG liên quan đến câu hỏi, hoặc ngữ cảnh trống, bạn PHẢI trả lời chính xác câu này: "Tôi không tìm thấy thông tin liên quan trong lịch sử chat." Tuyệt đối không suy luận, phỏng đoán hoặc bịa đặt ngoài ngữ cảnh.
4. Trình bày câu trả lời ngắn gọn, tự nhiên, trực tiếp.
5. Không mở đầu bằng lời chào như "Chào bạn", "Xin chào". Không viết văn phong trang trọng nếu không cần thiết.${historyString}
== NGỮ CẢNH CHAT ==
<context>
${contextString}
</context>
== CÂU HỎI ==
${question}
Trả lời:`;
  }

  private async streamAnswer(
    prompt: string,
    conversationId: string,
    userId: string,
    unifiedBase: ReturnType<InternalClientService['createUnifiedBasePayload']>,
    emitUnifiedEvents = true,
    signal?: AbortSignal,
  ): Promise<StreamAnswerResult> {
    this.logger.debug(`Starting stream for conversation ${conversationId}`);
    this.redis.publish(`bot-stream:${conversationId}`, JSON.stringify({ event: 'start' })).catch(err =>
      this.logger.warn(`Redis publish failed: ${err.message}`)
    );

    let answer = '';
    let interrupted = false;
    let errorMessage: string | undefined;
    try {
      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.PROGRESS,
          payload: { ...unifiedBase, step: 'generate', message: 'Đang tạo câu trả lời...' },
        });
      }

      const stream = this.llmGateway.streamTextWithThinking(prompt, { signal });
      for await (const chunk of stream) {
        if (chunk.type === 'thought') {
          if (emitUnifiedEvents) {
            await this.internalClient.notifyUnifiedResponse({
              conversationId,
              userId,
              event: AIUnifiedResponseEvents.THOUGHT,
              payload: { ...unifiedBase, thoughtDelta: chunk.text },
            });
          }
        } else {
          answer += chunk.text;
          if (emitUnifiedEvents) {
            await this.internalClient.notifyUnifiedResponse({
              conversationId,
              userId,
              event: AIUnifiedResponseEvents.DELTA,
              payload: { ...unifiedBase, contentDelta: chunk.text },
            });
          }
        }
      }
    } catch (error: any) {
      interrupted = true;
      errorMessage = error?.message ?? 'Unknown stream error';
      this.logger.warn(`Stream interrupted for conversation ${conversationId}: ${errorMessage}`);
      this.redis.publish(
        `bot-stream:${conversationId}`,
        JSON.stringify({ event: 'error', message: errorMessage }),
      ).catch(err => this.logger.warn(`Redis publish failed: ${err.message}`));
    }

    this.redis.publish(
      `bot-stream:${conversationId}`,
      JSON.stringify({ event: 'done', interrupted }),
    ).catch(err => this.logger.warn(`Redis publish failed: ${err.message}`));

    return { answer, interrupted, errorMessage };
  }

  /**
   * Public wrapper for generation logic (for AgentGraph)
   */
  async generateAnswer(params: {
    question: string;
    context: AskMessage[] | string;
    userId?: string;
    conversationId?: string;
  }): Promise<string> {
    let historyString = '';
    if (params.userId && params.conversationId) {
      try {
        const session = await this.sessionCache.findActiveSession(
          params.userId,
          params.conversationId,
          AiFeatureType.ASK,
        );
        if (session) {
          historyString = await this.buildHistoryStringFromDb(session.id);
        }
      } catch (e: any) {
        this.logger.warn(`DB history fetch failed: ${e?.message || 'unknown error'}`);
      }
    }

    const prompt = this.buildAskPrompt(params.question, historyString, params.context);
    return this.llmGateway.generateText(prompt);
  }

  private detectSummaryIntent(question: string): boolean {
    return /(tóm tắt|summary|ý chính|key point|điểm chính|kết luận|tổng hợp)/i.test(question);
  }

  private async ensureAskSession(conversationId: string, userId: string) {
    const conversationInfo = await this.internalClient.getConversationInfo(conversationId).catch(() => undefined);
    return this.sessionCache.getOrCreateActiveAskSession({
      userId,
      conversationId,
      title: `Ask Session ${new Date().toISOString()}`,
      contextSnapshot: {
        conversationTitle: conversationInfo?.title,
        conversationType: conversationInfo?.type,
        participantCount: conversationInfo?.members?.length,
      },
    });
  }

  private async getAskStaleState(
    conversationId: string,
    userId: string,
    lastMessageIdSynced?: string | null,
  ): Promise<AskStaleState> {
    if (!lastMessageIdSynced) return { stale: false, newMessageCount: 0 };

    try {
      const response = await this.internalClient.countMessages({
        conversationId,
        userId,
        after: lastMessageIdSynced,
      });

      const newMessageCount = response?.count || 0;
      return { stale: newMessageCount > 0, newMessageCount };
    } catch (error: any) {
      this.logger.warn(`Failed to compute ASK stale state: ${error.message}`);
      return { stale: false, newMessageCount: 0 };
    }
  }

  private async buildHistoryStringFromDb(sessionId: string): Promise<string> {
    const messages = await this.sessionCache.getSessionMessages(sessionId, 10);
    if (!messages.length) return '';

    const pairs: string[] = [];
    let pendingQuestion = '';
    for (const message of messages) {
      if (message.role === 'user') {
        pendingQuestion = message.content;
      }
      if (message.role === 'assistant' && pendingQuestion) {
        pairs.push(`User: ${pendingQuestion}\nAssistant: ${message.content}`);
        pendingQuestion = '';
      }
    }

    if (!pairs.length) return '';
    return `\nLịch sử trò chuyện gần đây của bạn với người dùng:\n${pairs.slice(-3).join('\n')}\n`;
  }

  private async syncLatestConversationMarker(sessionId: string, conversationId: string, userId: string) {
    try {
      const latest = await this.internalClient.getMessages({
        conversationId,
        userId,
        limit: 1,
        sort: 'desc',
      });
      const latestMessageId = latest?.[0]?.id;
      if (latestMessageId) {
        await this.sessionCache.updateSessionSyncMarker(sessionId, String(latestMessageId));
      }
    } catch (error: any) {
      this.logger.warn(`Failed to sync latest message marker: ${error.message}`);
    }
  }

  private isInsufficientAnswer(answer: string): boolean {
    const normalized = (answer || '').trim();
    if (!normalized) return true;
    if (normalized.length < 40) return true;

    return /(không tìm thấy|không đủ thông tin|không có dữ liệu|không rõ|không xác định|khó xác định)/i.test(normalized);
  }

  private async publishToRedis(conversationId: string, event: string, text?: string, data?: any) {
    try {
      await this.redis.publish(
        `bot-stream:${conversationId}`,
        JSON.stringify({ event, text, ...data }),
      );
    } catch (err: any) {
      this.logger.warn(`Redis publish failed: ${err.message}`);
    }
  }
}
