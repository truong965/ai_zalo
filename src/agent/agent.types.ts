import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';

export interface AgentJobData {
  type: BotTriggerType;
  conversationId: string;
  userId: string;
  messageId?: string;
  text?: string;
  targetLang?: string;
  stream?: boolean;
  requestId?: string;
  startDate?: string;
  endDate?: string;
  startMessageId?: string;
  endMessageId?: string;
  // Phase 2: Internal params for CRAG logic
  cragParams?: {
    originalQuestion: string;
    rewrittenQuery?: string;
    retryCount: number;
  };
  
  // Phase 2: Internal params for Critic logic
  evalParams?: {
    question: string;
    context: string;
    answer: string;
  };
}

export interface AgentResult {
  answer: string;
  sources?: any[];
  intent?: string;
  confidence?: number;
  criticResult?: any; // Phase 2: Evaluation results
}

export interface ToolResult {
  result: any;
  type: BotTriggerType;
}
