import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

async function debugSearch() {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  const collectionName = process.env.QDRANT_COLLECTION_NAME || 'chat_messages';
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!url || !apiKey || !geminiKey) {
    console.error('Missing config');
    return;
  }

  const client = new QdrantClient({ url, apiKey });
  const ai = new GoogleGenerativeAI(geminiKey);
  const model = ai.getGenerativeModel({ model: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001' });

  const conversationId = '32cb3ae2-5fa9-42d4-9036-233651bd0edb';
  const text = 'Dự án Zalo Clone';

  try {
    console.log('Embedding query...');
    const result = await model.embedContent({
      content: { parts: [{ text }], role: 'user' },
      taskType: TaskType.RETRIEVAL_QUERY,
    });
    const vector = result.embedding.values;
    console.log(`Vector length: ${vector.length}`);

    console.log('Searching Qdrant...');
    const searchRes = await client.search(collectionName, {
      vector: vector,
      filter: {
        must: [
          {
            key: 'conversationId',
            match: {
              value: conversationId,
            },
          },
        ],
      },
      limit: 10,
    });
    console.log('Search successful:', searchRes.length, 'results');
  } catch (err: any) {
    console.error('Search failed:');
    if (err.response && err.response.data) {
      console.error(JSON.stringify(err.response.data, null, 2));
    } else {
      console.error(err.message);
      console.error(err);
    }
  }
}

debugSearch();
