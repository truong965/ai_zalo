import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TriggerBotDto, BotTriggerType } from './dto/trigger-bot.dto';
import { AgentJobData } from '../agent/agent.types';
import { AgentService } from '../agent/agent.service';

@Injectable()
export class BotGatewayService {
  private readonly logger = new Logger(BotGatewayService.name);

  constructor(
    @InjectQueue('ai-job') private readonly aiJobQueue: Queue,
    private readonly agentService: AgentService,
  ) { }

  /**
   * Main entry point for bot triggers from Main App.
   */
  async handleTrigger(dto: TriggerBotDto): Promise<any> {
    this.logger.log(`Received bot trigger: ${dto.type} in conversation ${dto.conversationId}`);

    // Keep low-latency UX for streaming ask: start immediately in background.
    if (dto.type === BotTriggerType.ASK && dto.stream) {
      this.logger.debug('Fast-path streaming ask request');
      this.agentService.executeTool(dto).catch((err) => {
        this.logger.error(`Streaming ask execution failed: ${err.message}`);
      });

      return {
        accepted: true,
        status: 'streaming_started',
        type: dto.type,
        conversationId: dto.conversationId,
        requestId: dto.requestId,
      };
    }

    const jobData: AgentJobData = {
      type: dto.type,
      conversationId: dto.conversationId,
      userId: dto.userId,
      text: dto.text,
      messageId: dto.messageId,
      targetLang: dto.targetLang,
      stream: dto.stream,
      requestId: dto.requestId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      startMessageId: dto.startMessageId,
      endMessageId: dto.endMessageId,
    };

    const job = await this.aiJobQueue.add('process-request', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
    });

    this.logger.debug(`AI request queued: type=${dto.type}, jobId=${job.id}`);
    return {
      accepted: true,
      jobId: job.id,
      status: 'queued',
      type: dto.type,
      conversationId: dto.conversationId,
      requestId: dto.requestId,
    };
  }
}
