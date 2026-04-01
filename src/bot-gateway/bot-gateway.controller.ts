import { Controller, Post, Body, Headers, UnauthorizedException, Logger } from '@nestjs/common';
import { BotGatewayService } from './bot-gateway.service';
import { ConfigService } from '@nestjs/config';

@Controller('bot')
export class BotGatewayController {
  private readonly logger = new Logger(BotGatewayController.name);

  constructor(
    private readonly botGatewayService: BotGatewayService,
    private configService: ConfigService,
  ) {}

  @Post('trigger')
  async handleTrigger(
    @Body() body: any,
    @Headers('x-internal-api-key') apiKey: string,
  ) {
    const secret = this.configService.get<string>('MAIN_APP_INTERNAL_API_KEY');
    if (apiKey !== secret) {
      throw new UnauthorizedException('Invalid API Key');
    }

    this.logger.log(`Received trigger type: ${body.type}`);
    return this.botGatewayService.handleTrigger(body);
  }
}
