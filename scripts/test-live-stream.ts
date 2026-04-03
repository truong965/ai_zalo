import axios from 'axios';
import Redis from 'ioredis';
import 'dotenv/config';

/**
 * 🧪 AI STREAMING TESTER
 * 
 * This script verifies the UX of your AI Agent by:
 * 1. Listening to Redis PubSub (exactly like the Main Backend does).
 * 2. Triggering a streaming request via HTTP.
 * 3. Printing chunks in real-time to demonstrate the "typing" effect.
 */

// Load from .env
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) || 6380;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'password123';
const REDIS_DB = Number(process.env.REDIS_DB) || 0;

const API_URL = 'http://localhost:3001/bot/trigger';
const API_KEY = process.env.INTERNAL_API_KEY || 'dev-internal-key';

async function testStreaming() {
  const conversationId = '32cb3ae2-5fa9-42d4-9036-233651bd0edb'; // Seeded conversation
  const userId = 'c33c3638-3d91-4f0e-ac84-6380188c4d37';
  const question = 'Lead đề xuất công nghệ gì cho Backend?';

  console.log(`🔗 Connecting to Redis at ${REDIS_HOST}:${REDIS_PORT} (DB: ${REDIS_DB})...`);
  
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    db: REDIS_DB
  });

  const channel = `bot-stream:${conversationId}`;

  redis.subscribe(channel, (err) => {
    if (err) {
      console.error('❌ Failed to subscribe to Redis:', err.message);
      process.exit(1);
    }
    console.log(`📡 Listening for chunks on channel: ${channel}`);
  });

  redis.on('message', (chan, message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'start') {
        process.stdout.write('\n🤖 AI is thinking... \n\n');
      } else if (data.event === 'chunk') {
        process.stdout.write(data.text);
      } else if (data.event === 'done') {
        process.stdout.write('\n\n✅ Stream complete.\n');
        redis.quit();
        process.exit(0);
      }
    } catch (e) {
      console.log('\n[RAW]:', message);
    }
  });

  console.log(`🚀 Sending ASK request (Streaming: true)...`);
  try {
    const response = await axios.post(API_URL, {
      type: 'ask',
      conversationId,
      userId,
      text: question,
      stream: true
    }, {
      headers: { 'x-internal-api-key': API_KEY }
    });

    console.log('📥 Initial Response:', response.data);
    console.log('⏳ Waiting for chunks from Redis...\n');

  } catch (err: any) {
    console.error('❌ API Request failed:', err.response?.data || err.message);
    redis.quit();
    process.exit(1);
  }
}

testStreaming();
