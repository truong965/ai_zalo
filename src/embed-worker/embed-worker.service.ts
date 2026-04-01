import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../shared/qdrant.service';
import { InternalClientService } from '../internal-client/internal-client.service';

@Injectable()
export class EmbedWorkerService {
  private readonly logger = new Logger(EmbedWorkerService.name);

  constructor(
    private readonly geminiService: GeminiService,
    private readonly qdrantService: QdrantService,
  ) {}

  async handleEmbedMessage(data: { messageId: string; conversationId: string; userId: string; text: string; createdAt: string }) {
    if (!data.text || data.text.trim().length < 5) {
      this.logger.debug(`Skipping message ${data.messageId}: text too short or empty.`);
      return;
    }

    this.logger.debug(`Indexing message ${data.messageId} with Gemini text-embedding-004...`);
    try {
      // 1. Generate embedding using Gemini (TaskType.RETRIEVAL_DOCUMENT for indexing)
      const vector = await this.geminiService.embed(data.text, TaskType.RETRIEVAL_DOCUMENT);

      // 2. Upsert to Qdrant (save exact metadata)
      await this.qdrantService.upsert(data.messageId, vector, {
        conversationId: data.conversationId,
        userId: data.userId,
        text: data.text,
        sender: 'User',
        createdAt: data.createdAt,
      });

      this.logger.log(`Successfully indexed message ${data.messageId}.`);
    } catch (err: any) {
      this.logger.error(`Failed to index message ${data.messageId}: ${err.message}`);
      throw err;
    }
  }
}
