import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIService } from './openai.service';
import { GeminiService } from './gemini.service';
import { ZodSchema } from 'zod';
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AbortUtils } from './abort.utils';

@Injectable()
export class LlmGatewayService {
  private readonly logger = new Logger(LlmGatewayService.name);

  constructor(
    private configService: ConfigService,
    private openaiService: OpenAIService,
    private geminiService: GeminiService,
  ) {}

  /**
   * Generates text with automatic provider fallback
   * Strategy: Try Gemini first, then OpenAI if it fails.
   */
  async generateText(prompt: string, options?: { maxTokens?: number; temperature?: number; model?: string; signal?: AbortSignal }): Promise<string> {
    const promise = (async () => {
      const preferredModel = options?.model || this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-2.5-flash');
      
      // Simple routing based on prefix
      if (preferredModel.startsWith('gpt') || preferredModel.startsWith('o1') || preferredModel.startsWith('o3')) {
        try {
          return await this.openaiService.chat([{ role: 'user', content: prompt }], options);
        } catch (e: any) {
          this.logger.warn(`OpenAI primary failed: ${e.message}, falling back to Gemini`);
          return await this.geminiService.generateText(prompt, options);
        }
      } else {
        try {
          // Preferred Gemini
          return await this.geminiService.generateText(prompt, options);
        } catch (e: any) {
          this.logger.warn(`Gemini primary failed: ${e.message}, falling back to OpenAI`);
          return await this.openaiService.chat([{ role: 'user', content: prompt }], { ...options, model: 'gpt-4o-mini' });
        }
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Streams text matching the configured fallback strategy.
   */
  async *streamText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string; signal?: AbortSignal },
  ): AsyncGenerator<string, void, unknown> {
    const stream = (async function* (this: LlmGatewayService) {
      for await (const chunk of this.streamTextWithThinking(prompt, options)) {
        if (chunk.type === 'text') {
          yield chunk.text;
        }
      }
    }).call(this);
    yield* AbortUtils.abortableStream(stream, options?.signal);
  }

  /**
   * Streams text with native reasoning chunks (Gemini only)
   */
  async *streamTextWithThinking(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string; thinkingBudget?: number; signal?: AbortSignal },
  ): AsyncGenerator<{ type: 'thought' | 'text'; text: string }, void, unknown> {
    const stream = (async function* (this: LlmGatewayService) {
      const preferredModel = options?.model || this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-2.5-flash');
      
      // OpenAI structured/chat doesn't expose raw reasoning tokens in the same way in this bridge yet,
      // so we prioritize Gemini for real thinking.
      if (preferredModel.startsWith('gpt') || preferredModel.startsWith('o1') || preferredModel.startsWith('o3')) {
        const text = await this.openaiService.chat([{ role: 'user', content: prompt }], options);
        yield { type: 'text', text };
      } else {
        try {
          yield* this.geminiService.streamTextWithThinking(prompt, options);
        } catch (e: any) {
          if (AbortUtils.isAbortError(e)) {
            this.logger.debug(`Gemini thinking stream cancelled by user`);
            throw e;
          }
          this.logger.error(`Gemini thinking stream failed: ${e.message}`);
          throw e;
        }
      }
    }).call(this);
    yield* AbortUtils.abortableStream(stream, options?.signal);
  }

  /**
   * Generates structured text using Zod
   */
  async structured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    schemaName: string,
    options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): Promise<T> {
    const promise = (async () => {
      try {
        // Structured currently uses OpenAI reliably in Zalo AI codebase
        return await this.openaiService.structured(prompt, schema, schemaName, options);
      } catch (e: any) {
        if (AbortUtils.isAbortError(e)) {
          this.logger.debug(`Structured generation cancelled by user`);
          throw e;
        }
        this.logger.error(`Structured generation failed: ${e.message}`);
        throw e;
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Generates structured text with real-time reasoning streaming
   */
  async structuredStream<T>(
    prompt: string,
    schema: ZodSchema<T>,
    schemaName: string,
    onThought: (chunk: string) => void,
    options?: { model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): Promise<T> {
    const promise = (async () => {
      try {
        return await this.openaiService.structuredStream(prompt, schema, schemaName, onThought, options);
      } catch (e: any) {
        if (AbortUtils.isAbortError(e)) {
          this.logger.debug(`Structured streaming generation cancelled by user`);
          throw e;
        }
        this.logger.error(`Structured streaming generation failed: ${e.message}`);
        throw e;
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Gets a LangChain model for LangGraph with optional tool binding and configured fallbacks.
   * Note: withFallbacks() may return a runnable that does not expose bindTools(),
   * so tools must be bound before composing the fallback chain.
   */
  getLangchainModel(options?: { temperature?: number; tools?: any[] }) {
    const keysConfig = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    const apiKeys = keysConfig.split(',').map(k => k.trim()).filter(Boolean);
    
    if (apiKeys.length === 0) {
      throw new Error('No Gemini API keys found in configuration.');
    }

    const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-2.5-flash');
    
    // Create primary model
    const primaryModel = new (ChatGoogleGenerativeAI as any)({
      model: modelName,
      apiKey: apiKeys[0],
      temperature: options?.temperature ?? 0,
    });
    const primaryRunnable = options?.tools?.length ? primaryModel.bindTools(options.tools) : primaryModel;

    // If multiple keys exist, build fallback chain
    if (apiKeys.length > 1) {
      const fallbackModels = apiKeys.slice(1).map((key) => {
        const model = new (ChatGoogleGenerativeAI as any)({
          model: modelName,
          apiKey: key,
          temperature: options?.temperature ?? 0,
          maxRetries: 1, // Only retry once per fallback to fail fast across rotation
        });
        return options?.tools?.length ? model.bindTools(options.tools) : model;
      });
      
      this.logger.log(`Initializing LangChain model with ${fallbackModels.length} fallbacks.`);
      return primaryRunnable.withFallbacks({ fallbacks: fallbackModels });
    }

    this.logger.log(`Initializing LangChain model with single API key (No fallbacks).`);
    return primaryRunnable;
  }
}
