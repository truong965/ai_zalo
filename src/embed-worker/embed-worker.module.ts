import { Module } from '@nestjs/common';
import { EmbedWorkerProcessor } from './embed-worker.processor';
import { EmbedWorkerService } from './embed-worker.service';
import { InternalClientModule } from '../internal-client/internal-client.module';

@Module({
  imports: [InternalClientModule],
  providers: [EmbedWorkerProcessor, EmbedWorkerService],
})
export class EmbedWorkerModule {}
