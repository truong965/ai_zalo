import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { GeminiService } from '../src/shared/gemini.service';
import { TaskType } from '@google/generative-ai';
import { QdrantService } from '../src/shared/qdrant.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const qdrant = app.get(QdrantService);
  const gemini = app.get(GeminiService);

  const query = "Chúng ta đang bàn về dự án gì? tiến độ đang tới giai đoạn nào? ";
  console.log('Question:', query);
  
  const queryVector = await gemini.embed(query, TaskType.RETRIEVAL_QUERY);

  try {
    // Note: qdrant.search normally uses score_threshold: 0.5. 
    // We will query qdrant client directly to see actual scores without threshold.
    const rawClient = (qdrant as any).client;
    
    const results = await rawClient.search('chat_messages', {
        vector: queryVector,
        filter: {
          must: [
            {
              key: 'conversationId',
              match: {
                value: '32cb3ae2-5fa9-42d4-9036-233651bd0edb',
              },
            },
          ],
        },
        limit: 5,
        with_payload: true,
      });
      
      console.log('Top match scores for this conversation:');
      for (const r of results) {
          console.log(`- Score: ${r.score} | Text: ${r.payload.text}`);
      }
      
  } catch(e) {
      console.error(e);
  } finally {
      await app.close();
  }
}

main().catch(console.error);
