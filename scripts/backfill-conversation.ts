// npx ts-node scripts/backfill-conversation.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GeminiService } from '../src/shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../src/shared/qdrant.service';
import { InternalClientService } from '../src/internal-client/internal-client.service';
import { Logger } from '@nestjs/common';

async function backfillConversation() {
  const logger = new Logger('BackfillConversation');
  const CONV_ID = '32cb3ae2-5fa9-42d4-9036-233651bd0edb';
  
  logger.log(`Starting prioritized backfill for conversation: ${CONV_ID}...`);

  const app = await NestFactory.createApplicationContext(AppModule);
  const gemini = app.get(GeminiService);
  const qdrant = app.get(QdrantService);
  const internalClient = app.get(InternalClientService);

  try {
    // We don't clear the collection here, just upsert (it will overwrite if exist)
    
    logger.log(`Fetching messages for ${CONV_ID}...`);
    const messages = await internalClient.getMessages({ 
      conversationId: CONV_ID,
      limit: 200 // Get all of them (seed was 100)
    });

    if (!messages || messages.length === 0) {
      logger.error('No messages found for this conversation in DB.');
      return;
    }

    logger.log(`Found ${messages.length} messages. Embedding...`);

    let processed = 0;
    for (const msg of messages) {
      const text = msg.content || '';
      if (text.trim().length < 3) continue;

      const messageId = msg.id.toString();
      const vector = await gemini.embed(text, TaskType.RETRIEVAL_DOCUMENT);
      
      await qdrant.upsert(messageId, vector, {
        conversationId: CONV_ID,
        userId: msg.senderId,
        text,
        createdAt: msg.createdAt,
      });

      processed++;
      if (processed % 10 === 0) {
        logger.log(`Progress: ${processed}/${messages.length} indexed...`);
      }
    }

    logger.log(`SUCCESS: Prioritized backfill complete. Total: ${processed} messages indexed.`);
  } catch (err: any) {
    logger.error(`Failed: ${err.message}`);
  } finally {
    await app.close();
    process.exit(0);
  }
}

backfillConversation();
