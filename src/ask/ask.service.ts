import { Injectable, Logger, Inject } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { ConfigService } from '@nestjs/config';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../shared/qdrant.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { SummaryService } from '../summary/summary.service';
import { RerankerService } from '../shared/reranker.service';
import { ContextCompressorService } from '../shared/context-compressor.service';
import { AiFeatureType } from '../../prisma/generated/client';
import { SessionCacheService } from '../sessions/session-cache.service';
import { AIUnifiedResponseEvents } from '../shared/contracts/unified-stream.contract';

export type AskMessage = {
  id: string;
  content: string;
  senderName: string;
  createdAt: string;
  windowText?: string;
  relevanceScore?: number;
};

export type RetrievalPlan = {
  recentLimit: number;
  qdrantLimit: number;
  maxRewriteQueries: number;
  rerankTopN?: number;
};

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
  public readonly PASS_1_PLAN: RetrievalPlan = { recentLimit: 20, qdrantLimit: 10, maxRewriteQueries: 0, rerankTopN: 5 };
  public readonly PASS_2_PLAN: RetrievalPlan = { recentLimit: 60, qdrantLimit: 20, maxRewriteQueries: 2, rerankTopN: 15 };

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly qdrantService: QdrantService,
    private readonly geminiService: GeminiService,
    private readonly internalClient: InternalClientService,
    private readonly summaryService: SummaryService,
    private readonly rerankerService: RerankerService,
    private readonly compressorService: ContextCompressorService,
    private readonly configService: ConfigService,
    private readonly sessionCache: SessionCacheService,
  ) { }

  async ask(
    conversationId: string,
    userId: string,
    question: string,
    isStreaming = false,
    requestId?: string,
    emitUnifiedEvents = true,
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
          payload: {
            ...unifiedBase,
            message: 'Started processing ask request',
          },
        });

        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.COMPLETED,
          payload: {
            ...unifiedBase,
            content,
          },
        });
      }

      return {
        answer: content,
        sources: []
      };
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
          payload: {
            ...unifiedBase,
            message: 'Started processing ask request',
          },
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
              payload: {
                ...unifiedBase,
                content: cachedResult.answer,
              },
            });
          }

          return {
            ...cachedResult,
            sessionId: session.id,
            fromCache: true,
            ...staleState,
          };
        }
      } catch (e: any) {
        this.logger.warn(`Redis cache fetch failed: ${e?.message || 'unknown error'}`);
      }

      const isSummaryIntent = this.detectSummaryIntent(question);

      // 1) Pass 1 retrieval
      const pass1Context = await this.retrieveContext(conversationId, userId, question, this.PASS_1_PLAN);
      if (pass1Context.length === 0) {
        const content = "Tôi không tìm thấy tin nhắn nào liên quan đến câu hỏi này trong lịch sử chat.";

        if (emitUnifiedEvents) {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.COMPLETED,
            payload: {
              ...unifiedBase,
              content,
            },
          });
        }

        return {
          answer: content,
          sources: [],
          ...staleState,
        };
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
          {
            ...unifiedBase,
          },
          emitUnifiedEvents,
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
            answer = await this.geminiService.generateText(prompt);
          } catch (fallbackError: any) {
            this.logger.error(
              `Fallback generation failed after stream interruption for conversation ${conversationId}: ${fallbackError.message}`,
            );
            answer = 'Xin loi, qua trinh tra loi bi gian doan. Vui long thu lai sau.';
          }
        }
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
        const summary = await this.summaryService.summarize(conversationId, userId);
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
          payload: {
            ...unifiedBase,
            content: answer,
          },
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
      // Use compressed text if available from retrieveContext
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
2. Khi nhắc đến người nhắn tin, hãy sử dụng chính Tên Hiển Thị của họ từ TRONG NGỮCẢNH (VD: nếu ngữ cảnh có "[Trương] nói...", thì gọi là "Trương", KHÔNG gọi bằng các mã ID).
3. Nếu thông tin trong ngữ cảnh KHÔNG liên quan đến câu hỏi, hãy lịch sự trả lời rằng bạn không tìm thấy thông tin phù hợp trong lịch sử chat. Tuyệt đối không bịa đặt thông tin.
  4. Trình bày câu trả lời ngắn gọn, tự nhiên, trực tiếp.
  5. Không mở đầu bằng lời chào như "Chào bạn", "Xin chào" hoặc các câu xã giao tương tự. Không viết văn phong trang trọng nếu không cần thiết.${historyString}
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
  ): Promise<StreamAnswerResult> {
    this.logger.debug(`Starting stream for conversation ${conversationId}`);
    this.redis.publish(`bot-stream:${conversationId}`, JSON.stringify({ event: 'start' })).catch(err =>
      this.logger.warn(`Redis publish failed: ${err.message}`)
    );

    let answer = '';
    let interrupted = false;
    let errorMessage: string | undefined;
    try {
      const stream = this.geminiService.streamText(prompt);
      for await (let chunk of stream) {
        if (!chunk || typeof chunk !== 'string') continue;

        this.logger.debug(`[RAW CHUNK]: ${chunk}`);

        // Normal chunk parsing
        if (chunk.includes("<thought>")) {
          chunk = chunk.replace("<thought>", "");
        }
        if (chunk.includes("</thought>")) {
          chunk = chunk.replace("</thought>", "");
        }

        // Normal content
        answer += chunk;
        await this.publishToRedis(conversationId, 'chunk', chunk);

        if (emitUnifiedEvents) {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.DELTA,
            payload: { ...unifiedBase, contentDelta: chunk },
          });
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

    return {
      answer,
      interrupted,
      errorMessage,
    };
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
    // 1. Build session history string from DB if available
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
    return this.geminiService.generateText(prompt);
  }

  /**
   * Public wrapper for context retrieval (for AgentGraph)
   */
  public async retrieveContextPublic(
    conversationId: string,
    userId: string,
    question: string,
    plan?: RetrievalPlan,
  ): Promise<AskMessage[]> {
    return this.retrieveContext(conversationId, userId, question, plan || this.PASS_1_PLAN);
  }

  public async retrieveOnly(
    conversationId: string,
    userId: string,
    question: string,
    startDate?: string,
    endDate?: string,
  ): Promise<AskMessage[]> {
    return this.retrieveContext(conversationId, userId, question, this.PASS_1_PLAN, startDate, endDate);
  }

  private async retrieveContext(
    conversationId: string,
    userId: string,
    question: string,
    plan: RetrievalPlan,
    startDate?: string,
    endDate?: string,
  ): Promise<AskMessage[]> {
    const { queries, startDate: extractedStart, endDate: extractedEnd } = await this.rewriteQueries(question, plan.maxRewriteQueries);

    // Ưu tiên thời gian truyền vào trực tiếp, nếu không có thì dùng thời gian trích xuất được
    const finalStart = startDate || extractedStart;
    const finalEnd = endDate || extractedEnd;

    this.logger.debug(`[retrieveContext] Query: "${question}", Queries: ${queries.length}, FinalStart: ${finalStart}, FinalEnd: ${finalEnd}`);

    const mergedMap = new Map<string, AskMessage>();

    // Step 1: Fetch recent messages (Fixed window context)
    const recentMessagesRaw = await this.internalClient.getMessages({
      conversationId,
      limit: plan.recentLimit,
      sort: 'desc',
      userId,
      startDate: finalStart,
      endDate: finalEnd,
    });
    const recentMessages = ((recentMessagesRaw as any[]) || []).reverse();

    this.logger.debug(`[retrieveContext] Fetched ${recentMessages.length} recent messages from ${plan.recentLimit} limit`);

    for (const m of recentMessages) {
      const normalized = this.normalizeRawMessage(m);
      if (normalized) mergedMap.set(normalized.id, normalized);
    }

    // Step 2: Hybrid Search (Dense + Sparse/BM25) with RRF
    for (const q of queries) {
      try {
        const queryVector = await this.geminiService.embed(q, TaskType.RETRIEVAL_QUERY);
        const searchResults = await this.qdrantService.hybridSearch({
          denseVector: queryVector,
          textQuery: q,
          conversationId,
          limit: plan.qdrantLimit,
          startDate: finalStart,
          endDate: finalEnd,
        });

        const points = (searchResults as any).points || searchResults || [];
        for (const hit of points) {
          const normalized = this.normalizeQdrantHit(hit);
          if (normalized) mergedMap.set(normalized.id, normalized);
        }
      } catch (err: any) {
        this.logger.warn(`Hybrid retrieval failed for query "${q}": ${err.message}`);
      }
    }

    const uniqueDocs = Array.from(mergedMap.values());
    if (uniqueDocs.length === 0) return [];

    // Step 2.5: Enrich displayNames for Qdrant results (they only have userId, not displayName)
    const enrichedDocs = await this.enrichDisplayNames(uniqueDocs, conversationId, userId);

    // Step 3: Reranking with Cohere
    const topN = plan.rerankTopN || this.configService.get<number>('RERANK_TOP_N', 5);
    const rerankedRaw = await this.rerankerService.rerank({
      query: question,
      documents: enrichedDocs.map(d => ({ ...d, text: d.windowText || d.content })),
      topN,
    });

    // Map back to AskMessage type to satisfy TS
    const rerankedDocs: AskMessage[] = rerankedRaw.map(r => {
      const original = enrichedDocs.find(d => d.id === r.id);
      return {
        ...original,
        relevanceScore: r.relevanceScore,
      } as AskMessage;
    });

    // Step 4: Context Compression with Gemini
    const compressionThreshold = this.configService.get<number>('CONTEXT_COMPRESSION_THRESHOLD', 1000);
    const totalLength = rerankedDocs.reduce((acc, d) => acc + (d.windowText || d.content).length, 0);

    if (totalLength > compressionThreshold) {
      const compressedText = await this.compressorService.compress({
        question,
        contexts: rerankedDocs.map(d => `[${d.senderName}]: ${d.windowText || d.content}`),
      });

      // Return a special wrapper that buildAskPrompt understands
      const result: any = rerankedDocs;
      result.compressedText = compressedText;
      result.isCompressed = true;
      return result;
    }

    return rerankedDocs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  private parseVietnameseDateFromQuestion(question: string): { startDate?: string; endDate?: string } {
    /**
     * Parse Vietnamese date formats from question string.
     * Handles: "ngày 20/4/2026", "ngày 20/4", etc.
     * Returns ISO format YYYY-MM-DD or undefined if no date found.
     */
    const now = new Date();

    // Pattern 1: "ngày D/M/YYYY" or standalone "D/M/YYYY"
    const fullDateMatch = question.match(/(?:ngày\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (fullDateMatch) {
      const day = fullDateMatch[1];
      const month = fullDateMatch[2];
      const year = fullDateMatch[3];
      try {
        // Construct ISO date directly to avoid timezone conversion issues
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        this.logger.debug(`[LocalDateParser] Parsed full date: ${iso}`);
        return { startDate: iso, endDate: iso };
      } catch (e) {
        this.logger.warn(`[LocalDateParser] Failed to parse full date: ${e}`);
      }
    }

    // Pattern 2: "ngày D/M" (assume current year)
    const monthDayMatch = question.match(/ngày\s+(\d{1,2})\/(\d{1,2})(?!\d)/);
    if (monthDayMatch) {
      const day = monthDayMatch[1];
      const month = monthDayMatch[2];
      try {
        const iso = `${now.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        this.logger.debug(`[LocalDateParser] Parsed month/day: ${iso}`);
        return { startDate: iso, endDate: iso };
      } catch (e) {
        this.logger.warn(`[LocalDateParser] Failed to parse month/day: ${e}`);
      }
    }

    return {};
  }

  private async rewriteQueries(question: string, maxRewriteQueries: number): Promise<{ queries: string[], startDate?: string, endDate?: string }> {
    if (maxRewriteQueries < 0) return { queries: [question] };

    try {
      const now = new Date();
      const prompt = `Bạn là bộ tạo truy vấn và trích xuất thời gian cho semantic search.
Ngày hiện tại là: ${now.toLocaleString('vi-VN')}.

NHIỆM VỤ:
1. Từ câu hỏi dưới đây, hãy tạo tối đa ${maxRewriteQueries || 2} truy vấn thay thế ngắn gọn (Tiếng Việt) để tăng độ phủ tìm kiếm.
2. Nếu câu hỏi có chứa mốc thời gian (VD: "hôm nay", "ngày 21/4", "tuần trước"), hãy trích xuất ra định dạng ISO (YYYY-MM-DD).

ĐỊNH DẠNG TRẢ VỀ (BẮT BUỘC):
QUERIES: <truy vấn 1> | <truy vấn 2>
START_DATE: <YYYY-MM-DD hoặc null>
END_DATE: <YYYY-MM-DD hoặc null>

Câu hỏi gốc: ${question}`;

      const response = await this.geminiService.generateText(prompt, { temperature: 0.1, maxTokens: 250 });
      
      this.logger.debug(`[rewriteQueries] Gemini raw response: ${response.substring(0, 200)}...`);

      const queriesStr = response.match(/QUERIES: (.*)/)?.[1] || '';
      let startDateStr = response.match(/START_DATE: (.*)/)?.[1]?.trim();
      let endDateStr = response.match(/END_DATE: (.*)/)?.[1]?.trim();

      this.logger.debug(`[rewriteQueries] Extracted from Gemini - START: ${startDateStr}, END: ${endDateStr}`);

      // Fallback to local date parser if Gemini extraction failed
      if ((!startDateStr || startDateStr === 'null' || startDateStr === '') && 
          (!endDateStr || endDateStr === 'null' || endDateStr === '')) {
        this.logger.debug(`[rewriteQueries] Gemini extraction inconclusive, falling back to local parser`);
        const localParsed = this.parseVietnameseDateFromQuestion(question);
        if (localParsed.startDate) {
          startDateStr = localParsed.startDate;
          endDateStr = localParsed.endDate || localParsed.startDate;
          this.logger.debug(`[rewriteQueries] Local parser found date: ${startDateStr}`);
        }
      }

      const queries = [
        question,
        ...queriesStr.split('|').map(s => s.trim()).filter(s => s.length > 3)
      ].slice(0, (maxRewriteQueries || 0) + 1);

      return {
        queries,
        startDate: startDateStr && startDateStr !== 'null' && startDateStr.length > 0 ? `${startDateStr}T00:00:00.000Z` : undefined,
        endDate: endDateStr && endDateStr !== 'null' && endDateStr.length > 0 ? `${endDateStr}T23:59:59.999Z` : undefined,
      };
    } catch (err: any) {
      this.logger.warn(`Query rewrite & date extraction failed: ${err.message}`);
      return { queries: [question] };
    }
  }

  /**
   * Enrich displayNames for Qdrant results which only have userId
   * Batch fetch displayNames from zalo_backend database via internal API
   */
  private async enrichDisplayNames(
    docs: AskMessage[],
    conversationId: string,
    userId: string,
  ): Promise<AskMessage[]> {
    // Identify docs that need displayName enrichment
    // (senderName looks like UUID, not a proper display name)
    const docsNeedingEnrich = docs.filter(d => {
      const name = d.senderName || '';
      // Check if senderName is a UUID (32+ hex chars, looks like ID)
      return /^[a-f0-9\-]{20,}$/i.test(name);
    });

    if (docsNeedingEnrich.length === 0) {
      this.logger.debug(`[enrichDisplayNames] All docs already have displayNames`);
      return docs;
    }

    this.logger.debug(`[enrichDisplayNames] Enriching ${docsNeedingEnrich.length} docs from backend`);

    try {
      const userIdsToFetch = [...new Set(docsNeedingEnrich.map(d => d.senderName).filter(Boolean))];
      
      if (userIdsToFetch.length === 0) {
        return docs;
      }

      // Call backend endpoint to fetch displayNames
      const displayNameMap = await this.internalClient.getDisplayNames(userIdsToFetch);

      this.logger.debug(`[enrichDisplayNames] Fetched displayNames for ${Object.keys(displayNameMap).length} users`);

      // Update docs with proper displayNames
      return docs.map(doc => {
        const needsEnrich = /^[a-f0-9\-]{20,}$/i.test(doc.senderName);
        if (needsEnrich && displayNameMap[doc.senderName]) {
          return {
            ...doc,
            senderName: displayNameMap[doc.senderName],
          };
        } else if (needsEnrich) {
          // Still a UUID, but not found in database
          return {
            ...doc,
            senderName: 'Thành viên',  // Generic fallback
          };
        }
        return doc;
      });
    } catch (err: any) {
      this.logger.warn(`[enrichDisplayNames] Enrichment failed: ${err.message}. Using generic names.`);
      return docs.map(doc => ({
        ...doc,
        senderName: /^[a-f0-9\-]{20,}$/i.test(doc.senderName) ? 'Thành viên' : doc.senderName,
      }));
    }
  }

  private normalizeRawMessage(m: any): AskMessage | null {
    const id = m?.id?.toString?.() || m?.messageId?.toString?.();
    const content = m?.content || m?.text;
    if (!id || !content) return null;

    // Priority 1: sender.displayName from backend
    // Priority 2: Fallback to 'Thành viên' (just generic, never show IDs)
    const senderName = m?.sender?.displayName?.trim() ? 
      m.sender.displayName : 
      'Thành viên';

    return {
      id,
      content,
      senderName,
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
      windowText: hit?.payload?.windowText,
      senderName: hit?.payload?.senderName || 'User',
      createdAt: hit?.payload?.createdAt || new Date().toISOString(),
    };
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
    if (!lastMessageIdSynced) {
      return { stale: false, newMessageCount: 0 };
    }

    try {
      const newerMessages = await this.internalClient.getMessages({
        conversationId,
        userId,
        after: lastMessageIdSynced,
        limit: 5000,
        sort: 'asc',
      });

      const newMessageCount = Array.isArray(newerMessages) ? newerMessages.length : 0;
      return {
        stale: newMessageCount > 0,
        newMessageCount,
      };
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
