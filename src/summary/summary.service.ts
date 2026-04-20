import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { AiFeatureType } from '../../prisma/generated/client';
import { SessionCacheService } from '../sessions/session-cache.service';
import { AIUnifiedResponseEvents } from '../shared/contracts/unified-stream.contract';
import { LangfuseCallbackProvider } from '../shared/langfuse-callback.provider';
import { AbortUtils } from '../shared/abort.utils';

export interface SummaryResult {
  summary: string;
  messageCount: number;
  fromTimestamp: string;
  fromCache: boolean;
  upToDate?: boolean;
  sessionId?: string;
}

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);
  private readonly DEFAULT_MESSAGE_COUNT = 300;

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly internalClient: InternalClientService,
    private readonly sessionCache: SessionCacheService,
    private readonly langfuseCallback: LangfuseCallbackProvider,
  ) { }

  async summarize(
    conversationId: string, 
    userId: string, 
    startMessageId?: string, 
    endMessageId?: string,
    startDate?: string,
    endDate?: string,
    requestId?: string,
    isStreaming = false,
    emitUnifiedEvents = true,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const unifiedBase = this.internalClient.createUnifiedBasePayload({
      requestId,
      conversationId,
      type: 'summary',
    });

    if (emitUnifiedEvents) {
      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.STARTED,
        payload: {
          ...unifiedBase,
          message: 'Started summary generation',
        },
      });
    }

    const hasAccess = await this.internalClient.validateAccess(conversationId, userId);
    if (!hasAccess) {
      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.ERROR,
          payload: {
            ...unifiedBase,
            code: 'SUMMARY_ACCESS_DENIED',
            message: 'User does not have access to this conversation',
            retriable: false,
          },
        });
      }
      throw new Error('User does not have access to this conversation');
    }

    const isCustomRange = !!(startMessageId || endMessageId || startDate || endDate);

    const latestSessions = await this.sessionCache.listRecentSessions(
      userId,
      conversationId,
      AiFeatureType.SUMMARY,
      1,
    );
    const latestSession = latestSessions[0];

    const limit = isCustomRange ? this.DEFAULT_MESSAGE_COUNT + 1 : this.DEFAULT_MESSAGE_COUNT;

    this.logger.log(`Fetching messages to summarize conversation: ${conversationId}`);
    if (emitUnifiedEvents) {
      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.PROGRESS,
        payload: {
          ...unifiedBase,
          step: 'fetch_messages',
          message: 'Fetching conversation messages',
        },
      });
    }

    const messages = await this.internalClient.getMessages({
      conversationId,
      limit,
      userId, // Mandatory for security
      after: isCustomRange ? undefined : (latestSession?.lastMessageIdSynced ?? undefined),
      startMessageId,
      endMessageId,
      startDate,
      endDate,
    });

    if (isCustomRange && messages.length > this.DEFAULT_MESSAGE_COUNT) {
      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.ERROR,
          payload: {
            ...unifiedBase,
            code: 'SUMMARY_RANGE_TOO_LARGE',
            message: `Summary range exceeds ${this.DEFAULT_MESSAGE_COUNT} messages`,
            retriable: false,
          },
        });
      }
      throw new HttpException('Khoảng thời gian tóm tắt quá dài. Vui lòng chọn dưới ' + this.DEFAULT_MESSAGE_COUNT + ' tin nhắn.', HttpStatus.PAYLOAD_TOO_LARGE);
    }

    if (latestSession && (!messages || messages.length === 0)) {
      const previousMessages = await this.sessionCache.getSessionMessages(latestSession.id, 10);
      const latestSummaryMessage = [...previousMessages]
        .reverse()
        .find((m) => m.role === 'assistant');

      const content = latestSummaryMessage?.content ?? 'Không có nội dung tóm tắt mới.';

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.COMPLETED,
          payload: {
            ...unifiedBase,
            sessionId: latestSession.id,
            content,
          },
        });
      }

      return {
        summary: content,
        messageCount: 0,
        fromTimestamp: latestSummaryMessage?.createdAt ?? latestSession.updatedAt.toISOString(),
        fromCache: false,
        upToDate: true,
        sessionId: latestSession.id,
      };
    }

    if (!messages || messages.length === 0) {
      const content = 'Chưa có đủ tin nhắn trong cuộc trò chuyện này để thực hiện tóm tắt.';

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
        summary: content,
        messageCount: 0,
        fromTimestamp: new Date().toISOString(),
        fromCache: false,
      };
    }

    let previousSummary = '';
    if (latestSession) {
      const previousMessages = await this.sessionCache.getSessionMessages(latestSession.id, 10);
      const latestSummaryMessage = [...previousMessages]
        .reverse()
        .find((m) => m.role === 'assistant');
      previousSummary = latestSummaryMessage?.content ?? '';
    }

    const conversationInfo = await this.internalClient.getConversationInfo(conversationId).catch(() => undefined);

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

    const prompt = `${previousSummary ? `Bản tóm tắt trước đó:\n${previousSummary}\n\n` : ''}Bạn là một trợ lý ảo thông minh. 
Ngày hiện tại là: ${new Date().toLocaleString('vi-VN')}.
Hãy tóm tắt nội dung chính của cuộc trò chuyện sau đây.
Yêu cầu kết quả trả về bằng Tiếng Việt, trình bày dưới dạng:
1. **Chủ Đề Chính**: (1-2 câu)
2. **Các Điểm Quan Trọng**: (danh sách gạch đầu dòng, tối đa 5 điểm)
3. **Quyết Định/Hành Động**: (nếu có)

Lưu ý: Khi nhắc đến các thành viên trong cuộc hội thoại, hãy sử dụng CHÍNH XÁC (giữ nguyên từng ký tự) Tên Hiển Thị của họ được cung cấp trong danh sách hội thoại bên dưới (VD: nếu tên là "truong" thì phải ghi là "truong", không được tự ý sửa thành "Trường").
  Không mở đầu bằng lời chào, không dùng câu dẫn nhập dài dòng, và không viết theo văn phong trang trọng nếu không cần.

Nội dung hội thoại:
<context>
${conversationText}
</context>`;

    try {
      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.PROGRESS,
          payload: {
            ...unifiedBase,
            step: 'generate_summary',
            message: 'Generating summary with LLM',
          },
        });
      }

      let summary = '';
      const callbacks = this.langfuseCallback.handler ? [this.langfuseCallback.handler] : undefined;
      const model = this.llm.getLangchainModel({ temperature: 0.7 });

      if (isStreaming) {
        summary = await this.streamSummary(
          model,
          prompt,
          conversationId,
          userId,
          unifiedBase,
          emitUnifiedEvents,
          signal,
        );
      } else {
        const response = await model.invoke(prompt, { signal, callbacks });
        summary = response.content.toString();
      }
      const sortedMessages = messages
        .filter((m: any) => m?.id)
        .sort((a: any, b: any) => this.compareMessageIds(a.id, b.id));
      const lastMessageIdSynced = sortedMessages.length
        ? String(sortedMessages[sortedMessages.length - 1].id)
        : latestSession?.lastMessageIdSynced ?? undefined;

      const session = await this.sessionCache.createSession({
        userId,
        conversationId,
        featureType: AiFeatureType.SUMMARY,
        title: `Summary ${new Date().toISOString()}`,
        contextSnapshot: {
          conversationTitle: conversationInfo?.title,
          conversationType: conversationInfo?.type,
          participantCount: conversationInfo?.members?.length,
          basedOnSessionId: latestSession?.id,
        },
        lastMessageIdSynced,
      });

      await this.sessionCache.addSessionMessage(session.id, 'assistant', summary, {
        engine: 'llm-gateway',
        incremental: Boolean(latestSession),
        basedOnSessionId: latestSession?.id,
      });

      if (lastMessageIdSynced) {
        await this.sessionCache.updateSessionSyncMarker(session.id, lastMessageIdSynced);
      }

      await this.sessionCache.enforceSessionLimit({
        userId,
        conversationId,
        featureType: AiFeatureType.SUMMARY,
        maxActive: 10,
      });

      const result: SummaryResult = {
        summary,
        messageCount: messages.length,
        fromTimestamp: messages[0].createdAt,
        fromCache: false,
        upToDate: false,
        sessionId: session.id,
      };

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.COMPLETED,
          payload: {
            ...unifiedBase,
            sessionId: session.id,
            content: summary,
          },
        });
      }

      return result;
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`LLM summary generation cancelled by user for conversation ${conversationId}`);
        throw err;
      }
      this.logger.error(`LLM summary generation failed: ${err.message}`);

      if (emitUnifiedEvents) {
        await this.internalClient.notifyUnifiedResponse({
          conversationId,
          userId,
          event: AIUnifiedResponseEvents.ERROR,
          payload: {
            ...unifiedBase,
            code: 'SUMMARY_GENERATION_FAILED',
            message: err?.message || 'Summary generation failed',
            retriable: true,
          },
        });
      }

      throw err;
    }
  }

  private async streamSummary(
    model: any,
    prompt: string,
    conversationId: string,
    userId: string,
    unifiedBase: any,
    emitUnifiedEvents = true,
    signal?: AbortSignal,
  ): Promise<string> {
    let summary = '';
    try {
      const callbacks = this.langfuseCallback.handler ? [this.langfuseCallback.handler] : undefined;
      const stream = await model.stream(prompt, { signal, callbacks });
      for await (const chunk of stream) {
        const textChunk = chunk.content.toString();
        summary += textChunk;
        if (emitUnifiedEvents) {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.DELTA,
            payload: {
              ...unifiedBase,
              contentDelta: textChunk,
            },
          });
        }
      }
      return summary;
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Summary stream cancelled by user for conversation ${conversationId}`);
        throw err;
      }
      this.logger.error(`Summary stream failed: ${err.message}`);
      throw err;
    }
  }

  private compareMessageIds(left: string | number | bigint, right: string | number | bigint): number {
    try {
      const a = BigInt(left);
      const b = BigInt(right);
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    } catch {
      return String(left).localeCompare(String(right), undefined, { numeric: true });
    }
  }
}
