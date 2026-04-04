import { Module } from '@nestjs/common';
import { AskService } from './ask.service';
import { RetrieverService } from './retriever.service';
import { SharedModule } from '../shared/shared.module';
import { InternalClientModule } from '../internal-client/internal-client.module';
import { SummaryModule } from '../summary/summary.module';
import { SessionModule } from '../sessions/session.module';

@Module({
  imports: [SharedModule, InternalClientModule, SummaryModule, SessionModule],
  providers: [AskService, RetrieverService],
  exports: [AskService, RetrieverService],
})
export class AskModule {}
