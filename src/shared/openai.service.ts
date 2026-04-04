import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { ZodSchema } from 'zod';
import { AbortUtils } from './abort.utils';

@Injectable()
export class OpenAIService implements OnModuleInit {
  private readonly logger = new Logger(OpenAIService.name);
  private client: OpenAI;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    this.client = new OpenAI({
      apiKey,
    });
    this.logger.log('OpenAIService initialized.');
  }

  /**
   * Detect if the model is a reasoning-based model (o1, o3, gpt-5, etc.)
   */
  private isReasoningModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith('o1') || m.startsWith('o3') || m.includes('gpt-5') || m.includes('nano');
  }

  /**
   * Get structured output using Zod schema (standard for 2026)
   */
  async structured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    schemaName: string,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const model = options?.model || this.configService.get<string>('OPENAI_ROUTER_MODEL', 'gpt-5-nano');
    const isReasoning = this.isReasoningModel(model);
    this.logger.debug(`Calling OpenAI ${model} for structured output: ${schemaName} (Reasoning: ${isReasoning})`);

    try {
      const params: any = {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: zodResponseFormat(schema, schemaName),
      };

      if (isReasoning) {
        // Reasoning models often only support temperature 1. 
        // 0 is also commonly used in generic code for "deterministic", which we'll treat as 1 (default) without warning.
        if (options?.temperature !== undefined && options.temperature !== 1 && options.temperature !== 0) {
          this.logger.warn(`Model ${model} might not support temperature ${options.temperature}. Defaulting to 1.`);
        }
        params.temperature = 1;
      } else {
        params.temperature = options?.temperature ?? 0;
      }

      // Handle token limits
      if (options?.maxTokens) {
        if (isReasoning) {
          params.max_completion_tokens = options.maxTokens;
        } else {
          params.max_tokens = options.maxTokens;
        }
      }

      const completion = await (this.client.chat.completions as any).parse(params, { signal: options?.signal });

      const result = (completion as any).choices[0].message.parsed;
      if (!result) {
        throw new Error('Failed to parse structured output from OpenAI');
      }

      return result as T;
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`OpenAI structured output cancelled by user`);
        throw err;
      }
      this.logger.error(`OpenAI structured output failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generic chat completion
   */
  async chat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<string> {
    const model = options?.model || this.configService.get<string>('OPENAI_ROUTER_MODEL', 'gpt-5-nano');
    
    const isReasoning = this.isReasoningModel(model);
    
    try {
      const params: any = {
        model,
        messages,
      };

      if (isReasoning) {
        params.temperature = 1;
      } else {
        params.temperature = options?.temperature ?? 0.7;
      }

      if (options?.maxTokens) {
        if (isReasoning) {
          params.max_completion_tokens = options.maxTokens;
        } else {
          params.max_tokens = options.maxTokens;
        }
      }

      const completion = await this.client.chat.completions.create(params, { signal: options?.signal });

      return completion.choices[0].message.content || '';
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`OpenAI chat completion cancelled by user`);
        throw err;
      }
      this.logger.error(`OpenAI chat completion failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Streaming version of structured output that yields reasoning chunks
   */
  async structuredStream<T>(
    prompt: string,
    schema: ZodSchema<T>,
    schemaName: string,
    onReasoning: (chunk: string) => void,
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const model = options?.model || this.configService.get<string>('OPENAI_ROUTER_MODEL', 'gpt-5-nano');
    const isReasoning = this.isReasoningModel(model);
    
    this.logger.debug(`Streaming OpenAI ${model} for structured output: ${schemaName}`);

    try {
      const params: any = {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: zodResponseFormat(schema, schemaName),
        stream: true,
      };

      if (isReasoning) {
        params.temperature = 1;
      } else {
        params.temperature = options?.temperature ?? 0;
      }

      const stream = (await this.client.chat.completions.create(params, { signal: options?.signal })) as any;
      let aggregatedContent = '';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as any;
        
        // Capture reasoning content
        if (delta?.reasoning_content) {
          onReasoning(delta.reasoning_content);
        }

        // Capture structured content
        if (delta?.content) {
          aggregatedContent += delta.content;
        }
      }

      try {
        return JSON.parse(aggregatedContent) as T;
      } catch (parseErr) {
        // Fallback: Use manual zod parsing if JSON is slightly off
        return schema.parse(JSON.parse(aggregatedContent));
      }
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`OpenAI structured streaming cancelled by user`);
        throw err;
      }
      this.logger.error(`OpenAI structured streaming failed: ${err.message}`);
      throw err;
    }
  }
}
