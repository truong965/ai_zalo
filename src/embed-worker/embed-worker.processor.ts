import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EmbedWorkerService } from './embed-worker.service';

@Processor('embed', { 
  concurrency: 2, 
  limiter: { max: 50, duration: 60000 } 
})
export class EmbedWorkerProcessor extends WorkerHost {
  private readonly logger = new Logger(EmbedWorkerProcessor.name);

  constructor(private readonly embedWorkerService: EmbedWorkerService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);
    
    switch (job.name) {
      case 'embed-message':
        return this.embedWorkerService.handleEmbedMessage(job.data);
      default:
        this.logger.warn(`Unknown job name: ${job.name}`);
    }
  }
}
