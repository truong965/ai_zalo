import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { InternalClientService } from '../src/internal-client/internal-client.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const internalClient = app.get(InternalClientService);
  
  try {
    const messages = await internalClient.getMessages({ 
      conversationId: '32cb3ae2-5fa9-42d4-9036-233651bd0edb',
      limit: 10, 
      offset: 0 
    });
    console.log(`Found ${messages.length} messages for convo`);
    if (messages.length > 0) {
      console.log('Sample message:', messages[0]);
    }
  } catch (err) {
    console.error('Error fetching messages:', err);
  } finally {
    await app.close();
  }
}

main().catch(console.error);
