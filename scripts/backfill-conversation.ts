// npx ts-node scripts/backfill-conversation.ts
//npm run backfill-conv 32cb3ae2-5fa9-42d4-9036-233651bd0edb
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GeminiService } from '../src/shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../src/shared/qdrant.service';
import { InternalClientService } from '../src/internal-client/internal-client.service';
import { Logger } from '@nestjs/common';

async function backfillConversation() {
  const logger = new Logger('BackfillConversation');

  // Usage: npm run backfill-conv <CONV_ID> [--clear]
  const args = process.argv.slice(2);
  const CONV_ID = args[0] || '32cb3ae2-5fa9-42d4-9036-233651bd0edb';
  const shouldClear = args.includes('--clear');

  logger.log(`Starting prioritized backfill for conversation: ${CONV_ID}...`);
  if (shouldClear) logger.warn('CLEAR flag detected. Resetting entire collection first.');

  const app = await NestFactory.createApplicationContext(AppModule);
  const gemini = app.get(GeminiService);
  const qdrant = app.get(QdrantService);
  const internalClient = app.get(InternalClientService);

  try {
    if (shouldClear) {
      await qdrant.clearCollection();
    }

    logger.log(`Fetching messages for ${CONV_ID} (ascending to build windows)...`);
    const messages = await internalClient.getMessages({
      conversationId: CONV_ID,
      limit: 500, // Reasonable limit for a single conversation
      sort: 'asc', // Important for windowing
    });

    if (!messages || messages.length === 0) {
      logger.error('No messages found for this conversation in DB.');
      await app.close();
      return;
    }

    logger.log(`Found ${messages.length} messages. Embedding with Sliding Window (3 msgs)...`);

    const buffer: any[] = [];
    let processed = 0;

    for (const msg of messages) {
      try {
        const text = msg.content || msg.text || '';
        if (text.trim().length < 2) continue;

        const messageId = msg.id.toString();

        // Build window text
        const contextText = buffer
          .map(m => `${m.sender?.displayName || m.displayName || 'Thành viên'}: ${m.content || m.text}`)
          .join('\n');

        // Never fallback to UUID as sender name.
        const displayName = msg.sender?.displayName || 'Thành viên';
        const currentText = `${displayName}: ${text}`;
        const windowText = contextText ? `${contextText}\n${currentText}` : currentText;

        // Generate vector for the window
        const vector = await gemini.embed(windowText, TaskType.RETRIEVAL_DOCUMENT);

        // Save to Qdrant
        await qdrant.upsert(messageId, vector, {
          conversationId: CONV_ID,
          userId: msg.senderId,
          text: text,                // Original for BM25
          windowText: windowText,    // Contextual for display/Rerank
          displayName,
          createdAt: msg.createdAt,
        });

        // Update buffer
        buffer.push({ ...msg, displayName });
        if (buffer.length > 3) buffer.shift();

        processed++;
        if (processed % 10 === 0) {
          logger.log(`Progress: ${processed}/${messages.length} messages indexed...`);
        }

        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (err: any) {
        logger.error(`Error processing message ${msg.id}: ${err.message}`);
      }
    }

    logger.log(`\x1b[32mSUCCESS: Backfill complete for ${CONV_ID}. Total: ${processed} messages indexed.\x1b[0m`);
  } catch (err: any) {
    logger.error(`Failed: ${err.message}`);
  } finally {
    await app.close();
    process.exit(0);
  }
}

backfillConversation();
