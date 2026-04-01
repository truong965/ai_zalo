import { Module } from '@nestjs/common';
import { BotGatewayController } from './bot-gateway.controller';
import { BotGatewayService } from './bot-gateway.service';
import { SharedModule } from '../shared/shared.module';
import { TranslateModule } from '../translate/translate.module';
import { AskModule } from '../ask/ask.module';
import { InternalClientModule } from '../internal-client/internal-client.module';

@Module({
  imports: [
    SharedModule,
    TranslateModule,
    AskModule,
    InternalClientModule,
  ],
  controllers: [BotGatewayController],
  providers: [BotGatewayService],
})
export class BotGatewayModule {}
