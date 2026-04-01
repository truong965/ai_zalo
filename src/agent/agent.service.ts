import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { AgentJobData } from './agent.types';
import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';
import { AskService } from '../ask/ask.service';
import { SummaryService } from '../summary/summary.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly translateService: TranslateService,
    private readonly internalClient: InternalClientService,
    @Inject(forwardRef(() => AskService))
    private readonly askService: AskService,
    private readonly summaryService: SummaryService,
  ) {}

  /**
   * Fast-track for specific commands like 'translate'
   */
  async handleTranslate(data: AgentJobData) {
    if (!data.messageId || !data.targetLang) {
      throw new Error('MessageId and TargetLang are required for translation');
    }

    this.logger.log(`Handling fast-track translation for message ${data.messageId} to ${data.targetLang}`);

    // 1. Fetch original message
    const messages: any[] = await this.internalClient.getMessages({
      messageIds: [data.messageId],
    });
    
    if (!messages.length) {
      throw new Error('Original message not found');
    }

    const originalText = messages[0].content || messages[0].text;

    // 2. Translate
    const result = await this.translateService.translate(originalText, data.targetLang);

    // 3. Notify back to main app
    await this.internalClient.notify({
      conversationId: data.conversationId,
      userId: data.userId,
      type: 'translate',
      payload: {
        messageId: data.messageId,
        originalText: result.originalText,
        translatedText: result.translatedText,
        sourceLang: result.sourceLang,
        targetLang: result.targetLang,
        engine: result.engine,
      },
    });

    return result;
  }

  async handleAsk(data: AgentJobData) {
    if (!data.conversationId || !data.text) {
      throw new Error('ConversationId and Text are required for Ask tool');
    }

    this.logger.log(`Handling fast-track ask for conversation ${data.conversationId}`);

    // 1. Process ask via AskService
    const askService = this.askService; // Assuming it's injected
    const result = await askService.ask(data.conversationId, data.userId, data.text);

    // 2. Notify back to main app
    await this.internalClient.notify({
      conversationId: data.conversationId,
      userId: data.userId,
      type: 'ask',
      payload: {
        answer: result.answer,
        sources: result.sources,
      },
    });

    return result;
  }

  async handleSummary(data: AgentJobData) {
    if (!data.conversationId) {
      throw new Error('ConversationId is required for Summary tool');
    }

    this.logger.log(`Handling fast-track summary for conversation ${data.conversationId}`);

    // 1. Process summary via SummaryService
    const result = await this.summaryService.summarize(data.conversationId);

    // 2. Notify back to main app
    await this.internalClient.notify({
      conversationId: data.conversationId,
      userId: data.userId,
      type: 'summary',
      payload: {
        summary: result.summary,
        messageCount: result.messageCount,
        fromTimestamp: result.fromTimestamp,
        fromCache: result.fromCache,
      },
    });

    return result;
  }

  /**
   * Generic LangChain Agent entry point (for @ai generic questions)
   */
  async runAgent(data: AgentJobData) {
    this.logger.log(`Running generic agent for: ${data.text}`);
    // Future implementation for full LangChain loop
    return { status: 'not_implemented' };
  }
}
