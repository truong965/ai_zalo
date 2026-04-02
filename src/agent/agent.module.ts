import { Module, forwardRef } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentProcessor } from './agent.processor';
import { TranslateModule } from '../translate/translate.module';
import { InternalClientModule } from '../internal-client/internal-client.module';
import { SharedModule } from '../shared/shared.module';
import { AskModule } from '../ask/ask.module';
import { SummaryModule } from '../summary/summary.module';
import { RouterService } from './router.service';
import { AgentGraphService } from './agent-graph.service';
import { CriticService } from './critic.service';
import { CragService } from './crag.service';
import { CitationService } from './citation.service';

@Module({
  imports: [
    TranslateModule,
    InternalClientModule,
    SharedModule,
    forwardRef(() => AskModule),
    SummaryModule,
  ],
  providers: [
    AgentService, 
    AgentProcessor, 
    RouterService, 
    AgentGraphService,
    CriticService,
    CragService,
    CitationService,
  ],
  exports: [AgentService, RouterService],
})
export class AgentModule {}
