import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, TaskType, GenerativeModel } from '@google/generative-ai';
import { AbortUtils } from './abort.utils';

@Injectable()
export class GeminiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private aiInstances: GoogleGenerativeAI[] = [];
  private currentKeyIndex = 0;

  constructor(private configService: ConfigService) {
    const keysConfig = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    const apiKeys = keysConfig.split(',').map(k => k.trim()).filter(Boolean);
    
    if (apiKeys.length === 0) {
      throw new Error('No Gemini API keys found in configuration.');
    }

    this.aiInstances = apiKeys.map(key => new GoogleGenerativeAI(key));
    this.logger.log(`GeminiService initialized with ${apiKeys.length} API keys for rotation.`);
  }

  private get nextAI(): GoogleGenerativeAI {
    const instance = this.aiInstances[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.aiInstances.length;
    return instance;
  }

  async onModuleInit() {
    this.logger.log('GeminiService ready for operation.');
  }

  /**
   * Embed text for semantic search indexing or querying.
   * @param text The text to embed
   * @param taskType The intent of embedding. Use RETRIEVAL_DOCUMENT for indexing, and RETRIEVAL_QUERY for searching.
   */
  async embed(text: string, taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT): Promise<number[]> {
    try {
      this.logger.debug(`Embedding text (${text.length} chars) with taskType: ${taskType}`);
      const model = this.nextAI.getGenerativeModel({
        model: this.configService.get<string>('GEMINI_EMBED_MODEL', 'text-embedding-004'),
      });

      const qdrantVectorSize = Number(this.configService.get('QDRANT_VECTOR_SIZE') ?? 768);
      const configuredOutputDimension = this.configService.get('GEMINI_EMBED_OUTPUT_DIMENSION');
      const outputDimensionality = configuredOutputDimension ? Number(configuredOutputDimension) : qdrantVectorSize;

      const result = await model.embedContent({
        content: { parts: [{ text }], role: 'user' },
        taskType: taskType,
        outputDimensionality,
      } as any);

      return result.embedding.values;
    } catch (err: any) {
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Gemini embedding cancelled by user`);
        throw err;
      }
      this.logger.error(`Gemini embedding failed: ${err.message}`);
      throw err;
    }
  }

  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    const promise = (async () => {
      const startTime = Date.now();
      try {
        this.logger.debug(`Calling Gemini LLM...`);

        const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash');
        const model = this.nextAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            maxOutputTokens: options?.maxTokens,
            temperature: options?.temperature ?? 0.7,
          },
        });

        const response = await model.generateContent(prompt);
        const content = response.response.text();

        const duration = Date.now() - startTime;
        this.logger.debug(`Gemini LLM responded in ${duration}ms`);

        return content;
      } catch (err: any) {
        if (AbortUtils.isAbortError(err)) {
          this.logger.debug(`Gemini generation cancelled by user after ${Date.now() - startTime}ms`);
          throw err;
        }
        this.logger.error(`Gemini generation failed after ${Date.now() - startTime}ms: ${err.message}`);
        throw err;
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  /**
   * Legacy compatibility wrapper: streams only the final text output.
   */
  async *streamText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncGenerator<string, void, unknown> {
    const stream = (async function* (this: GeminiService) {
      for await (const chunk of this.streamTextWithThinking(prompt, options)) {
        if (chunk.type === 'text') {
          yield chunk.text;
        }
      }
    }).call(this);
    yield* AbortUtils.abortableStream(stream, options?.signal);
  }

  async *streamTextWithThinking(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; thinkingBudget?: number; signal?: AbortSignal },
  ): AsyncGenerator<{ type: 'thought' | 'text'; text: string }, void, unknown> {
    const stream = (async function* (this: GeminiService) {
      const startTime = Date.now();
      try {
        this.logger.debug(`Streaming Gemini LLM with thinking...`);

        const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash');
        
        // Use thinking config if budget is provided or default to dynamic (-1)
        const thinkingConfig = {
          includeThoughts: true,
          thinkingBudget: options?.thinkingBudget ?? -1,
        };

        const model = this.nextAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            maxOutputTokens: options?.maxTokens,
            temperature: options?.temperature ?? 0.7,
            thinkingConfig,
          } as any,
        });

        const result = await model.generateContentStream(prompt);

        for await (const chunk of result.stream) {
          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;

          for (const part of candidate.content.parts) {
            if ((part as any).thought && part.text) {
              yield { type: 'thought', text: part.text };
            } else if (part.text) {
              yield { type: 'text', text: part.text };
            }
          }
        }

        const duration = Date.now() - startTime;
        this.logger.debug(`Gemini LLM stream with thinking completed in ${duration}ms`);
      } catch (err: any) {
        if (AbortUtils.isAbortError(err)) {
          this.logger.debug(`Gemini thinking stream cancelled by user after ${Date.now() - startTime}ms`);
          throw err;
        }
        this.logger.error(`Gemini thinking stream failed after ${Date.now() - startTime}ms: ${err.message}`);
        throw err;
      }
    }).call(this);
    yield* AbortUtils.abortableStream(stream, options?.signal);
  }
}
