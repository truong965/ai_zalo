import { Controller, Post, Body, Headers, UnauthorizedException, Logger } from '@nestjs/common';
import { BotGatewayService } from './bot-gateway.service';
import { ConfigService } from '@nestjs/config';
import { AbortManagerService } from '../agent/abort-manager.service';

@Controller('bot')
export class BotGatewayController {
  private readonly logger = new Logger(BotGatewayController.name);

  constructor(
    private readonly botGatewayService: BotGatewayService,
    private configService: ConfigService,
    private readonly abortManager: AbortManagerService,
  ) {}

  @Post('trigger')
  async handleTrigger(
    @Body() body: any,
    @Headers('x-internal-api-key') apiKey: string,
  ) {
    const secret =
      this.configService.get<string>('INTERNAL_API_KEY');
    if (apiKey !== secret) {
      throw new UnauthorizedException('Invalid API Key');
    }

    this.logger.log(`Received trigger type: ${body.type}`);
    return this.botGatewayService.handleTrigger(body);
  }

  @Post('cancel')
  async handleCancel(
    @Body() body: { requestId: string; conversationId?: string },
    @Headers('x-internal-api-key') apiKey: string,
  ) {
    const secret =
      this.configService.get<string>('INTERNAL_API_KEY');
    if (apiKey !== secret) {
      throw new UnauthorizedException('Invalid API Key');
    }

    this.logger.log(`Received explicit cancel request for: ${body.requestId}`);
    this.abortManager.abort(body.requestId, body.conversationId);
    return { success: true, message: 'Cancellation signal dispatched' };
  }
}
