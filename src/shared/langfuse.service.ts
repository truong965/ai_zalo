import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { trace, context, Span } from '@opentelemetry/api';

@Injectable()
export class LangfuseService {
  private readonly logger = new Logger(LangfuseService.name);

  constructor(private configService: ConfigService) {}

  /**
   * Get the current active span
   */
  getCurrentSpan(): Span | undefined {
    return trace.getSpan(context.active());
  }

  /**
   * Manually attach evaluation scores to the current trace.
   * Note: This usually requires the Langfuse SDK or a specific OTel attribute convention.
   * Langfuse OTel integration looks for attributes like 'langfuse.evaluation.name' and 'langfuse.evaluation.value'.
   */
  logEvaluation(params: {
    name: string;
    value: number;
    comment?: string;
  }) {
    const span = this.getCurrentSpan();
    if (span) {
      span.setAttribute(`langfuse.evaluation.${params.name}.value`, params.value);
      if (params.comment) {
        span.setAttribute(`langfuse.evaluation.${params.name}.comment`, params.comment);
      }
      this.logger.debug(`Logged evaluation ${params.name}=${params.value} to current trace.`);
    } else {
      this.logger.warn(`No active span found when trying to log evaluation: ${params.name}`);
    }
  }

  /**
   * Attach metadata to the current trace (useful for filtering/grouping)
   */
  logMetadata(metadata: Record<string, any>) {
    const span = this.getCurrentSpan();
    if (span) {
      Object.entries(metadata).forEach(([key, value]) => {
        span.setAttribute(`langfuse.metadata.${key}`, JSON.stringify(value));
      });
    }
  }
}
