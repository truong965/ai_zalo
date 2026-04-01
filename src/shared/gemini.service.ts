import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, TaskType, GenerativeModel } from '@google/generative-ai';

@Injectable()
export class GeminiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private ai: GoogleGenerativeAI;
  private embeddingModel: GenerativeModel;
  private llmModel: GenerativeModel;
  private embeddingOutputDimensionality?: number;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    this.ai = new GoogleGenerativeAI(apiKey);

    // Default fast models
    const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash');
    this.llmModel = this.ai.getGenerativeModel({
      model: modelName,
    });

    const embedModelName = this.configService.get<string>('GEMINI_EMBED_MODEL', 'text-embedding-004');
    this.embeddingModel = this.ai.getGenerativeModel({
      model: embedModelName,
    });

    const qdrantVectorSize = Number(this.configService.get('QDRANT_VECTOR_SIZE') ?? 768);
    const configuredOutputDimension = this.configService.get('GEMINI_EMBED_OUTPUT_DIMENSION');
    this.embeddingOutputDimensionality = configuredOutputDimension
      ? Number(configuredOutputDimension)
      : qdrantVectorSize;
  }

  async onModuleInit() {
    this.logger.log('GeminiService initialized with GoogleGenerativeAI SDK.');
  }

  /**
   * Embed text for semantic search indexing or querying.
   * @param text The text to embed
   * @param taskType The intent of embedding. Use RETRIEVAL_DOCUMENT for indexing, and RETRIEVAL_QUERY for searching.
   */
  async embed(text: string, taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT): Promise<number[]> {
    try {
      this.logger.debug(`Embedding text (${text.length} chars) with taskType: ${taskType}`);
      const result = await this.embeddingModel.embedContent({
        content: { parts: [{ text }], role: 'user' },
        taskType: taskType,
        outputDimensionality: this.embeddingOutputDimensionality,
      } as any);

      return result.embedding.values;
    } catch (err: any) {
      this.logger.error(`Gemini embedding failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate a completion string synchronously.
   */
  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const startTime = Date.now();
    try {
      this.logger.debug(`Calling Gemini LLM...`);

      // Override config transiently if necessary
      const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash');
      const model = this.ai.getGenerativeModel({
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
      this.logger.error(`Gemini generation failed after ${Date.now() - startTime}ms: ${err.message}`);
      throw err;
    }
  }

  /**
   * Generate a completion string using Server-Sent Events (Streaming)
   */
  async *streamText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncGenerator<string, void, unknown> {
    const startTime = Date.now();
    try {
      this.logger.debug(`Streaming Gemini LLM...`);

      const modelName = this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash');
      const model = this.ai.getGenerativeModel({
        model: modelName,
        generationConfig: {
          maxOutputTokens: options?.maxTokens,
          temperature: options?.temperature ?? 0.7,
        },
      });

      const result = await model.generateContentStream(prompt);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
      }

      const duration = Date.now() - startTime;
      this.logger.debug(`Gemini LLM stream completed in ${duration}ms`);
    } catch (err: any) {
      this.logger.error(`Gemini stream failed after ${Date.now() - startTime}ms: ${err.message}`);
      throw err;
    }
  }
}
