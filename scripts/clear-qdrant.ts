// npx ts-node scripts/clear-qdrant.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { QdrantService } from '../src/shared/qdrant.service';
import { Logger } from '@nestjs/common';

async function clearQdrant() {
  const logger = new Logger('ClearQdrant');
  logger.log('Starting full cleanup of Qdrant collection...');

  const app = await NestFactory.createApplicationContext(AppModule);
  const qdrant = app.get(QdrantService);

  try {
    await qdrant.clearCollection();
    logger.log('SUCCESS: Qdrant collection has been wiped and reset.');
  } catch (err: any) {
    logger.error(`FAILED to clear collection: ${err.message}`);
  } finally {
    await app.close();
    process.exit(0);
  }
}

clearQdrant();
