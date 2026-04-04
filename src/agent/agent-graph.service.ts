import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { BaseMessage, HumanMessage, SystemMessage, AIMessage, ToolMessage, trimMessages } from "@langchain/core/messages";
import { ConfigService } from '@nestjs/config';
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";

import { AgentState } from './schemas/agent-state.schema';
import { RouterOutput } from './schemas/router-output.schema';
import { createAskTool } from '../tools/ask.tool';
import { createSummaryTool } from '../tools/summary.tool';
import { createTranslateTool } from '../tools/translate.tool';

import { RetrieverService } from '../ask/retriever.service';
import { AskMessage } from '../ask/retriever.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { CriticService } from './critic.service';
import { CragService } from './crag.service';
import { CitationService } from './citation.service';
import { AIUnifiedResponseEvents } from '../shared/contracts/unified-stream.contract';
import { LangfuseCallbackProvider } from '../shared/langfuse-callback.provider';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { ToolRegistryService } from './tool-registry.service';
import { AbortManagerService } from './abort-manager.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';

@Injectable()
export class AgentGraphService implements OnModuleInit {
  private readonly logger = new Logger(AgentGraphService.name);
  private graph: any;

  constructor(
    private configService: ConfigService,
    private internalClient: InternalClientService,
    private criticService: CriticService,
    private cragService: CragService,
    private citationService: CitationService,
    private langfuseCallback: LangfuseCallbackProvider,
    private llmGateway: LlmGatewayService,
    private toolRegistry: ToolRegistryService,
    private abortManager: AbortManagerService,
    @Inject(forwardRef(() => RetrieverService))
    private retrieverService: RetrieverService,
    @InjectQueue('ai-job') private readonly aiJobQueue: Queue,
  ) { }

  async onModuleInit() {
    await this.initGraph();
  }

