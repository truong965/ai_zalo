import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { SessionCacheService } from './session-cache.service';
import { InternalApiKeyGuard } from './internal-api-key.guard';

@Module({
  controllers: [SessionController],
  providers: [
    SessionService,
    SessionCacheService,
    InternalApiKeyGuard,
  ],
  exports: [SessionService, SessionCacheService],
})
export class SessionModule implements OnModuleInit {
  private readonly logger = new Logger(SessionModule.name);

  constructor(private readonly sessionCache: SessionCacheService) {}

  async onModuleInit() {
    try {
      this.logger.log('Cleaning up obsolete Redis keys (ask_session:*, summary:*)...');
      // @ts-expect-error - accessing private redis client for one-off cleanup
      const redis = this.sessionCache.redis;
      const askKeys = await redis.keys('ask_session:*');
      const summaryKeys = await redis.keys('summary:*');
      const allKeys = [...askKeys, ...summaryKeys];
      
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
        this.logger.log(`Cleaned up ${allKeys.length} obsolete Redis keys.`);
      } else {
        this.logger.log('No obsolete Redis keys found.');
      }
    } catch (error: any) {
      this.logger.warn(`Failed to clean up obsolete Redis keys: ${error.message}`);
    }
  }
}