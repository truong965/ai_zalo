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
    private readonly internalClient: InternalClientService,
  ) {}

  async handleEmbedMessage(data: { 
    messageId: string; 
    conversationId: string; 
    userId: string; 
    text: string; 
    senderName?: string;
    createdAt: string 
  }) {
    if (!data.text || data.text.trim().length < 2) {
      this.logger.debug(`Skipping message ${data.messageId}: text too short.`);
      return;
    }

    try {
      let displayName = data.senderName || 'User';

      const recentMessagesRaw = await this.internalClient.getMessages({
        conversationId: data.conversationId,
        limit: 3,
        sort: 'desc',
        userId: data.userId,
      });

      const historyRaw = ((recentMessagesRaw as any[]) || []);
      // 1. Remove current message if it's already in history (prevents duplication)
      // and reverse to get chronological order [oldest -> newest]
      const history = historyRaw
        .filter(m => m.id.toString() !== data.messageId.toString())
        .reverse();
      
      // 2. Build the window text (Current message + recent context)
      // This helps capturing the conversation flow in the embedding
      const contextText = history
        .map(m => `${m.sender?.displayName || m.displayName || 'Thành viên'}: ${m.content || m.text}`)
        .join('\n');
      
      const currentText = `${displayName}: ${data.text}`;
      const windowText = contextText ? `${contextText}\n${currentText}` : currentText;

      this.logger.debug(`Indexing message ${data.messageId} with context window...`);

      // 3. Generate embedding for the window
      const vector = await this.geminiService.embed(windowText, TaskType.RETRIEVAL_DOCUMENT);

      // 4. Upsert to Qdrant with rich payload
      await this.qdrantService.upsert(data.messageId, vector, {
        conversationId: data.conversationId,
        userId: data.userId,
        text: data.text,          // Original text for BM25/Exact match
        windowText: windowText,   // Contextual text for display/Rerank
        displayName: displayName,
        createdAt: data.createdAt,
      });

      this.logger.log(`Successfully indexed message ${data.messageId} (Window size: ${windowText.length} chars).`);
    } catch (err: any) {
      this.logger.error(`Failed to index message ${data.messageId}: ${err.message}`);
      throw err;
    }
  }
}
