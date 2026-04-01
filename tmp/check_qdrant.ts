import { QdrantClient } from '@qdrant/js-client-rest';
import * as dotenv from 'dotenv';
dotenv.config();

async function checkQdrant() {
  const url = process.env.QDRANT_URL;
  const apiKey = process.env.QDRANT_API_KEY;
  const collectionName = process.env.QDRANT_COLLECTION_NAME || 'chat_messages';

  if (!url || !apiKey) {
    console.error('QDRANT_URL or QDRANT_API_KEY not found');
    return;
  }

  const client = new QdrantClient({ url, apiKey });

  try {
    const info = await client.getCollection(collectionName);
    console.log(`Collection: ${collectionName}`);
    console.log(`Vector Config:`, JSON.stringify(info.config.params.vectors, null, 2));
    console.log(`Points Count: ${info.points_count}`);
  } catch (err) {
    console.error('Failed to get collection info:', err);
  }
}

checkQdrant();
