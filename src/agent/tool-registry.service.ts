import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { RetrieverService } from '../ask/retriever.service';
import { SummaryService } from '../summary/summary.service';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';

import { createAskTool } from '../tools/ask.tool';
import { createSummaryTool } from '../tools/summary.tool';
import { createTranslateTool } from '../tools/translate.tool';

@Injectable()
export class ToolRegistryService {
  constructor(
    @Inject(forwardRef(() => RetrieverService))
    private readonly retrieverService: RetrieverService,
    private readonly summaryService: SummaryService,
    private readonly translateService: TranslateService,
    private readonly internalClient: InternalClientService,
  ) {}

  /**
   * Retrieves all registered agent tools
   */
  getTools() {
    return [
      createAskTool(this.retrieverService),
      createSummaryTool(this.summaryService),
      createTranslateTool(this.translateService),
    ];
  }
}
