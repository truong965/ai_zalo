import { Injectable, OnModuleInit, Logger, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class RedisPubsubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubsubService.name);
  private subscriber: IORedis;

  constructor(
    private configService: ConfigService,
    @InjectQueue('embed') private embedQueue: Queue,
    @InjectQueue('ai-job') private aiJobQueue: Queue,
    @Inject('REDIS_CLIENT') private redis: IORedis,
  ) {
    this.subscriber = new IORedis({
      host: this.configService.getOrThrow('REDIS_HOST'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      db: this.configService.get<number>('REDIS_DB', 1),
    });
  }

  async onModuleInit() {
    this.logger.log('RedisPubsubService initialized. Subscribing to chat:new_message...');

    await this.subscriber.subscribe('chat:new_message', (err, count) => {
      if (err) {
        this.logger.error('Failed to subscribe:', err.message);
      } else {
        this.logger.log(`Subscribed to ${count} channels.`);
      }
    });

    this.subscriber.on('message', async (channel, message) => {
      if (channel !== 'chat:new_message') return;

      try {
        const payload = JSON.parse(message);
        const { messageId, conversationId, userId, text, createdAt } = payload;

        this.logger.debug(`New message in ${conversationId}: ${messageId}`);

        const jobData = {
          messageId,
          conversationId,
          userId,
          text,
          createdAt,
        };

        // 2. Dispatch to Embed Queue
        await this.embedQueue.add('embed-message', jobData, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        });

        // 3. Update message counter for auto-summary
        await this.handleAutoSummaryTrigger(conversationId);

      } catch (err: any) {
        this.logger.error('Error parsing/dispatching Redis message:', err.message);
      }
    });
  }

  private async handleAutoSummaryTrigger(conversationId: string) {
    const counterKey = `msg_count:${conversationId}`;
    const count = await this.redis.incr(counterKey);

    if (count >= 50) {
      this.logger.log(`Auto-triggering summary for conversation ${conversationId} (50 messages reached)`);
      // Reset counter
      await this.redis.set(counterKey, 0);

      // Dispatch summary job
      await this.aiJobQueue.add('process-request', {
        type: 'summary',
        conversationId,
        userId: 'system-auto-trigger', // System triggered
      }, {
        attempts: 2,
        removeOnComplete: true,
      });
    }
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
  }
}
