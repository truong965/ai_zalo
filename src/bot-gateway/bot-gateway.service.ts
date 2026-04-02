import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TriggerBotDto, BotTriggerType } from './dto/trigger-bot.dto';
import { AgentService } from '../agent/agent.service';
import { AgentJobData } from '../agent/agent.types';

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

    // If it's not a generic 'agent' intent, or it's a fixed tool trigger
    if (dto.type !== BotTriggerType.AGENT) {
      
      // Handle streaming 'ask' in fire-and-forget mode
      if (dto.type === BotTriggerType.ASK && dto.stream) {
        this.logger.debug('Fast-tracking streaming ask');
        this.agentService.executeTool(dto).catch(err => {
          this.logger.error(`Stream execution background failure: ${err.message}`);
        });
        return { message: 'Streaming initiated', status: 'streaming' };
      }

      // Fast-track explicit tool calls (Synchronous)
      return this.agentService.executeTool(dto);
    }

    // Natural Language / Generic Agent intent -> Async processing via Queue
    const jobData: AgentJobData = {
      type: dto.type,
      conversationId: dto.conversationId,
      userId: dto.userId,
      text: dto.text,
      // params usually not provided for 'agent' type from requester
    };

    const job = await this.aiJobQueue.add('process-request', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
    });

    this.logger.debug(`Agent request queued: jobId=${job.id}`);
    return {
      message: 'Agent request queued successfully',
      jobId: job.id
    };
  }
}
