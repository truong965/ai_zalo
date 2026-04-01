import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TriggerBotDto } from './dto/trigger-bot.dto';
import { AgentJobData } from '../agent/agent.types';
import { TranslateService } from '../translate/translate.service';
import { AskService } from '../ask/ask.service';
import { InternalClientService } from '../internal-client/internal-client.service';

@Injectable()
export class BotGatewayService {
  private readonly logger = new Logger(BotGatewayService.name);

  constructor(
    @InjectQueue('ai-job') private readonly aiJobQueue: Queue,
    private readonly translateService: TranslateService,
    private readonly askService: AskService,
    private readonly internalClient: InternalClientService,
  ) { }

  async handleTrigger(dto: TriggerBotDto): Promise<any> {
    this.logger.log(`Received bot trigger: ${dto.type} in conversation ${dto.conversationId}`);

    // Fast-track interactive tools (Synchronous)
    if (dto.type === 'translate' && dto.messageId && dto.targetLang) {
      this.logger.debug(`Fast-tracking translation for message ${dto.messageId}`);
      // 1. Fetch message text
      const messages = await this.internalClient.getMessages({
        messageIds: [dto.messageId],
        conversationId: dto.conversationId
      });
      
      if (!messages || messages.length === 0) {
        this.logger.error(`Message ${dto.messageId} not found in Backend DB`);
        throw new Error('Message not found');
      }

      const text = messages[0].content || messages[0].text;
      this.logger.debug(`Successfully fetched message content: "${text}"`);

      // 2. Translate
      const result = await this.translateService.translate(text, dto.targetLang);
      this.logger.debug(`Translation success: ${JSON.stringify(result)}`);
      return result;
    }

    if (dto.type === 'ask' && dto.text) {
      this.logger.debug(`Fast-tracking RAG query for conversation ${dto.conversationId}`);
      
      if (dto.stream) {
        // Fire and forget: unblock the HTTP or calling client immediately
        this.askService.ask(dto.conversationId, dto.userId, dto.text, true).catch(err => {
          this.logger.error(`Stream background ask failed for ${dto.conversationId}: ${err.message}`);
        });
        return { message: 'Streaming initiated', status: 'streaming' };
      }

      return await this.askService.ask(dto.conversationId, dto.userId, dto.text, false);
    }

    // Standard tools (Asynchronous via Queue)
    const jobData: AgentJobData = {
      type: dto.type,
      conversationId: dto.conversationId,
      userId: dto.userId,
      messageId: dto.messageId,
      text: dto.text,
      targetLang: dto.targetLang,
    };

    const job = await this.aiJobQueue.add('process-request', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
    });

    return {
      message: `${dto.type} request queued successfully`,
      jobId: job.id
    };
  }
}
