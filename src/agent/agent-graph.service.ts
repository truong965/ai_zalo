import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { StateGraph, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { BaseMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { ConfigService } from '@nestjs/config';

import { AgentState } from './schemas/agent-state.schema';
import { RouterOutput } from './schemas/router-output.schema';
import { createAskTool } from '../tools/ask.tool';
import { createSummaryTool } from '../tools/summary.tool';
import { createTranslateTool } from '../tools/translate.tool';

import { AskService, AskMessage } from '../ask/ask.service';
import { SummaryService } from '../summary/summary.service';
import { TranslateService } from '../translate/translate.service';
import { InternalClientService } from '../internal-client/internal-client.service';
import { CriticService } from './critic.service';
import { CragService } from './crag.service';
import { CitationService } from './citation.service';

@Injectable()
export class AgentGraphService {
  private readonly logger = new Logger(AgentGraphService.name);
  private graph: any;

  constructor(
    private configService: ConfigService,
    @Inject(forwardRef(() => AskService))
    private askService: AskService,
    private summaryService: SummaryService,
    private translateService: TranslateService,
    private internalClient: InternalClientService,
    private criticService: CriticService,
    private cragService: CragService,
    private citationService: CitationService,
  ) {
    this.initGraph();
  }

  private initGraph() {
    // 1. Initialize tools
    const tools = [
      createAskTool(this.askService),
      createSummaryTool(this.summaryService),
      createTranslateTool(this.translateService, this.internalClient),
    ];

    const toolNode = new ToolNode(tools);

    // 2. Initialize Reasoner (Gemini Flash)
    const model = new (ChatGoogleGenerativeAI as any)({
      model: this.configService.get<string>('GEMINI_LLM_MODEL', 'gemini-1.5-flash'),
      apiKey: this.configService.getOrThrow<string>('GEMINI_API_KEY'),
      temperature: 0,
    }).bindTools(tools);

    // 3. Define the nodes

    /**
     * Reasoner: Decides what tool to use or if we stop
     */
    const reasonerNode = async (state: typeof AgentState.State) => {
      const { messages } = state;
      const response = await model.invoke(messages);
      return { messages: [response] };
    };

    /**
     * Grade Docs: Checks if retrieved context is relevant (CRAG)
     */
    const gradeDocsNode = async (state: typeof AgentState.State) => {
      const lastMessage = state.messages[state.messages.length - 1] as ToolMessage;
      // The tool result is expected to have 'context' field due to AskService decomposition
      const toolOutput = JSON.parse(lastMessage.content as string);
      const context = toolOutput.context || [];
      
      const judgment = await this.cragService.gradeDocuments({
        question: state.messages[0].content as string,
        documents: context
      });

      return { 
        retrievedDocs: context,
        cragResult: judgment
      };
    };

    /**
     * Rewrite Query: If docs are irrelevant or critic fails, rewrite search (CRAG)
     */
    const rewriteQueryNode = async (state: typeof AgentState.State) => {
      const originalQuestion = state.messages[0].content as string;
      const rewritten = await this.cragService.rewriteQuery({
        question: originalQuestion,
        reasoning: state.cragResult?.reasoning || state.criticResult?.reasoning
      });

      // Update the question for the next 'ask' call
      return {
        messages: [new AIMessage(`Tôi sẽ thử tìm kiếm lại với từ khóa: ${rewritten.queries[0]}`)],
        retryCount: 1, // Increment retry
      };
    };

    /**
     * Generate Answer: Create the RAG response
     */
    const generateAnswerNode = async (state: typeof AgentState.State) => {
      const answer = await this.askService.generateAnswer({
        question: state.messages[0].content as string,
        context: state.retrievedDocs || [],
        userId: state.userId,
        conversationId: state.conversationId
      });

      return { finalAnswer: answer };
    };

    /**
     * Critic Evaluate: Check for hallucinations (Critic)
     */
    const criticEvaluateNode = async (state: typeof AgentState.State) => {
      const evaluation = await this.criticService.evaluate({
        question: state.messages[0].content as string,
        context: (state.retrievedDocs || []).map((m: any) => m.content).join('\n'),
        answer: state.finalAnswer || ''
      });

      return { criticResult: evaluation };
    };

    /**
     * Format Citations: Add source markers
     */
    const formatCitationsNode = async (state: typeof AgentState.State) => {
      const formatted = await this.citationService.formatWithCitations({
        answer: state.finalAnswer || '',
        context: state.retrievedDocs || [],
        question: state.messages[0].content as string
      });

      return { finalAnswer: formatted };
    };

    // --- Conditional Edges ---

    const routingPolicy = (state: typeof AgentState.State) => {
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      
      if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        const toolName = lastMessage.tool_calls[0].name;
        if (toolName === 'ask') return "grade_docs_path";
        return "tools_path";
      }
      return END;
    };

    const cragGate = (state: typeof AgentState.State) => {
      const verdict = state.cragResult?.verdict;
      if (verdict === 'CORRECT') return "generate";
      if (verdict === 'AMBIGUOUS' && state.retryCount < 1) return "rewrite";
      return "generate"; // Fallback to generate anyway or could handle INCORRECT specifically
    };

    const criticGate = (state: typeof AgentState.State) => {
      const verdict = state.criticResult?.verdict;
      if (verdict === 'FAIL' && state.retryCount < 1) return "rewrite";
      return "finalize";
    };

    // 4. Build the graph
    const workflow = new StateGraph(AgentState)
      .addNode("reasoner", reasonerNode)
      .addNode("tools", toolNode)
      .addNode("grade_docs", gradeDocsNode)
      .addNode("rewrite_query", rewriteQueryNode)
      .addNode("generate_answer", generateAnswerNode)
      .addNode("critic_evaluate", criticEvaluateNode)
      .addNode("format_citations", formatCitationsNode)

      .addEdge(START, "reasoner")
      
      .addConditionalEdges("reasoner", routingPolicy, {
        grade_docs_path: "tools", // Tools carries the 'ask' output
        tools_path: "tools",
        [END]: END
      })

      // Path for 'ask' tool specifically
      .addConditionalEdges("tools", (state) => {
        const lastMsg = state.messages[state.messages.length -1] as ToolMessage;
        // Check if the output is from 'ask'
        if ((state.messages[state.messages.length - 2] as any)?.tool_calls?.[0]?.name === 'ask') {
          return "grade";
        }
        return "reasoner";
      }, {
        grade: "grade_docs",
        reasoner: "reasoner"
      })

      .addConditionalEdges("grade_docs", cragGate, {
        generate: "generate_answer",
        rewrite: "rewrite_query"
      })

      .addEdge("rewrite_query", "reasoner") // Try again with new AI message hint

      .addEdge("generate_answer", "critic_evaluate")

      .addConditionalEdges("critic_evaluate", criticGate, {
        finalize: "format_citations",
        rewrite: "rewrite_query"
      })

      .addEdge("format_citations", END);

    this.graph = workflow.compile();
    this.logger.log("AgentGraph V2 (Quality Stack) successfully compiled.");
  }

  /**
   * Run the agent graph
   */
  async run(params: {
    question: string;
    conversationId: string;
    userId: string;
    routerHint?: RouterOutput;
  }): Promise<{ answer: string; sources?: any[] }> {
    this.logger.debug(`Running graph V2 for: "${params.question}"`);

    const initialState = {
      messages: [
        new HumanMessage({
          content: `Bối cảnh người dùng:
- Current User ID: ${params.userId}
- Current Conversation ID: ${params.conversationId}

Yêu cầu: ${params.question}`
        })
      ],
      conversationId: params.conversationId,
      userId: params.userId,
      routerResult: params.routerHint || null,
      retryCount: 0,
    };

    try {
      const result = await this.graph.invoke(initialState);
      
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
      this.logger.error(`Graph V2 execution failed: ${err.message}`);
      throw err;
    }
  }
}
