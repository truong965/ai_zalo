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
import { AIUnifiedResponseEvents } from '../shared/contracts/unified-stream.contract';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  private static readonly AGENT_INTERNAL_TOOL_META = {
    source: 'agent-fast-track',
  } as const;

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
  async executeTool(
    data: AgentJobData,
    options?: {
      emitUnifiedEvents?: boolean;
    },
  ): Promise<any> {
    const { type, conversationId, userId } = data;
    const emitUnifiedEvents = options?.emitUnifiedEvents ?? true;
    this.logger.log(`Executing explicit tool: ${type} for conversation ${conversationId}`);

    let result: any;

    try {
      switch (type) {
        case BotTriggerType.TRANSLATE: {
          const input = TranslateInputSchema.parse(data);

          let originalText = input.text?.trim() || '';

          if (!originalText && input.messageId) {
            const messages = await this.internalClient.getMessages({
              messageIds: [input.messageId],
              conversationId: input.conversationId,
              userId: input.userId,
              limit: 1,
            });

            if (!messages.length) {
              throw new Error('Original message not found');
            }

            originalText = messages[0].content || messages[0].text || '';
          }

          if (!originalText) {
            throw new Error('No text provided for translation');
          }

          result = await this.translateService.translate(originalText, input.targetLang, {
            conversationId: input.conversationId,
            userId: input.userId,
            messageId: input.messageId,
            requestId: data.requestId,
          });
          
          await this.internalClient.notify({
            conversationId, userId, type: 'translate',
            payload: { messageId: input.messageId, ...result }
          });
          break;
        }

        case BotTriggerType.ASK: {
          const input = AskInputSchema.parse(data);
          result = await this.askService.ask(
            input.conversationId,
            input.userId,
            input.text,
            Boolean(data.stream),
            data.requestId,
            emitUnifiedEvents,
          );
          
          await this.internalClient.notify({
            conversationId, userId, type: 'ask',
            payload: result
          });
          break;
        }

        case BotTriggerType.SUMMARY: {
          const input = SummaryInputSchema.parse(data);
          result = await this.summaryService.summarize(
            input.conversationId, 
            userId,
            input.startMessageId,
            input.endMessageId,
            input.startDate,
            input.endDate,
            data.requestId,
            Boolean(data.stream),
            emitUnifiedEvents,
          );
          
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

    const unifiedBase = this.internalClient.createUnifiedBasePayload({
      requestId: data.requestId,
      conversationId,
      type: 'agent',
      meta: AgentService.AGENT_INTERNAL_TOOL_META,
    });

    this.logger.log(`Running agent${isRetry ? ' (retry)' : ''} for: "${text}"`);

    if (!isRetry) {
      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.STARTED,
        payload: {
          ...unifiedBase,
          message: 'Started agent execution',
        },
      });
    }

    // 1. Router: Classify intent and confidence
    await this.internalClient.notifyUnifiedResponse({
      conversationId,
      userId,
      event: AIUnifiedResponseEvents.PROGRESS,
      payload: {
        ...unifiedBase,
        step: 'route',
        message: 'Classifying user intent',
        percent: 20,
      },
    });

    const route = await this.routerService.classify(text, { conversationId });
    
    // 2. Policy Tier 1: Very low confidence (< 0.4) -> ASK USER
    if (route.confidence < 0.4) {
      const answer = route.reasoning || "Tôi chưa hiểu ý bạn, bạn có thể nói rõ hơn được không?";
      const result = { answer, intent: 'clarify', confidence: route.confidence };

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.COMPLETED,
        payload: {
          ...unifiedBase,
          content: answer,
        },
      });
      
      await this.internalClient.notify({
        conversationId, userId, type: 'agent',
        payload: result
      });
      return result;
    }

    // 3. Policy Tier 2: Low-Mid confidence (0.4 - 0.6) -> REWRITE & RE-RUN (One time)
    if (!isRetry && route.confidence < 0.6) {
      this.logger.log(`Confidence low (${route.confidence}). Attempting rewrite for clarity...`);

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.PROGRESS,
        payload: {
          ...unifiedBase,
          step: 'rewrite',
          message: 'Rewriting question for clarity',
          percent: 35,
        },
      });

      const rewrittenText = await this.routerService.rewriteForClarity(text);
      if (rewrittenText && rewrittenText !== text) {
        return this.runAgent({ ...data, text: rewrittenText }, true);
      }
    }

    // 4. Policy Tier 3: High confidence (>= 0.9) -> FAST-TRACK
    if (route.confidence >= 0.9 && [BotTriggerType.TRANSLATE, BotTriggerType.ASK, BotTriggerType.SUMMARY].includes(route.intent as any)) {
      this.logger.log(`Fast-tracking confident intent: ${route.intent}`);

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.PROGRESS,
        payload: {
          ...unifiedBase,
          step: 'fast_track',
          message: `Fast-tracking tool: ${route.intent}`,
          percent: 60,
        },
      });

      const toolResult = await this.executeTool({
        ...data,
        type: route.intent as BotTriggerType,
        targetLang: route.params.targetLang ?? undefined,
        text: route.params.searchQuery || text,
      }, {
        emitUnifiedEvents: false,
      });

      const answer = toolResult.answer || toolResult.summary || toolResult.translatedText || 'Xong!';

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.COMPLETED,
        payload: {
          ...unifiedBase,
          content: answer,
        },
      });
      
      return {
        answer,
        intent: route.intent,
        confidence: route.confidence
      };
    }

    // 5. Policy Tier 4: Mid-High confidence (>= 0.6) -> AUTONOMOUS GRAPH
    try {
      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.PROGRESS,
        payload: {
          ...unifiedBase,
          step: 'graph',
          message: 'Running autonomous agent graph',
          percent: 70,
        },
      });

      const graphResult = await this.agentGraphService.run({
        question: text,
        conversationId,
        userId,
        routerHint: route,
        requestId: data.requestId,
        stream: true,
      });

      const result = {
        answer: graphResult.answer,
        intent: route.intent,
        confidence: route.confidence,
        sources: graphResult.sources
      };

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.COMPLETED,
        payload: {
          ...unifiedBase,
          content: graphResult.answer,
        },
      });

      // Notify main app
      await this.internalClient.notify({
        conversationId, userId, type: 'agent',
        payload: result
      });

      return result;
    } catch (err: any) {
      this.logger.error(`Agent loop failed: ${err.message}`);

      await this.internalClient.notifyUnifiedResponse({
        conversationId,
        userId,
        event: AIUnifiedResponseEvents.ERROR,
        payload: {
          ...unifiedBase,
          code: 'AGENT_EXECUTION_FAILED',
          message: err?.message || 'Agent execution failed',
          retriable: true,
        },
      });

      throw err;
    }
  }
}
