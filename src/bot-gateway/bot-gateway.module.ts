import { Module } from '@nestjs/common';
import { BotGatewayController } from './bot-gateway.controller';
import { BotGatewayService } from './bot-gateway.service';
import { SharedModule } from '../shared/shared.module';
import { AgentModule } from '../agent/agent.module';
import { SessionModule } from '../sessions/session.module';

@Module({
  imports: [
    SharedModule,
    AgentModule,
    SessionModule,
  ],
  controllers: [BotGatewayController],
  providers: [BotGatewayService],
})
export class BotGatewayModule {}
