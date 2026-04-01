import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import * as dotenv from 'dotenv';
dotenv.config();

async function testEmbedding() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not found');
    return;
  }

  const ai = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004';
  const model = ai.getGenerativeModel({ model: modelName });

  const text = 'Dự án Zalo Clone đã và đang xử dụng những công nghệ gì?';
  
  console.log(`Testing model: ${modelName}`);
  
  try {
    const result = await model.embedContent({
      content: { parts: [{ text }], role: 'user' },
      taskType: TaskType.RETRIEVAL_QUERY,
    });

    console.log(`Vector length: ${result.embedding.values.length}`);
    console.log(`First 5 values: ${result.embedding.values.slice(0, 5)}`);
  } catch (err) {
    console.error('Embedding failed:', err);
  }
}

testEmbedding();
