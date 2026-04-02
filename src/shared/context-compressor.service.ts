import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIService } from './openai.service';
import { z } from 'zod';

const CompressedContextSchema = z.object({
  compressedContext: z.string().describe('The distilled, relevant context for the query.'),
  originalTokens: z.number().nullable(),
  compressedTokens: z.number().nullable(),
  compressionRatio: z.number().nullable(),
});

@Injectable()
export class ContextCompressorService {
  private readonly logger = new Logger(ContextCompressorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly openAIService: OpenAIService,
  ) {}

  /**
   * Compresses retrieved context to only the most relevant parts using GPT-5 Nano.
   * This reduces prompt length and focuses the LLM on specific information.
   */
  async compress(params: {
    question: string;
    contexts: string[];
    maxTokens?: number;
  }): Promise<string> {
    if (params.contexts.length === 0) return '';
    
    // Check if compression is needed based on threshold
    const totalLength = params.contexts.reduce((acc, c) => acc + c.length, 0);
    const threshold = this.configService.get<number>('CONTEXT_COMPRESSION_THRESHOLD', 1000);
    
    if (totalLength < threshold) {
      this.logger.debug(`Context size ${totalLength} < threshold ${threshold}. Skipping compression.`);
      return params.contexts.join('\n\n---\n\n');
    }

    try {
      this.logger.debug(`Compressing context for query: "${params.question}" (${params.contexts.length} chunks)`);
      
      const prompt = `Bạn là một chuyên gia nén ngữ cảnh RAG. 
Nhiệm vụ của bạn là trích xuất các câu hoặc ý quan trọng nhất từ NGỮ CẢNH dưới đây để trả lời CÂU HỎI. 
Hãy giữ lại các thông tin như tên người gửi, thời gian, và các số liệu cụ thể. Loại bỏ các phần rườm rà không liên quan.

== CÂU HỎI ==
${params.question}

== NGỮ CẢNH ==
${params.contexts.join('\n\n---\n\n')}

Hãy cung cấp bản nén súc tích nhất nhưng vẫn đảm bảo tính chính xác và đầy đủ cho câu hỏi.`;

      const result = await this.openAIService.structured(
        prompt,
        CompressedContextSchema,
        'ContextCompression',
        { temperature: 0, maxTokens: params.maxTokens }
      );

      this.logger.log(`Context compressed. Ratio: ${result.compressionRatio}, Chars: ${result.compressedContext.length}`);
      return result.compressedContext;
    } catch (err: any) {
      this.logger.error(`Context compression failed: ${err.message}. Falling back to full context.`);
      return params.contexts.join('\n\n---\n\n');
    }
  }
}
