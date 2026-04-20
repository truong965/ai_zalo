import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { GeminiService } from './gemini.service';
import { QdrantService } from './qdrant.service';
import { RedisPubsubService } from './redis-pubsub.service';
import { OpenAIService } from './openai.service';
import { GroqService } from './groq.service';
import { LangfuseService } from './langfuse.service';
import { RerankerService } from './reranker.service';
import { ContextCompressorService } from './context-compressor.service';
import { LangfuseCallbackProvider } from './langfuse-callback.provider';
import { LlmGatewayService } from './llm-gateway.service';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Global()
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    BullModule.registerQueue(
      {
        name: 'embed',
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      },
      { name: 'ai-job' },
    ),
  ],
  providers: [
    GeminiService,
    QdrantService,
    RedisPubsubService,
    OpenAIService,
    GroqService,
    LangfuseService,
    RerankerService,
    ContextCompressorService,
    LangfuseCallbackProvider,
    LlmGatewayService,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis({
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
          db: config.get<number>('REDIS_DB', 1),
        });
      },
    }
  ],
  exports: [GeminiService, QdrantService, RedisPubsubService, OpenAIService, GroqService, LangfuseService, RerankerService, ContextCompressorService, LangfuseCallbackProvider, LlmGatewayService, BullModule, HttpModule, 'REDIS_CLIENT'],
})
export class SharedModule { }
