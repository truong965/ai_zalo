import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatGroq } from '@langchain/groq';
import { AbortUtils } from './abort.utils';

@Injectable()
export class GroqService implements OnModuleInit {
  private readonly logger = new Logger(GroqService.name);
  private model: ChatGroq;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!apiKey) {
      this.logger.warn('GROQ_API_KEY is missing. GroqService will fail if called.');
      return;
    }

    const modelName = this.configService.get<string>('GROQ_LLM_MODEL', 'llama-3.3-70b-versatile');
    this.model = new ChatGroq({
      apiKey,
      model: modelName,
      temperature: 0.7,
      maxRetries: 1, // Fail fast on 503/429
    });

    this.logger.log(`GroqService initialized with model: ${modelName}`);
  }

  getLangchainModel(options?: { temperature?: number }) {
    if (!this.model) {
      throw new Error('Groq model is not initialized. Missing API key?');
    }
    
    if (options?.temperature !== undefined) {
      const apiKey = this.configService.getOrThrow<string>('GROQ_API_KEY');
      const modelName = this.configService.get<string>('GROQ_LLM_MODEL', 'llama-3.3-70b-versatile');
      return new ChatGroq({
        apiKey,
        model: modelName,
        temperature: options.temperature,
      });
    }

    return this.model;
  }

  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    if (!this.model) {
      throw new Error('Groq model is not initialized.');
    }

    const promise = (async () => {
      const startTime = Date.now();
      try {
        this.logger.debug(`Calling Groq LLM...`);

        const chatModel = options?.temperature !== undefined || options?.maxTokens !== undefined 
          ? this.getLangchainModel({ temperature: options?.temperature }) 
          : this.model;

        const response = await chatModel.invoke([
          { role: 'user', content: prompt }
        ]);

        const content = response.content.toString();
        const duration = Date.now() - startTime;
        this.logger.debug(`Groq LLM responded in ${duration}ms`);

        return content;
      } catch (err: any) {
        if (AbortUtils.isAbortError(err)) {
          this.logger.debug(`Groq generation cancelled after ${Date.now() - startTime}ms`);
          throw err;
        }
        this.logger.error(`Groq generation failed after ${Date.now() - startTime}ms: ${err.message}`);
        throw err;
      }
    })();
    return AbortUtils.withAbort(promise, options?.signal);
  }

  async *streamText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncGenerator<string, void, unknown> {
    if (!this.model) {
      throw new Error('Groq model is not initialized.');
    }

    const stream = (async function* (this: GroqService) {
      const startTime = Date.now();
      try {
        this.logger.debug(`Streaming Groq LLM...`);

        const chatModel = options?.temperature !== undefined || options?.maxTokens !== undefined 
          ? this.getLangchainModel({ temperature: options?.temperature }) 
          : this.model;

        const responseStream = await chatModel.stream([
          { role: 'user', content: prompt }
        ]);

        for await (const chunk of responseStream) {
          if (chunk.content) {
            yield chunk.content.toString();
          }
        }

        const duration = Date.now() - startTime;
        this.logger.debug(`Groq LLM stream completed in ${duration}ms`);
      } catch (err: any) {
        if (AbortUtils.isAbortError(err)) {
          this.logger.debug(`Groq stream cancelled after ${Date.now() - startTime}ms`);
          throw err;
        }
        this.logger.error(`Groq stream failed after ${Date.now() - startTime}ms: ${err.message}`);
        throw err;
      }
    }).call(this);

    yield* AbortUtils.abortableStream(stream, options?.signal);
  }
}
