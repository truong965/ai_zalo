import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIService } from './openai.service';
import { GeminiService } from './gemini.service';
import { GroqService } from './groq.service';
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
    private groqService: GroqService,
  ) {}

  private getProvider(options?: { model?: string }): 'gemini' | 'groq' | 'openai' {
    const preferredModel = options?.model;
    if (preferredModel) {
      if (preferredModel.startsWith('gpt') || preferredModel.startsWith('o1') || preferredModel.startsWith('o3')) {
        return 'openai';
      }
      if (preferredModel.startsWith('llama') || preferredModel.startsWith('mixtral')) {
        return 'groq';
      }
    }
    const defaultProvider = this.configService.get<string>('DEFAULT_LLM_PROVIDER', 'gemini');
    return defaultProvider as 'gemini' | 'groq' | 'openai';
  }

  private getFallbackProvider(current: 'gemini' | 'groq' | 'openai'): 'gemini' | 'groq' | 'openai' {
    const fallback = this.configService.get<string>('FALLBACK_LLM_PROVIDER', 'groq');
    if (fallback === current) {
      return fallback === 'gemini' ? 'groq' : 'gemini';
    }
    return fallback as 'gemini' | 'groq' | 'openai';
  }

  private callServiceGeneration(provider: 'gemini' | 'groq' | 'openai', prompt: string, options?: { maxTokens?: number; temperature?: number; model?: string; signal?: AbortSignal }): Promise<string> {
      switch (provider) {
        case 'openai':
          return this.openaiService.chat([{ role: 'user', content: prompt }], options);
        case 'groq':
          return this.groqService.generateText(prompt, options);
        case 'gemini':
        default:
          return this.geminiService.generateText(prompt, options);
      }
  }

  /**
   * Generates text with automatic provider fallback
   */
  async generateText(prompt: string, options?: { maxTokens?: number; temperature?: number; model?: string; signal?: AbortSignal }): Promise<string> {
    const promise = (async () => {
      const provider = this.getProvider(options);
      
      try {
        return await this.callServiceGeneration(provider, prompt, options);
      } catch (e: any) {
        if (AbortUtils.isAbortError(e)) throw e;
        
        const fallback = this.getFallbackProvider(provider);
        this.logger.warn(`Primary provider ${provider} failed: ${e.message}, falling back to ${fallback}`);
        return await this.callServiceGeneration(fallback, prompt, options);
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Streams text matching the configured fallback strategy.
   * If provider does not support stream with thoughts, it uses normal streaming.
   */
  async *streamText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string; signal?: AbortSignal },
  ): AsyncGenerator<string, void, unknown> {
    const stream = (async function* (this: LlmGatewayService) {
      const provider = this.getProvider(options);
      try {
         if (provider === 'gemini') {
            for await (const chunk of this.geminiService.streamText(prompt, options)) {
               yield chunk;
            }
         } else if (provider === 'groq') {
            for await (const chunk of this.groqService.streamText(prompt, options)) {
               yield chunk;
            }
         } else {
             const text = await this.openaiService.chat([{ role: 'user', content: prompt }], options);
             yield text;
         }
      } catch (e: any) {
          if (AbortUtils.isAbortError(e)) throw e;
          const fallback = this.getFallbackProvider(provider);
          this.logger.warn(`Primary provider stream ${provider} failed: ${e.message}, falling back to ${fallback}`);
          
          if (fallback === 'gemini') {
             for await (const chunk of this.geminiService.streamText(prompt, options)) {
               yield chunk;
             }
          } else {
             for await (const chunk of this.groqService.streamText(prompt, options)) {
               yield chunk;
             }
          }
      }
    }).call(this);
    yield* AbortUtils.abortableStream(stream, options?.signal);
  }

  /**
   * Streams text with native reasoning chunks
   * Only Gemini inherently supports streaming native thoughts right now in this wrapper.
   */
  async *streamTextWithThinking(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string; thinkingBudget?: number; signal?: AbortSignal },
  ): AsyncGenerator<{ type: 'thought' | 'text'; text: string }, void, unknown> {
    const stream = (async function* (this: LlmGatewayService) {
      const provider = this.getProvider(options);
      
      if (provider !== 'gemini') {
         // Gracefully fallback to text chunk only format for non-reasoning providers like Groq Llama 3.3
         this.logger.debug(`Provider ${provider} selected, thinking chunks will fallback to plain text execution.`);
         for await (const text of this.streamText(prompt, options)) {
            yield { type: 'text', text };
         }
         return;
      }

      try {
        yield* this.geminiService.streamTextWithThinking(prompt, options);
      } catch (e: any) {
        if (AbortUtils.isAbortError(e)) throw e;
        const fallback = this.getFallbackProvider('gemini');
        this.logger.warn(`Gemini thinking stream failed: ${e.message}, falling back to regular streaming on ${fallback}`);
        
        for await (const text of this.streamText(prompt, { ...options, model: fallback === 'groq' ? 'llama-3.3-70b-versatile' : undefined })) {
            yield { type: 'text', text };
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
        return await this.openaiService.structured(prompt, schema, schemaName, options);
      } catch (e: any) {
        if (AbortUtils.isAbortError(e)) throw e;
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
        if (AbortUtils.isAbortError(e)) throw e;
        this.logger.error(`Structured streaming generation failed: ${e.message}`);
        throw e;
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Gets a LangChain model for LangGraph with optional tool binding and configured fallbacks.
   */
  getLangchainModel(options?: { temperature?: number; tools?: any[]; structuredSchema?: ZodSchema<any>; structuredName?: string }) {
    const provider = this.getProvider();
    
    let primaryRunnable;
    let fallbackRunnables: any[] = [];

    // Setup Gemini Primary Config
    const geminiKeysConfig = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    const geminiApiKeys = geminiKeysConfig.split(',').map(k => k.trim()).filter(Boolean);
    const geminiModelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-2.5-flash');

    const geminiRunnableFactory = (key: string) => {
        let m: any = new (ChatGoogleGenerativeAI as any)({
          model: geminiModelName,
          apiKey: key,
          temperature: options?.temperature ?? 0,
          maxRetries: 1,
        });
        if (options?.structuredSchema) {
          m = m.withStructuredOutput(options.structuredSchema, { name: options.structuredName || 'output' });
        }
        return options?.tools?.length ? m.bindTools(options.tools) : m;
    };

    // Setup Groq Fallback Config
    const groqRunnableFactory = () => {
        try {
           let groqModel: any = this.groqService.getLangchainModel({ temperature: options?.temperature ?? 0 });
           if (options?.structuredSchema) {
             groqModel = groqModel.withStructuredOutput(options.structuredSchema, { name: options.structuredName || 'output' });
           }
           return options?.tools?.length ? groqModel.bindTools(options.tools) : groqModel;
        } catch {
            return null; // Groq key missing
        }
    };

    if (provider === 'gemini') {
        const geminiModels = geminiApiKeys.map(key => geminiRunnableFactory(key));
        primaryRunnable = geminiModels[0];
        fallbackRunnables = geminiModels.slice(1);
        
        const groq = groqRunnableFactory();
        if (groq) fallbackRunnables.push(groq);

    } else if (provider === 'groq') {
        primaryRunnable = groqRunnableFactory() || geminiRunnableFactory(geminiApiKeys[0]);
        if (primaryRunnable !== geminiRunnableFactory(geminiApiKeys[0])) {
            fallbackRunnables = geminiApiKeys.map(key => geminiRunnableFactory(key));
        }
    } else {
         primaryRunnable = geminiRunnableFactory(geminiApiKeys[0]);
    }

    if (fallbackRunnables.length > 0) {
      this.logger.log(`Initializing LangChain model with ${fallbackRunnables.length} fallbacks.`);
      return primaryRunnable.withFallbacks({ fallbacks: fallbackRunnables });
    }

    this.logger.log(`Initializing LangChain model with single provider (No fallbacks).`);
    return primaryRunnable;
  }
}
