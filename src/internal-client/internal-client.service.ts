import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { lastValueFrom } from 'rxjs';

export interface GetMessagesParams {
  conversationId?: string;
  messageIds?: string[];
  limit?: number;
  offset?: number;
  sort?: 'asc' | 'desc';
  userId?: string;
}

@Injectable()
export class InternalClientService {
  private readonly logger = new Logger(InternalClientService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.baseUrl = this.configService.getOrThrow<string>('MAIN_APP_INTERNAL_URL');
    this.apiKey = this.configService.getOrThrow<string>('MAIN_APP_INTERNAL_API_KEY');
  }

  private get headers() {
    return {
      'x-api-key': this.apiKey, // Aligned with InternalAuthGuard
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
}
