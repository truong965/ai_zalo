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
    const buffers = new Map<string, any[]>(); // conversationId -> MessageBuffer

    while (true) {
      logger.log(`Fetching messages from Backend (offset: ${offset}, limit: ${PAGE_SIZE}, sort: asc)...`);
      
      const messages = await internalClient.getMessages({ 
        limit: PAGE_SIZE,
        offset: offset,
        sort: 'asc',
      });

      if (!messages || messages.length === 0) {
        logger.log('Reached the end of message history.');
        break;
      }

      logger.log(`Batch received: ${messages.length} messages. Processing windows...`);

      for (const msg of messages) {
        try {
          const text = msg.content || '';
          if (text.trim().length < 2) continue; // Allow shorter messages in windows

          const conversationId = msg.conversationId;
          const messageId = msg.id.toString();
          const userId = msg.senderId;
          const createdAt = msg.createdAt;
          
          // Generate vector for the individual message context
          const vector = await gemini.embed(text, TaskType.RETRIEVAL_DOCUMENT);
          
          // Save to Qdrant
          await qdrant.upsert(messageId, vector, {
            conversationId,
            userId,
            text,
            sender: msg.sender?.displayName || msg.senderId || 'User',
            createdAt,
          });

          processed++;
          
          if (processed % 10 === 0) {
            logger.log(`Progress: ${processed} messages indexed...`);
          }

          // Small throttle
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (err: any) {
          logger.error(`Error processing message ${msg.id}: ${err.message}`);
        }
      }

      // If we got fewer messages than requested, we've hit the end
      if (messages.length < PAGE_SIZE) {
        logger.log('All available messages have been processed.');
        break;
      }

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
