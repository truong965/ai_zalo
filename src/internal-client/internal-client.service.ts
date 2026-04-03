import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';
import {
  AIResponseCompletedPayload,
  AIResponseDeltaPayload,
  AIResponseErrorPayload,
  AIResponseProgressPayload,
  AIResponseStartedPayload,
  AIResponseThoughtPayload,
  AIResponseType,
  AIUnifiedResponseEventName,
  AIUnifiedResponseEvents,
} from '../shared/contracts/unified-stream.contract';

export interface GetMessagesParams {
  conversationId?: string;
  messageIds?: string[];
  limit?: number;
  offset?: number;
  sort?: 'asc' | 'desc';
  after?: string;
  startMessageId?: string;
  endMessageId?: string;
  startDate?: string;
  endDate?: string;
  userId?: string; // Optional at interface level, but enforced in services that require security
}

type UnifiedResponsePayloadByEvent = {
  [AIUnifiedResponseEvents.STARTED]: AIResponseStartedPayload;
  [AIUnifiedResponseEvents.PROGRESS]: AIResponseProgressPayload;
  [AIUnifiedResponseEvents.THOUGHT]: AIResponseThoughtPayload;
  [AIUnifiedResponseEvents.DELTA]: AIResponseDeltaPayload;
  [AIUnifiedResponseEvents.COMPLETED]: AIResponseCompletedPayload;
  [AIUnifiedResponseEvents.ERROR]: AIResponseErrorPayload;
};

type LegacyResponseType = 'summary' | 'stream-start' | 'stream-chunk' | 'stream-done' | 'stream-error';

type LegacyNotificationPayload = {
  requestId: string;
  conversationId: string;
  type: AIResponseType | LegacyResponseType;
  responseType: AIResponseType;
  ts: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
  message?: string;
  step?: string;
  percent?: number;
  content?: string;
  contentDelta?: string;
  thoughtDelta?: string;
  code?: string;
  retriable?: boolean;
};

export type NotifyUnifiedResponseParams<TEvent extends AIUnifiedResponseEventName> = {
  conversationId: string;
  userId: string;
  event: TEvent;
  payload: UnifiedResponsePayloadByEvent[TEvent];
};

export type UnifiedResponseBaseInput = {
  requestId?: string;
  conversationId: string;
  type: AIResponseType;
  sessionId?: string;
  meta?: Record<string, unknown>;
};

