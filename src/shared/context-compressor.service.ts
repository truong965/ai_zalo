import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmGatewayService } from './llm-gateway.service';

@Injectable()
export class ContextCompressorService {
  private readonly logger = new Logger(ContextCompressorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly llmGateway: LlmGatewayService,
  ) { }

  /**
   * Compresses retrieved context to only the most relevant parts.
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
      this.logger.debug(`Compressing context with LLM for query: "${params.question}" (${params.contexts.length} chunks)`);

      const prompt = `Bạn là một chuyên gia nén ngữ cảnh RAG cho ứng dụng chat. 
Nhiệm vụ của bạn là trích xuất các thông tin/câu/đoạn quan trọng nhất từ NGỮ CẢNH dưới đây để trả lời CÂU HỎI. 

QUY TẮC NÉN:
1. Giữ lại các thông tin như tên người gửi, thời gian cụ thể của tin nhắn, và các số liệu.
2. Nếu ngữ cảnh chứa các tin nhắn có vẻ là tương lai hoặc quá khứ xa nhưng có mốc thời gian khớp với CÂU HỎI, tuyệt đối không được lọc bỏ.
3. Loại bỏ các phần rườm rà, chào hỏi không liên quan.
4. Chỉ trả về nội dung đã nén, không thêm lời dẫn. Nếu không có gì liên quan, hãy trả về bản nén cực ngắn chứa các mốc thời gian chính.

== CÂU HỎI ==
${params.question}

== NGỮ CẢNH ==
${params.contexts.join('\n\n---\n\n')}

Phần nén:`;

      const compressedContext = await this.llmGateway.generateText(prompt, {
        temperature: 0.1,
        maxTokens: params.maxTokens
      });

      // Safety Fallback: Nếu kết quả nén quá ngắn (< 50 ký tự) trong khi đầu vào dài, dùng bản gốc
      if (compressedContext.length < 50 && totalLength > 200) {
        this.logger.warn(`Compression gave suspiciously short output (${compressedContext.length} chars). Falling back to original context.`);
        return params.contexts.join('\n\n---\n\n');
      }

      this.logger.log(`Context compressed with LLM. Chars: ${compressedContext.length} (Original: ${totalLength})`);
      return compressedContext;
    } catch (err: any) {
      this.logger.error(`Context compression failed: ${err.message}. Falling back to full context.`);
      return params.contexts.join('\n\n---\n\n');
    }
  }
}