  private async initGraph() {
    // 1. Initialize Saver (LangGraph Persistent Memory)
    const pool = new Pool({
      connectionString: process.env.AI_DATABASE_URL || process.env.DATABASE_URL,
      max: 10,
    });
    const checkpointer = new PostgresSaver(pool);
    await checkpointer.setup();

    // 2. Initialize tools from registry
    const tools = this.toolRegistry.getTools();
    const toolNode = new ToolNode(tools);

    // 3. Initialize Reasoner from LLMGateway (with configured fallbacks)
    const model = this.llmGateway.getLangchainModel({ temperature: 0, tools });

    // 4. Define the nodes
    const reasonerNode = async (state: typeof AgentState.State, config?: any) => {
      const { messages } = state;
      const systemMsg = new SystemMessage({
        content: `Bạn là trợ lý AI tên Zalo Assistant siêu thông minh. Bạn có toàn quyền sử dụng tất cả tool mà người dùng cấp. 
Nếu người dùng hỏi về thông tin công việc, chat history, hãy TỰ DO dùng \`search_chat_history\`.
Nếu User muốn dịch thuật, hãy dùng \`translate\`.
Hãy luôn trả lời bằng Tiếng Việt thân thiện.
TRỌNG YẾU: TRƯỚC KHI gọi bất kỳ công cụ nào hoặc quyết định điều gì, bạn BẮT BUỘC phải viết suy nghĩ của mình vào trong thẻ <thought>...</thought>. VÍ DỤ: <thought>Mình cần tìm lịch sử chat về chủ đề X.</thought>
LUẬT CỨNG: TUYỆT ĐỐI KHÔNG GỌI lệnh dịch thuật quá 1 lần cho cùng 1 câu hỏi, nếu thất bại hãy xin lỗi.
Câu hỏi/Yêu cầu hiện tại: ${state.messages[0]?.content}`
      });

      const trimmer = trimMessages({
        maxTokens: 20, // This acts as maxMessages because of our custom tokenCounter
        strategy: "last",
        tokenCounter: (msgs) => msgs.length, // Cắt theo số lượng tin nhắn thay vì token
        includeSystem: true,
        allowPartial: false, // Không cắt đôi cặp ToolCall/ToolMessage
      });

      const trimmedMessages = await trimmer.invoke(messages, config);
      const response = await model.invoke([systemMsg, ...trimmedMessages], config);
      return { messages: [response] };
    };

    /**
     * CRAG: Validate Context Node
     */
    const validateContextNode = async (state: typeof AgentState.State) => {
      const lastMsg = state.messages[state.messages.length - 1] as ToolMessage;
      let context: any[] = [];
      try {
        const parsed = JSON.parse(lastMsg.content as string);
        if (parsed.context) context = parsed.context;
      } catch { }

      if (context.length === 0) {
        return { cragResult: { verdict: 'INCORRECT' } };
      }

      const topScore = context[0]?.relevanceScore || 0;
      const CRAG_THRESHOLD = this.configService.get<number>('CRAG_RELEVANCE_THRESHOLD', 0.7);

      if (topScore >= CRAG_THRESHOLD) {
        return { cragResult: { verdict: 'CORRECT' } };
      }

      let question = "Context query";
      // Find the question asked to the tool
      const aiMessageWithToolCall = state.messages.find(m =>
        m._getType() === 'ai' && (m as AIMessage).tool_calls?.some(t => t.id === lastMsg.tool_call_id)
      ) as AIMessage;

      const toolCall = aiMessageWithToolCall?.tool_calls?.find(t => t.id === lastMsg.tool_call_id);
      if (toolCall && toolCall.args?.question) {
        question = toolCall.args.question;
      } else {
        const lastHumanMsg = state.messages.slice().reverse().find(m => m._getType() === 'human');
        if (lastHumanMsg) question = lastHumanMsg.content as string;
      }

      const judgment = await this.cragService.gradeDocuments({
        question,
        documents: context
      });

      return { cragResult: judgment };
    };

    /**
     * CRAG: Rewrite Query Node
     */
    const cragRewriteNode = async (state: typeof AgentState.State, config?: any) => {
      const lastMsg = state.messages[state.messages.length - 1] as ToolMessage;

      let question = "Context query";
      const aiMessageWithToolCall = state.messages.find(m =>
        m._getType() === 'ai' && (m as AIMessage).tool_calls?.some(t => t.id === lastMsg.tool_call_id)
      ) as AIMessage;

      const toolCall = aiMessageWithToolCall?.tool_calls?.find(t => t.id === lastMsg.tool_call_id);
      if (toolCall && toolCall.args?.question) {
        question = toolCall.args.question;
      } else {
        const lastHumanMsg = state.messages.slice().reverse().find(m => m._getType() === 'human');
        if (lastHumanMsg) question = lastHumanMsg.content as string;
      }

      this.logger.debug(`[CRAG] Rewriting query due to verdict: ${state.cragResult?.verdict}`);

      const rewritten = await this.cragService.rewriteQuery({
        question,
        reasoning: state.cragResult?.reasoning || 'Tài liệu tìm thấy trước đó không đủ liên quan.'
      });

      const newQuery = (rewritten.queries && rewritten.queries.length > 0) ? rewritten.queries[0] : question;
      const searchDateOptions = toolCall?.args || {};

      const messages = await this.retrieverService.retrieveOnly(
        state.conversationId,
        state.userId,
        newQuery,
        searchDateOptions.startDate,
        searchDateOptions.endDate,
        config?.signal,
      );

      let newContent = "INCORRECT_CONTEXT: KHÔNG TÌM THẤY TÀI LIỆU PHÙ HỢP TRONG LỊCH SỬ. Hãy thông báo cho user là không tìm thấy thông tin.";
      if (messages && messages.length > 0) {
        newContent = JSON.stringify({ context: messages });
      }

      // Overwrite the tool message in the state
      const newMessage = new ToolMessage({
        tool_call_id: lastMsg.tool_call_id,
        name: lastMsg.name,
        content: newContent,
        id: lastMsg.id,
      });

      return {
        messages: [newMessage],
        retryCount: 1,
      };
    };

    /**
     * Tự động chấm điểm bằng Critic và Format sau khi Reasoner hoàn tất (ra tới đáp án cuối).
     */
    const finalizeNode = async (state: typeof AgentState.State) => {
      const lastMsg = state.messages[state.messages.length - 1];
      const answer = lastMsg.content as string;

      // Extract context from previous tool calls if available
      let retrievedContext: any[] = [];
      const toolMessages = state.messages.filter(m => m._getType() === 'tool' && m.name === 'search_chat_history');
      if (toolMessages.length > 0) {
        try {
          // Get the very last tool message from ask_history
          const content = toolMessages[toolMessages.length - 1].content as string;
          const parsed = JSON.parse(content);
          if (parsed.context) retrievedContext = parsed.context;
        } catch (e) { }
      }

      // Format Citations seamlessly
      const formatted = await this.citationService.formatWithCitations({
        answer,
        context: retrievedContext,
        question: state.messages[0]?.content as string
      });

      // P2: Fire Critic Evaluation as Background Job
      // Provide necessary params mapping
      this.aiJobQueue.add('critic-eval', {
        type: BotTriggerType.CRITIC_EVAL,
        conversationId: state.conversationId,
        userId: state.userId,
        text: state.messages[0]?.content as string, // Acts as question
        // Passing specific eval params implicitly through extra fields or mapped in eval tool
        evalParams: {
          question: state.messages[0]?.content as string,
          context: JSON.stringify(retrievedContext),
          answer: formatted,
        }
      });

      return { finalAnswer: formatted, retrievedDocs: retrievedContext };
    };

    // 5. Build the ReAct Auto-Routing Graph
    const workflow = new StateGraph(AgentState)
      .addNode("reasoner", reasonerNode)
      .addNode("tools", toolNode)
      .addNode("validate_context", validateContextNode)
      .addNode("crag_rewrite", cragRewriteNode)
      .addNode("finalize", finalizeNode)

      .addEdge(START, "reasoner")

      .addConditionalEdges("reasoner", toolsCondition, {
        tools: "tools",
        [END]: "finalize"
      })

      .addConditionalEdges("tools", (state: typeof AgentState.State) => {
        const lastMessage = state.messages[state.messages.length - 1];
        if (lastMessage?.name === 'search_chat_history') {
          return "validate_context";
        }
        return "reasoner";
      }, {
        validate_context: "validate_context",
        reasoner: "reasoner"
      })

      .addConditionalEdges("validate_context", (state: typeof AgentState.State) => {
        if (state.cragResult?.verdict === 'CORRECT') return "reasoner";
        const MAX_RETRIES = this.configService.get<number>('CRAG_MAX_RETRIES', 1);
        if (state.retryCount < MAX_RETRIES) return "crag_rewrite";
        return "reasoner";
      }, {
        crag_rewrite: "crag_rewrite",
        reasoner: "reasoner"
      })

      .addEdge("crag_rewrite", "reasoner")

      .addEdge("finalize", END);

    this.graph = workflow.compile({ checkpointer });
    this.logger.log("AgentGraph P0 (CRAG nodes + Unified Langfuse) successfully compiled.");
  }

