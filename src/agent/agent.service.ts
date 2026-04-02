import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { AgentJobData, AgentResult } from './agent.types';
import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';
import { AskService } from '../ask/ask.service';
import { SummaryService } from '../summary/summary.service';
import { RouterService } from './router.service';
import { AgentGraphService } from './agent-graph.service';
import { 
  TranslateInputSchema, 
  AskInputSchema, 
  SummaryInputSchema 
} from './schemas/tool-input.schema';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly translateService: TranslateService,
    private readonly internalClient: InternalClientService,
    @Inject(forwardRef(() => AskService))
    private readonly askService: AskService,
    private readonly summaryService: SummaryService,
    private readonly routerService: RouterService,
    private readonly agentGraphService: AgentGraphService,
  ) {}

  /**
   * Path 1: Explicit tool trigger (fast-track, bypass Router)
   */
  async executeTool(data: AgentJobData): Promise<any> {
    const { type, conversationId, userId } = data;
    this.logger.log(`Executing explicit tool: ${type} for conversation ${conversationId}`);

    let result: any;

    try {
      switch (type) {
        case BotTriggerType.TRANSLATE: {
          const input = TranslateInputSchema.parse(data);
          const messages = await this.internalClient.getMessages({ messageIds: [input.messageId] });
          if (!messages.length) throw new Error('Original message not found');
          
          const originalText = messages[0].content || messages[0].text;
          result = await this.translateService.translate(originalText, input.targetLang);
          
          await this.internalClient.notify({
            conversationId, userId, type: 'translate',
            payload: { messageId: input.messageId, ...result }
          });
          break;
        }

        case BotTriggerType.ASK: {
          const input = AskInputSchema.parse(data);
          result = await this.askService.ask(input.conversationId, input.userId, input.text, data.text === undefined ? false : true); // text check for streaming if needed
          
          await this.internalClient.notify({
            conversationId, userId, type: 'ask',
            payload: result
          });
          break;
        }

        case BotTriggerType.SUMMARY: {
          const input = SummaryInputSchema.parse(data);
          result = await this.summaryService.summarize(input.conversationId, userId);
          
          await this.internalClient.notify({
            conversationId, userId, type: 'summary',
            payload: result
          });
          break;
        }

        default:
          throw new Error(`Unsupported tool type: ${type}`);
      }

      return result;
    } catch (err: any) {
      this.logger.error(`Tool execution failed [${type}]: ${err.message}`);
      throw err;
    }
  }

  /**
   * Path 2: Natural language -> Router -> LangGraph ReAct Agent
   */
  async runAgent(data: AgentJobData, isRetry = false): Promise<AgentResult> {
    const { text, conversationId, userId } = data;
    if (!text) throw new Error('Text is required for runAgent');

    this.logger.log(`Running agent${isRetry ? ' (retry)' : ''} for: "${text}"`);

    // 1. Router: Classify intent and confidence
    const route = await this.routerService.classify(text, { conversationId });
    
    // 2. Policy Tier 1: Very low confidence (< 0.4) -> ASK USER
    if (route.confidence < 0.4) {
      const answer = route.reasoning || "Tôi chưa hiểu ý bạn, bạn có thể nói rõ hơn được không?";
      const result = { answer, intent: 'clarify', confidence: route.confidence };
      
      await this.internalClient.notify({
        conversationId, userId, type: 'agent',
        payload: result
      });
      return result;
    }

    // 3. Policy Tier 2: Low-Mid confidence (0.4 - 0.6) -> REWRITE & RE-RUN (One time)
    if (!isRetry && route.confidence < 0.6) {
      this.logger.log(`Confidence low (${route.confidence}). Attempting rewrite for clarity...`);
      const rewrittenText = await this.routerService.rewriteForClarity(text);
      if (rewrittenText && rewrittenText !== text) {
        return this.runAgent({ ...data, text: rewrittenText }, true);
      }
    }

    // 4. Policy Tier 3: High confidence (>= 0.9) -> FAST-TRACK
    if (route.confidence >= 0.9 && [BotTriggerType.TRANSLATE, BotTriggerType.ASK, BotTriggerType.SUMMARY].includes(route.intent as any)) {
      this.logger.log(`Fast-tracking confident intent: ${route.intent}`);
      const toolResult = await this.executeTool({
        ...data,
        type: route.intent as BotTriggerType,
        targetLang: route.params.targetLang ?? undefined,
        text: route.params.searchQuery || text,
      });
      
      return {
        answer: toolResult.answer || toolResult.summary || toolResult.translatedText || "Xong!",
        intent: route.intent,
        confidence: route.confidence
      };
    }

    // 5. Policy Tier 4: Mid-High confidence (>= 0.6) -> AUTONOMOUS GRAPH
    try {
      const graphResult = await this.agentGraphService.run({
        question: text,
        conversationId,
        userId,
        routerHint: route
      });

      const result = {
        answer: graphResult.answer,
        intent: route.intent,
        confidence: route.confidence,
        sources: graphResult.sources
      };

      // Notify main app
      await this.internalClient.notify({
        conversationId, userId, type: 'agent',
        payload: result
      });

      return result;
    } catch (err: any) {
      this.logger.error(`Agent loop failed: ${err.message}`);
      throw err;
    }
  }
}
