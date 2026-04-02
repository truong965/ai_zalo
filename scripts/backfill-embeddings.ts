import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GeminiService } from '../src/shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../src/shared/qdrant.service';
import { InternalClientService } from '../src/internal-client/internal-client.service';
import { Logger } from '@nestjs/common';

async function backfill() {
  const logger = new Logger('BackfillScript');
  logger.log('Starting backfill of conversation embeddings...');

  const app = await NestFactory.createApplicationContext(AppModule);
  const gemini = app.get(GeminiService);
  const qdrant = app.get(QdrantService);
  const internalClient = app.get(InternalClientService);

  const PAGE_SIZE = 50;
  let offset = 0;
  let processed = 0;

  try {
    // Phase 1: Clear existing data to avoid duplicates
    logger.warn('Cleaning up existing embeddings before starting backfill...');
    await qdrant.clearCollection();

    // Phase 2: Iterate through all messages in ascending order to build windows
    const windowBuffers = new Map<string, any[]>(); // conversationId -> MessageBuffer (last 3)

    while (true) {
      logger.log(`Fetching messages from Backend (offset: ${offset}, limit: ${PAGE_SIZE}, sort: asc)...`);
      
      const messages = await internalClient.getMessages({ 
        limit: PAGE_SIZE,
        offset: offset,
        sort: 'asc',
      });

      if (!messages || messages.length === 0) break;

      for (const msg of messages) {
        try {
          const text = msg.content || msg.text || '';
          if (text.trim().length < 2) continue;

          const conversationId = msg.conversationId;
          const messageId = msg.id.toString();
          
          // Get previous 3 messages for this conversation to build window
          let buffer = windowBuffers.get(conversationId) || [];
          
          const contextText = buffer
            .map(m => `${m.sender?.displayName || m.senderId || 'User'}: ${m.content || m.text}`)
            .join('\n');
          
          const senderName = msg.sender?.displayName || msg.senderId || 'User';
          const currentText = `${senderName}: ${text}`;
          const windowText = contextText ? `${contextText}\n${currentText}` : currentText;

          // Generate vector for the window
          const vector = await gemini.embed(windowText, TaskType.RETRIEVAL_DOCUMENT);
          
          // Save to Qdrant with rich payload
          await qdrant.upsert(messageId, vector, {
            conversationId,
            userId: msg.senderId,
            text: text,                // Original for BM25
            windowText: windowText,    // Contextual for display/Rerank
            senderName,
            createdAt: msg.createdAt,
          });

          // Update sliding window buffer
          buffer.push(msg);
          if (buffer.length > 3) buffer.shift();
          windowBuffers.set(conversationId, buffer);

          processed++;
          if (processed % 10 === 0) logger.log(`Progress: ${processed} messages indexed...`);

          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (err: any) {
          logger.error(`Error processing message ${msg.id}: ${err.message}`);
        }
      }

      if (messages.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    logger.log(`\x1b[32mSUCCESS: Backfill complete. Total processed: ${processed} messages.\x1b[0m`);
  } catch (err: any) {
    logger.error(`FATAL: Backfill failed: ${err.message}`);
  } finally {
    await app.close();
    process.exit(0);
  }
}

backfill();
