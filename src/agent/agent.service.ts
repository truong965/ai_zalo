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

import { LlmGatewayService } from '../shared/llm-gateway.service';
import { AbortManagerService } from './abort-manager.service';
import { AbortUtils } from '../shared/abort.utils';

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
    private readonly llmGateway: LlmGatewayService,
    private readonly abortManager: AbortManagerService,
  ) {}

  /**
   * Path 1: Explicit tool trigger (fast-track, bypass Router)
   */
  async executeTool(
    data: AgentJobData,
    options?: {
      emitUnifiedEvents?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<any> {
    const { type, conversationId, userId, requestId } = data;
    const emitUnifiedEvents = options?.emitUnifiedEvents ?? true;

    // --- Guard: Kiểm tra xem conversation đã bị cancel chưa ---
    // Ngăn chặn các yêu cầu fast-track (ASK streaming) tiếp tục chạy nếu user đã cancel.
    if (this.abortManager.isConversationCancelled(conversationId)) {
      this.logger.debug(`Skipping explicit tool [${type}] for cancelled conversation: ${conversationId}`);
      throw new DOMException('AI Request Cancelled', 'AbortError');
    }

    this.logger.log(`Executing explicit tool: ${type} for conversation ${conversationId}`);

    // --- Cancellation Setup cho Fast-track ---
    let internalAbortController: AbortController | undefined;
    let signal = options?.signal;

    if (requestId && !signal) {
      internalAbortController = new AbortController();
      signal = internalAbortController.signal;
      this.abortManager.register(requestId, internalAbortController);
    }

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
            signal,
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
            signal,
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
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Tool execution cancelled by user [${type}]`);
        throw err;
      }
      this.logger.error(`Tool execution failed [${type}]: ${err.message}`);
      throw err;
    } finally {
      if (internalAbortController && requestId) {
        this.abortManager.remove(requestId);
      }
    }
  }

  /**
   * Rule-based intent filter to bypass LLM router for clear intents.
   */
  private preClassify(text: string): { intent: string; confidence: number } | null {
    const lowerText = text.trim().toLowerCase();
    
    // Greeting patterns
    if (/^(xin chào|hello|hi|chào|hey|chào buổi)\b/.test(lowerText)) {
      return { intent: 'general_chat', confidence: 1.0 };
    }
    
    // Clarify patterns (super short)
    if (lowerText.split(' ').length <= 1 && lowerText.length <= 3) {
      if (['ok', 'uh', 'ừ', 'hm', 'hôm nay', 'ừm', 'này'].includes(lowerText)) {
        return { intent: 'clarify', confidence: 0.9 };
      }
    }

    return null;
  }

  /**
   * Path 2: Natural language -> Router -> LangGraph ReAct Agent
   */
  async runAgent(data: AgentJobData, isRetry = false): Promise<AgentResult> {
    const { text, conversationId, userId } = data;
    if (!text) {
      throw new Error('No text provided for agent');
    }

    // --- Guard: Kiểm tra xem conversation đã bị cancel chưa ---
    // Xảy ra khi BullMQ retry hoặc job duplicate cũ còn trong queue sau khi user đã cancel.
    if (this.abortManager.isConversationCancelled(conversationId)) {
      this.logger.debug(
        `Skipping agent job for cancelled conversation: ${conversationId}`,
      );
      // Throw abort error để BullMQ không retry tiếp
      const abortErr = new DOMException('AI Request Cancelled', 'AbortError');
      throw abortErr;
    }

    // --- P3: Cancellation Setup ---
    let abortController: AbortController | undefined;
    if (data.requestId && !isRetry) {
      abortController = new AbortController();
      this.abortManager.register(data.requestId, abortController);
    }

    try {
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

      // 0. Pre-route (Adaptive Complexity) - Bypass LLM for basic inputs
      const preRoute = this.preClassify(text);
      if (preRoute) {
        if (preRoute.intent === 'general_chat' || preRoute.intent === 'clarify') {
          this.logger.log(`Pre-route matched ${preRoute.intent}. Using direct LLM response...`);
          const directAnswer = await this.llmGateway.generateText(
            `Bạn là trợ lý AI (Zalo Assistant). Hãy trả lời ngắn gọn, thân thiện theo yêu cầu sau:\n${text}`, 
            { temperature: 0.7, signal: abortController?.signal }
          );
          
          const result = { answer: directAnswer, intent: preRoute.intent, confidence: preRoute.confidence };
          await this.internalClient.notifyUnifiedResponse({
            conversationId, userId,
            event: AIUnifiedResponseEvents.COMPLETED,
            payload: { ...unifiedBase, content: directAnswer },
          });
          await this.internalClient.notify({
            conversationId, userId, type: 'agent', payload: result
          });
          return result;
        }
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

      // Capture real-time reasoning streaming from classifying intent
      const route = await this.routerService.classify(
        text, 
        { conversationId, signal: abortController?.signal },
        async (thoughtDelta) => {
          await this.internalClient.notifyUnifiedResponse({
            conversationId,
            userId,
            event: AIUnifiedResponseEvents.THOUGHT,
            payload: {
              ...unifiedBase,
              thoughtDelta,
            },
          });
        }
      );

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
      const wordCount = text.trim().split(/\s+/).length;
      if (!isRetry && route.confidence < 0.6 && wordCount < 4) {
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

        const rewrittenText = await this.routerService.rewriteForClarity(text, abortController?.signal);
        
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
          emitUnifiedEvents: true, // Enable streaming from tools
          signal: abortController?.signal,
        });

        const answer = toolResult.answer || toolResult.summary || toolResult.translatedText || 'Xong!';
        
        return {
          answer,
          intent: route.intent,
          confidence: route.confidence
        };
      }

      // 5. Policy Tier 4: Mid-High confidence (>= 0.6) -> AUTONOMOUS GRAPH
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
      if (AbortUtils.isAbortError(err)) {
        this.logger.debug(`Agent loop cancelled by user for conversation ${data.conversationId}`);
        throw err;
      }
      this.logger.error(`Agent loop failed: ${err.message}`);

      const unifiedBaseBackup = this.internalClient.createUnifiedBasePayload({
        requestId: data.requestId,
        conversationId: data.conversationId,
        type: 'agent',
      });

      await this.internalClient.notifyUnifiedResponse({
        conversationId: data.conversationId,
        userId: data.userId,
        event: AIUnifiedResponseEvents.ERROR,
        payload: {
          ...unifiedBaseBackup,
          code: err.name === 'AbortError' || err.message === 'AI Request Cancelled' ? 'CANCELLED' : 'AGENT_EXECUTION_FAILED',
          message: err?.message || 'Agent execution failed',
          retriable: true,
        },
      });

      throw err;
    } finally {
      if (data.requestId && !isRetry) {
        this.abortManager.remove(data.requestId);
      }
    }
  }
}
