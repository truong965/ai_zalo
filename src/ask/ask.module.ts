import { Module } from '@nestjs/common';
import { AskService } from './ask.service';
import { SharedModule } from '../shared/shared.module';
import { InternalClientModule } from '../internal-client/internal-client.module';
import { SummaryModule } from '../summary/summary.module';
import { SessionModule } from '../sessions/session.module';

@Module({
  imports: [SharedModule, InternalClientModule, SummaryModule, SessionModule],
  providers: [AskService],
  exports: [AskService],
})
export class AskModule {}