  /**
   * Run the agent graph
   */
  async run(params: {
    question: string;
    conversationId: string;
    userId: string;
    requestId?: string;
    stream?: boolean;
  }): Promise<{ answer: string; sources?: any[] }> {
    this.logger.debug(`Running graph P0 for: "${params.question}" (stream: ${params.stream})`);

    const unifiedBase = this.internalClient.createUnifiedBasePayload({
      requestId: params.requestId,
      conversationId: params.conversationId,
      type: 'agent',
    });

    const initialState = {
      messages: [
        new HumanMessage({
          content: params.question
        })
      ],
      conversationId: params.conversationId,
      userId: params.userId,
    };

    const graphConfig = {
      configurable: { thread_id: params.conversationId },
      callbacks: this.langfuseCallback.handler ? [this.langfuseCallback.handler] : [],
      recursionLimit: 15, // P3 Loop Protection
      signal: params.requestId ? this.abortManager.get(params.requestId)?.signal : undefined
    };

    try {
      if (params.stream) {
        let finalState: any = null;
        const nodeMessages: Record<string, string> = {
          'reasoner': 'Đang suy nghĩ hướng giải quyết...',
          'validate_context': 'Đang đánh giá mức độ phù hợp của dữ liệu...',
          'crag_rewrite': 'Dữ liệu chưa đủ, đang tìm kiếm lại...',
          'finalize': 'Đang định dạng câu trả lời...',
        };

        const eventStream = this.graph.streamEvents(initialState, {
          ...graphConfig,
          version: "v2",
        });

        for await (const event of eventStream) {
          const eventType = event.event;

          if (eventType === "on_node_start") {
            const nodeName = event.name;
            const message = nodeMessages[nodeName];
            if (message) {
              await this.internalClient.notifyUnifiedResponse({
                conversationId: params.conversationId,
                userId: params.userId,
                event: AIUnifiedResponseEvents.PROGRESS,
                payload: { ...unifiedBase, step: nodeName, message },
              });
            }
          } else if (eventType === "on_chat_model_stream") {
            let chunk = event.data?.chunk?.content;
            if (chunk && typeof chunk === 'string') {

              // Formatting <thought> tags into readable markdown blockquotes
              chunk = chunk.replace(/<thought>/g, '\n\n> 🤔 *Suy nghĩ:* ');
              chunk = chunk.replace(/<\/thought>/g, '\n\n');

              await this.internalClient.notifyUnifiedResponse({
                conversationId: params.conversationId,
                userId: params.userId,
                event: AIUnifiedResponseEvents.DELTA,
                payload: { ...unifiedBase, contentDelta: chunk },
              });
            }
          } else if (eventType === "on_tool_start") {
            await this.internalClient.notifyUnifiedResponse({
              conversationId: params.conversationId,
              userId: params.userId,
              event: AIUnifiedResponseEvents.PROGRESS,
              payload: {
                ...unifiedBase,
                step: `tool_${event.name}`,
                message: `Đang sử dụng công cụ: ${event.name}...`,
              },
            });
          } else if (eventType === "on_chain_end" && event.name === "LangGraph") {
            finalState = event.data.output;
          }
        }

        if (!finalState) {
          // Fallback if stream didn't catch the final state
          finalState = await this.graph.invoke(initialState, graphConfig);
        }

        return {
          answer: finalState.finalAnswer || (Array.isArray(finalState.messages) ? finalState.messages[finalState.messages.length - 1].content.toString() : ''),
          sources: finalState.retrievedDocs?.map((d: any) => ({
            messageId: d.id,
            username: d.senderName,
            text: d.content,
            createdAt: d.createdAt
          }))
        };
      }

      const result = await this.graph.invoke(initialState, graphConfig);

      return {
        answer: result.finalAnswer || result.messages[result.messages.length - 1].content.toString(),
        sources: result.retrievedDocs?.map((d: any) => ({
          messageId: d.id,
          username: d.senderName,
          text: d.content,
          createdAt: d.createdAt
        }))
      };
    } catch (err: any) {
      this.logger.error(`Graph P0 execution failed: ${err.message}`);
      throw err;
    }
  }
}