@Injectable()
export class InternalClientService {
  private readonly logger = new Logger(InternalClientService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly unifiedStreamEnabled: boolean;

  constructor(
    private readonly httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.baseUrl = this.configService.getOrThrow<string>('MAIN_APP_INTERNAL_URL');
    this.apiKey = this.configService.get<string>('INTERNAL_API_KEY')||'';
    this.unifiedStreamEnabled = this.configService.get<boolean>('AI_UNIFIED_STREAM_ENABLED', false);
  }

  private get headers() {
    return {
      'x-internal-api-key': this.apiKey, // Aligned with InternalAuthGuard
      'Content-Type': 'application/json',
    };
  }

  async getMessages(options: GetMessagesParams) {
    this.logger.debug(`Fetching messages with options: ${JSON.stringify(options)}`);

    try {
      // Manually build query string to avoid axios "[]" issues with NestJS
      const query = new URLSearchParams();
      if (options.conversationId) query.append('conversationId', options.conversationId);
      if (options.limit !== undefined) query.append('limit', options.limit.toString());
      if (options.offset !== undefined) query.append('offset', options.offset.toString());
      if (options.sort) query.append('sort', options.sort);
      if (options.after) query.append('after', options.after);
      if (options.startMessageId) query.append('startMessageId', options.startMessageId);
      if (options.endMessageId) query.append('endMessageId', options.endMessageId);
      if (options.startDate) query.append('startDate', options.startDate);
      if (options.endDate) query.append('endDate', options.endDate);
      if (options.userId) query.append('userId', options.userId);
      if (options.messageIds && options.messageIds.length > 0) {
        options.messageIds.forEach(id => query.append('messageIds', id));
      }

      const fullUrl = `${this.baseUrl}/internal/ai/messages?${query.toString()}`;
      this.logger.debug(`Outgoing request to: ${fullUrl}`);

      const response = await lastValueFrom(
        this.httpService.get<any>(fullUrl, {
          headers: this.headers,
        }),
      );

      this.logger.debug(`Raw response from Backend: ${JSON.stringify(response.data)}`);

      // Backend wraps in { statusCode, message, data: { messages: [...] } } via TransformInterceptor
      const responseData = response.data?.data || response.data;
      const messages = responseData?.messages || [];
      return messages;
    } catch (err: any) {
      const status = err.response?.status;
      const errorData = err.response?.data;
      this.logger.error(`Error fetching messages [${status}]: ${err.message}. Data: ${JSON.stringify(errorData)}`);
      throw err;
    }
  }

  async getSurroundingMessages(
    conversationId: string, 
    messageIds: string[], 
    k: number = 5,
    options?: { userId?: string }
  ) {
    this.logger.debug(`Fetching surrounding messages for ${conversationId}, ids: ${messageIds.length}`);

    if (!messageIds || messageIds.length === 0) return [];

    try {
      const query = new URLSearchParams();
      query.append('conversationId', conversationId);
      query.append('k', k.toString());
      if (options?.userId) query.append('userId', options.userId);
      messageIds.forEach(id => query.append('messageIds', id));

      const fullUrl = `${this.baseUrl}/internal/ai/messages/context?${query.toString()}`;
      this.logger.debug(`Outgoing request to: ${fullUrl}`);

      const response = await lastValueFrom(
        this.httpService.get<any>(fullUrl, {
          headers: this.headers,
        }),
      );

      const responseData = response.data?.data || response.data;
      return responseData?.messages || [];
    } catch (err: any) {
      const status = err.response?.status;
      this.logger.error(`Error fetching context messages [${status}]: ${err.message}`);
      return []; // Fallback to empty if fails, Ask pipeline handles empty nicely
    }
  }

  async getConversationInfo(conversationId: string) {
    this.logger.debug(`Fetching conversation info for ${conversationId}`);
    try {
      const response = await lastValueFrom(
        this.httpService.get<any>(`${this.baseUrl}/internal/ai/conversations/${conversationId}`, {
          headers: this.headers,
        }),
      );
      return response.data?.data || response.data;
    } catch (err: any) {
      this.logger.error(`Error fetching conversation info: ${err.message}`);
      throw err;
    }
  }

  async getDisplayNames(userIds: string[]): Promise<{ [userId: string]: string }> {
    if (!userIds || userIds.length === 0) return {};

    this.logger.debug(`Fetching display names for ${userIds.length} users`);
    try {
      const query = new URLSearchParams();
      userIds.forEach(id => query.append('userIds', id));

      const fullUrl = `${this.baseUrl}/internal/ai/users/display-names?${query.toString()}`;
      this.logger.debug(`Outgoing request to: ${fullUrl}`);

      const response = await lastValueFrom(
        this.httpService.get<any>(fullUrl, {
          headers: this.headers,
        }),
      );

      const displayNameMap = response.data?.data || response.data || {};
      this.logger.debug(`Fetched displayNames: ${JSON.stringify(displayNameMap)}`);
      return displayNameMap;
    } catch (err: any) {
      this.logger.error(`Error fetching display names: ${err.message}`);
      return {}; // Return empty map on error, enrichDisplayNames will fallback to generic names
    }
  }

  async notify(payload: { conversationId: string; userId: string; type: string; payload: any }) {
    this.logger.debug(`Sending ${payload.type} notification to main app for conversation ${payload.conversationId}`);
    try {
      await lastValueFrom(
        this.httpService.post(`${this.baseUrl}/internal/ai/notify`, payload, {
          headers: this.headers,
        }),
      );
    } catch (err: any) {
      this.logger.error(`Error sending notification: ${err.message}`);
    }
  }

  createUnifiedBasePayload(input: UnifiedResponseBaseInput) {
    return {
      requestId: input.requestId || randomUUID(),
      conversationId: input.conversationId,
      type: input.type,
      ts: new Date().toISOString(),
      sessionId: input.sessionId,
      meta: input.meta,
    };
  }

  async notifyUnifiedResponse<TEvent extends AIUnifiedResponseEventName>(
    params: NotifyUnifiedResponseParams<TEvent>,
  ) {
    if (this.unifiedStreamEnabled) {
      if (params.event === AIUnifiedResponseEvents.THOUGHT) {
        this.logger.debug(`Notifying THOUGHT to main app: ${JSON.stringify(params.payload)}`);
      }
      await this.notify({
        conversationId: params.conversationId,
        userId: params.userId,
        type: 'unified-response',
        payload: {
          event: params.event,
          ...params.payload,
        },
      });

      return;
    }

    const legacyNotification = this.mapUnifiedToLegacyNotification(params);

    await this.notify({
      conversationId: params.conversationId,
      userId: params.userId,
      type: legacyNotification.type,
      payload: legacyNotification.payload,
    });
  }

  private mapUnifiedToLegacyNotification<TEvent extends AIUnifiedResponseEventName>(
    params: NotifyUnifiedResponseParams<TEvent>,
  ): { type: LegacyResponseType; payload: LegacyNotificationPayload } {
    const base: any = params.payload;

    switch (params.event) {
      case AIUnifiedResponseEvents.STARTED:
        return {
          type: 'stream-start',
          payload: {
            ...base,
            type: base.type,
            responseType: base.type,
            message: base.message,
          },
        };
      case AIUnifiedResponseEvents.PROGRESS:
        return {
          type: 'stream-chunk',
          payload: {
            ...base,
            type: base.type,
            responseType: base.type,
            message: base.message,
            step: base.step,
            percent: base.percent,
          },
        };
      case AIUnifiedResponseEvents.DELTA:
        return {
          type: 'stream-chunk',
          payload: {
            ...base,
            type: base.type,
            responseType: base.type,
            contentDelta: base.contentDelta,
          },
        };
      case AIUnifiedResponseEvents.THOUGHT:
        return {
          type: 'stream-chunk',
          payload: {
            ...base,
            type: base.type,
            responseType: base.type,
            thoughtDelta: base.thoughtDelta,
          },
        };
      case AIUnifiedResponseEvents.COMPLETED:
        return base.type === 'summary'
          ? {
              type: 'summary',
              payload: {
                ...base,
                type: base.type,
                responseType: base.type,
                content: base.content,
              },
            }
          : {
              type: 'stream-done',
              payload: {
                ...base,
                type: base.type,
                responseType: base.type,
                content: base.content,
              },
            };
      case AIUnifiedResponseEvents.ERROR:
        return {
          type: 'stream-error',
          payload: {
            ...base,
            type: base.type,
            responseType: base.type,
            code: base.code,
            message: base.message,
            retriable: base.retriable,
          },
        };
      default:
        return {
          type: 'stream-error',
          payload: {
            ...base,
            type: base.type,
            code: 'AI_UNSUPPORTED_EVENT',
            message: 'Unsupported AI event',
          },
        };
    }
  }

  async validateAccess(conversationId: string, userId: string): Promise<boolean> {
    this.logger.debug(`Validating access for user ${userId} in conversation ${conversationId}`);
    try {
      const response = await lastValueFrom(
        this.httpService.post<any>(
          `${this.baseUrl}/internal/ai/validate-access`,
          { conversationId, userId },
          { headers: this.headers },
        ),
      );

      const responseData = response.data?.data || response.data;
      return Boolean(responseData?.hasAccess);
    } catch (err: any) {
      this.logger.error(`Error validating access: ${err.message}`);
      return false;
    }
  }
}
