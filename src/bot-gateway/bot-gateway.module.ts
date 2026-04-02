import { Module } from '@nestjs/common';
import { BotGatewayController } from './bot-gateway.controller';
import { BotGatewayService } from './bot-gateway.service';
import { SharedModule } from '../shared/shared.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [
    SharedModule,
    AgentModule,
  ],
  controllers: [BotGatewayController],
  providers: [BotGatewayService],
})
export class BotGatewayModule {}
