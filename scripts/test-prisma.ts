import 'dotenv/config';
import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const prisma = app.get(PrismaService);
  const sessionId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();

  try {
    await prisma.aiSession.create({
      data: {
        id: sessionId,
        userId,
        conversationId,
        featureType: 'TRANSLATION',
        title: 'Prisma smoke test session',
        contextSnapshot: {
          messageId: randomUUID(),
          originalContent: 'Hello world',
          targetLanguage: 'vi',
          detectedLanguage: 'en',
        },
        isActive: true,
      },
    });

    await prisma.aiMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: 'Xin chao the gioi',
        metadata: {
          model: 'smoke-test',
          latencyMs: 1,
        },
      },
    });

    const storedSession = await prisma.aiSession.findUnique({
      where: { id: sessionId },
      include: { messages: true },
    });

    if (!storedSession || storedSession.messages.length !== 1) {
      throw new Error('Prisma smoke test failed to read back inserted records.');
    }

    console.log('Prisma smoke test succeeded.');
  } finally {
    await prisma.aiMessage.deleteMany({ where: { sessionId } });
    await prisma.aiSession.delete({ where: { id: sessionId } });
    await app.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});