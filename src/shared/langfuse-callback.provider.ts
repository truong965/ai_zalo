import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LangfuseCallbackProvider {
  private readonly logger = new Logger(LangfuseCallbackProvider.name);
  public readonly handler: any | null;

  constructor(private configService: ConfigService) {
    let HandlerClass: any = null;
    try {
      HandlerClass = require('langfuse-langchain').CallbackHandler;
    } catch (e: any) {
      this.logger.warn(`Failed to load langfuse-langchain: ${e.message}`);
    }

    if (!HandlerClass) {
      this.handler = null;
      this.logger.warn('Langfuse CallbackHandler is unavailable. Callback tracing is disabled. Install a compatible langfuse callback package to enable it.');
      return;
    }

    this.handler = new HandlerClass({
      publicKey: this.configService.get('LANGFUSE_PUBLIC_KEY'),
      secretKey: this.configService.get('LANGFUSE_SECRET_KEY'),
      baseUrl: this.configService.get('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
    });
  }
}

