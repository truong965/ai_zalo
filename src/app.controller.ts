import { Controller, Get, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { QdrantService } from './shared/qdrant.service';

@Controller()
export class AppController {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly qdrant: QdrantService,
    @InjectQueue('embed') private readonly embedQueue: Queue,
    @InjectQueue('ai-job') private readonly aiJobQueue: Queue,
  ) {}

  @Get('health')
  async getHealth() {
    let redisStatus = 'connected';
    try {
      await this.redis.ping();
    } catch (e) {
      redisStatus = 'disconnected';
    }

    const embedCount = await this.embedQueue.getJobCounts();
    const aiJobCount = await this.aiJobQueue.getJobCounts();

    return {
      status: redisStatus === 'connected' ? 'ok' : 'degraded',
      services: {
        redis: redisStatus,
        qdrant: 'connected', // Qdrant client connection is lazy but assume ok if initialized
        bullmq_embed_depth: embedCount.waiting + embedCount.active,
        bullmq_ai_job_depth: aiJobCount.waiting + aiJobCount.active,
      }
    };
  }

  @Get()
  getHello(): string {
    return 'AI Agent Service is running.';
  }
}
