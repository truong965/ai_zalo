import { Module } from '@nestjs/common';
import { SummaryService } from './summary.service';
import { SharedModule } from '../shared/shared.module';
import { InternalClientModule } from '../internal-client/internal-client.module';

@Module({
  imports: [SharedModule, InternalClientModule],
  providers: [SummaryService],
  exports: [SummaryService],
})
export class SummaryModule {}
