import { IsString, IsNotEmpty, IsEnum, IsOptional, IsUUID, IsBoolean } from 'class-validator';

export enum BotTriggerType {
  TRANSLATE = 'translate',
  ASK = 'ask',
  SUMMARY = 'summary',
  AGENT = 'agent',
}

export class TriggerBotDto {
  @IsEnum(BotTriggerType)
  @IsNotEmpty()
  type: BotTriggerType;

  @IsUUID()
  @IsNotEmpty()
  conversationId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  messageId?: string;

  @IsString()
  @IsOptional()
  text?: string;

  @IsString()
  @IsOptional()
  targetLang?: string;

  @IsBoolean()
  @IsOptional()
  stream?: boolean;
}
