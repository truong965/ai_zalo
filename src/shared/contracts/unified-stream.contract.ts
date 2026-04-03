export const AIUnifiedResponseEvents = {
  STARTED: 'ai.response.started',
  PROGRESS: 'ai.response.progress',
  THOUGHT: 'ai.response.thought',
  DELTA: 'ai.response.delta',
  COMPLETED: 'ai.response.completed',
  ERROR: 'ai.response.error',
} as const;

export type AIUnifiedResponseEventName =
  (typeof AIUnifiedResponseEvents)[keyof typeof AIUnifiedResponseEvents];

export type AIResponseType = 'ask' | 'agent' | 'summary';

export interface AIUnifiedBasePayload {
  requestId: string;
  conversationId: string;
  type: AIResponseType;
  ts: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
}

export interface AIResponseStartedPayload extends AIUnifiedBasePayload {
  message?: string;
}

export interface AIResponseProgressPayload extends AIUnifiedBasePayload {
  step: string;
  message?: string;
  percent?: number;
}

export interface AIResponseThoughtPayload extends AIUnifiedBasePayload {
  thoughtDelta: string;
}

export interface AIResponseDeltaPayload extends AIUnifiedBasePayload {
  contentDelta: string;
}

export interface AIResponseCompletedPayload extends AIUnifiedBasePayload {
  content: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface AIResponseErrorPayload extends AIUnifiedBasePayload {
  code: string;
  message: string;
  retriable?: boolean;
}
