import { QdrantClient } from '@qdrant/js-client-rest';
import * as fs from 'fs';

const client = new QdrantClient({
  url: 'https://2785db18-5417-4bdf-a7a2-bf786b0131b3.europe-west3-0.gcp.cloud.qdrant.io',
  apiKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2Nlc3MiOiJtIn0.Ku9Vt-cZvflgeddd8V0XbP0EhWif6_Cr5bMX3HLOjmE',
});

async function main() {
  try {
    const info = await client.getCollection('chat_messages');
    
    // Count points for convo using points filter counting if possible, or scroll
    const res = await client.scroll('chat_messages', {
      filter: {
        must: [
          {
            key: 'conversationId',
            match: {
              value: '32cb3ae2-5fa9-42d4-9036-233651bd0edb'
            }
          }
        ]
      },
      limit: 100,
      with_payload: true,
      with_vector: false
    });

    const output = {
      points_count: info.points_count,
      conversationPointsCount: res.points.length,
      sampleConversationPoints: res.points.map(p => p.payload?.text)
    };

    fs.writeFileSync('qdrant-output.json', JSON.stringify(output, null, 2));
    console.log('Written to qdrant-output.json');
  } catch(e) {
    console.error(e);
  }
}

main();
