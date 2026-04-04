import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TaskType } from '@google/generative-ai';
import { GeminiService } from '../shared/gemini.service';
import { QdrantService } from '../shared/qdrant.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { RerankerService } from '../shared/reranker.service';
import { ContextCompressorService } from '../shared/context-compressor.service';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { AbortUtils } from '../shared/abort.utils';

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

@Injectable()
export class RetrieverService {
  private readonly logger = new Logger(RetrieverService.name);
  public readonly PASS_1_PLAN: RetrievalPlan = { recentLimit: 20, qdrantLimit: 10, maxRewriteQueries: 0, rerankTopN: 5 };
  public readonly PASS_2_PLAN: RetrievalPlan = { recentLimit: 60, qdrantLimit: 20, maxRewriteQueries: 2, rerankTopN: 15 };

  constructor(
    private readonly qdrantService: QdrantService,
    private readonly geminiService: GeminiService,
    private readonly internalClient: InternalClientService,
    private readonly rerankerService: RerankerService,
    private readonly compressorService: ContextCompressorService,
    private readonly configService: ConfigService,
    private readonly llmGateway: LlmGatewayService,
  ) { }

  public async retrieveOnly(
    conversationId: string,
    userId: string,
    question: string,
    startDate?: string,
    endDate?: string,
    signal?: AbortSignal,
  ): Promise<AskMessage[]> {
    return this.retrieveContext(conversationId, userId, question, this.PASS_1_PLAN, startDate, endDate, signal);
  }

  public async retrieveContext(
    conversationId: string,
    userId: string,
    question: string,
    plan: RetrievalPlan,
    startDate?: string,
    endDate?: string,
    signal?: AbortSignal,
  ): Promise<AskMessage[]> {
    const { queries, startDate: extractedStart, endDate: extractedEnd } = await this.rewriteQueries(question, plan.maxRewriteQueries, signal);

    const finalStart = startDate || extractedStart;
    const finalEnd = endDate || extractedEnd;

    this.logger.debug(`[retrieveContext] Query: "${question}", Queries: ${queries.length}, FinalStart: ${finalStart}, FinalEnd: ${finalEnd}`);

    const mergedMap = new Map<string, AskMessage>();

    const recentMessagesRaw = await this.internalClient.getMessages({
      conversationId,
      limit: plan.recentLimit,
      sort: 'desc',
      userId,
      startDate: finalStart,
      endDate: finalEnd,
    });
    const recentMessages = ((recentMessagesRaw as any[]) || []).reverse();

    this.logger.debug(`[retrieveContext] Fetched ${recentMessages.length} recent messages`);

    const recentDocs = recentMessages
      .map((m) => this.normalizeRawMessage(m))
      .filter((m): m is AskMessage => m !== null);

    for (const q of queries) {
      if (signal?.aborted) throw new Error('AI Request Cancelled');
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
        if (AbortUtils.isAbortError(err)) {
          this.logger.debug(`Hybrid retrieval cancelled by user for query "${q}"`);
          throw err;
        }
        this.logger.warn(`Hybrid retrieval failed for query "${q}": ${err.message}`);
      }
    }

    const uniqueQdrantDocs = Array.from(mergedMap.values());
    let finalReranked: AskMessage[] = [];

    if (uniqueQdrantDocs.length > 0) {
      const enrichedDocs = await this.enrichDisplayNames(uniqueQdrantDocs, conversationId, userId);
      const topN = plan.rerankTopN || this.configService.get<number>('RERANK_TOP_N', 5);
      const rerankedRaw = await this.rerankerService.rerank({
        query: question,
        documents: enrichedDocs.map(d => ({ ...d, text: d.windowText || d.content })),
        topN,
      });

      finalReranked = rerankedRaw.map(r => {
        const original = enrichedDocs.find(d => d.id === r.id);
        return { ...original, relevanceScore: r.relevanceScore } as AskMessage;
      });
    }

    const combinedDocsMap = new Map<string, AskMessage>();
    for (const d of finalReranked) combinedDocsMap.set(d.id, d);
    
    for (const d of recentDocs.slice(-8)) {
      if (!combinedDocsMap.has(d.id)) {
        combinedDocsMap.set(d.id, { ...d, relevanceScore: 1.0 }); 
      }
    }

