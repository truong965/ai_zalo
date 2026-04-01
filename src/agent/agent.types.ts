import { BotTriggerType } from '../bot-gateway/dto/trigger-bot.dto';

export interface AgentJobData {
  type: BotTriggerType;
  conversationId: string;
  userId: string;
  messageId?: string;
  text?: string;
  targetLang?: string;
}
