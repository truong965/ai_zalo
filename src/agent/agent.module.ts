import { Module, forwardRef } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentProcessor } from './agent.processor';
import { TranslateModule } from '../translate/translate.module';
import { InternalClientModule } from '../internal-client/internal-client.module';
import { SharedModule } from '../shared/shared.module';
import { AskModule } from '../ask/ask.module';
import { SummaryModule } from '../summary/summary.module';

@Module({
  imports: [
    TranslateModule,
    InternalClientModule,
    SharedModule,
    forwardRef(() => AskModule),
    SummaryModule,
  ],
  providers: [AgentService, AgentProcessor],
  exports: [AgentService],
})
export class AgentModule {}
