import { Module } from '@nestjs/common';
import { SummaryService } from './summary.service';
import { SharedModule } from '../shared/shared.module';
import { InternalClientModule } from '../internal-client/internal-client.module';
import { SessionModule } from '../sessions/session.module';

@Module({
  imports: [SharedModule, InternalClientModule, SessionModule],
  providers: [SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
