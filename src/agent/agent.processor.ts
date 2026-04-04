import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentJobData } from './agent.types';
import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';
import { CriticService } from './critic.service';

@Processor('ai-job')
export class AgentProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentProcessor.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly criticService: CriticService,
  ) {
    super();
  }

  async process(job: Job<AgentJobData, any, string>): Promise<any> {
    this.logger.log(`Processing AI job ${job.id} of type ${job.data.type}`);
    
    switch (job.data.type) {
      case BotTriggerType.TRANSLATE:
      case BotTriggerType.ASK:
      case BotTriggerType.SUMMARY:
        return this.agentService.executeTool(job.data);
      case BotTriggerType.AGENT:
        return this.agentService.runAgent(job.data, job.attemptsMade > 0);
      case BotTriggerType.CRITIC_EVAL:
        if (job.data.evalParams) {
          return this.criticService.evaluate(job.data.evalParams);
        }
        return null;
      default:
        this.logger.warn(`Unknown job type: ${job.data.type}`);
    }
  }
}
