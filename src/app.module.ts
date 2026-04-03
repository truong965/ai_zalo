import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import * as Joi from 'joi';

import { SharedModule } from './shared/shared.module';
import { BotGatewayModule } from './bot-gateway/bot-gateway.module';
import { AgentModule } from './agent/agent.module';
import { TranslateModule } from './translate/translate.module';
import { AskModule } from './ask/ask.module';
import { SummaryModule } from './summary/summary.module';
import { EmbedWorkerModule } from './embed-worker/embed-worker.module';
import { InternalClientModule } from './internal-client/internal-client.module';
import { PrismaModule } from './database/prisma.module';
import { SessionModule } from './sessions/session.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(3001),
        NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

        // Main App Internal API
        MAIN_APP_INTERNAL_URL: Joi.string().uri().required(),
        INTERNAL_API_KEY: Joi.string().required(),
        AI_UNIFIED_STREAM_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),

        // Redis
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        REDIS_PASSWORD: Joi.string().allow('').optional(),
        REDIS_DB: Joi.number().default(0),

        // ai_zalo PostgreSQL
        AI_DATABASE_URL: Joi.string().pattern(/^postgres(?:ql)?:\/\/.+$/).required(),

        // Qdrant
        QDRANT_URL: Joi.string().uri().required(),
        QDRANT_API_KEY: Joi.string().required(),
        QDRANT_COLLECTION_NAME: Joi.string().default('chat_messages'),
        QDRANT_VECTOR_SIZE: Joi.number().default(768),

        // Gemini (Google AI)
        GEMINI_API_KEY: Joi.string().required(),
        GEMINI_LLM_MODEL: Joi.string().default('gemini-1.5-flash'),
        GEMINI_EMBED_MODEL: Joi.string().default('text-embedding-004'),
        GEMINI_EMBED_OUTPUT_DIMENSION: Joi.number().integer().positive().optional(),

        // Tools & Fallbacks
        LIBRETRANSLATE_URL: Joi.string().uri().optional(),
        LIBRETRANSLATE_API_KEY: Joi.string().optional().allow(''),

        // OpenAI (GPT-5 Nano for routing/critic)
        OPENAI_API_KEY: Joi.string().required(),
        OPENAI_ROUTER_MODEL: Joi.string().default('gpt-5-nano'),

        // Langfuse
        LANGFUSE_PUBLIC_KEY: Joi.string().optional(),
        LANGFUSE_SECRET_KEY: Joi.string().optional(),
        LANGFUSE_BASE_URL: Joi.string().default('https://cloud.langfuse.com'),

        // Quality Thresholds
        CRITIC_GROUNDEDNESS_THRESHOLD: Joi.number().default(0.7),
        CRITIC_HALLUCINATION_THRESHOLD: Joi.number().default(0.3),
        CRAG_RELEVANCE_THRESHOLD: Joi.number().default(0.7),
        CRAG_MAX_RETRIES: Joi.number().default(1),

        // Phase 3
        COHERE_API_KEY: Joi.string().optional(),
        COHERE_RERANK_MODEL: Joi.string().default('rerank-v3.5'),
        RERANK_TOP_N: Joi.number().default(5),
        CONTEXT_COMPRESSION_THRESHOLD: Joi.number().default(1000),
        HYBRID_SEARCH_DENSE_WEIGHT: Joi.number().default(0.7),
        HYBRID_SEARCH_SPARSE_WEIGHT: Joi.number().default(0.3),
      }),
    }),
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
          db: config.get<number>('REDIS_DB'),
        },
      }),
    }),
    SharedModule,
    InternalClientModule,
    PrismaModule,
    SessionModule,
    BotGatewayModule,
    AgentModule,
    TranslateModule,
    AskModule,
    SummaryModule,
    EmbedWorkerModule,
  ],
  controllers: [AppController],
})
export class AppModule { }