    const combinedDocs = Array.from(combinedDocsMap.values());
    if (combinedDocs.length === 0) return [];

    const compressionThreshold = this.configService.get<number>('CONTEXT_COMPRESSION_THRESHOLD', 1000);
    const totalLength = combinedDocs.reduce((acc, d) => acc + (d.windowText || d.content).length, 0);

    if (totalLength > compressionThreshold) {
      if (signal?.aborted) throw new Error('AI Request Cancelled');
      const compressedText = await this.compressorService.compress({
        question,
        contexts: combinedDocs.map(d => `[${d.senderName}]: ${d.windowText || d.content}`),
      });

      const result: any = combinedDocs;
      result.compressedText = compressedText;
      result.isCompressed = true;
      return result;
    }

    return combinedDocs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  private parseVietnameseDateFromQuestion(question: string): { startDate?: string; endDate?: string } {
    const now = new Date();

    const fullDateMatch = question.match(/(?:ngày\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (fullDateMatch) {
      const day = fullDateMatch[1];
      const month = fullDateMatch[2];
      const year = fullDateMatch[3];
      try {
        const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return { startDate: iso, endDate: iso };
      } catch (e) { }
    }

    const monthDayMatch = question.match(/ngày\s+(\d{1,2})\/(\d{1,2})(?!\d)/);
    if (monthDayMatch) {
      const day = monthDayMatch[1];
      const month = monthDayMatch[2];
      try {
        const iso = `${now.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        return { startDate: iso, endDate: iso };
      } catch (e) { }
    }

    return {};
  }

  private async rewriteQueries(question: string, maxRewriteQueries: number, signal?: AbortSignal): Promise<{ queries: string[], startDate?: string, endDate?: string }> {
    if (maxRewriteQueries <= 0) return { queries: [question] };

    try {
      const localParsed = this.parseVietnameseDateFromQuestion(question);
      if (localParsed.startDate) {
        return { 
           queries: [question], 
           startDate: `${localParsed.startDate}T00:00:00.000Z`, 
           endDate: `${localParsed.endDate || localParsed.startDate}T23:59:59.999Z` 
        };
      }

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

      const response = await this.llmGateway.generateText(prompt, { temperature: 0.1, maxTokens: 250, signal });
      
      const queriesStr = response.match(/QUERIES: (.*)/)?.[1] || '';
      let startDateStr = response.match(/START_DATE: (.*)/)?.[1]?.trim();
      let endDateStr = response.match(/END_DATE: (.*)/)?.[1]?.trim();

      if ((!startDateStr || startDateStr === 'null' || startDateStr === '') && 
          (!endDateStr || endDateStr === 'null' || endDateStr === '')) {
        const localParsed = this.parseVietnameseDateFromQuestion(question);
        if (localParsed.startDate) {
          startDateStr = localParsed.startDate;
          endDateStr = localParsed.endDate || localParsed.startDate;
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
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Query rewrite cancelled by user`);
        throw err;
      }
      this.logger.warn(`Query rewrite & date extraction failed: ${err.message}`);
      return { queries: [question] };
    }
  }

  private async enrichDisplayNames(
    docs: AskMessage[],
    conversationId: string,
    userId: string,
  ): Promise<AskMessage[]> {
    const docsNeedingEnrich = docs.filter(d => {
      const name = d.senderName || '';
      return /^[a-f0-9\-]{20,}$/i.test(name);
    });

    if (docsNeedingEnrich.length === 0) {
      return docs;
    }

    try {
      const userIdsToFetch = [...new Set(docsNeedingEnrich.map(d => d.senderName).filter(Boolean))];
      
      if (userIdsToFetch.length === 0) return docs;

      const displayNameMap = await this.internalClient.getDisplayNames(userIdsToFetch);

      return docs.map(doc => {
        const needsEnrich = /^[a-f0-9\-]{20,}$/i.test(doc.senderName);
        if (needsEnrich && displayNameMap[doc.senderName]) {
          return { ...doc, senderName: displayNameMap[doc.senderName] };
        } else if (needsEnrich) {
          return { ...doc, senderName: 'Thành viên' };
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
      senderName: hit?.payload?.displayName || hit?.payload?.senderName || 'Thành viên',
      createdAt: hit?.payload?.createdAt || new Date().toISOString(),
    };
  }
}
