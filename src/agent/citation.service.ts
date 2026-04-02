import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { AskMessage } from '../ask/ask.service';

@Injectable()
export class CitationService {
  private readonly logger = new Logger(CitationService.name);

  constructor(private readonly gemini: GeminiService) {}

  /**
   * Format an answer with citations from the provided context
   */
  async formatWithCitations(params: {
    answer: string;
    context: AskMessage[];
    question: string;
  }): Promise<string> {
    this.logger.debug(`Enforcing citations for answer of length: ${params.answer.length}`);

    // If no context, nothing to cite
    if (!params.context || params.context.length === 0) {
      return params.answer;
    }

    const contextStr = params.context
      .map(m => `ID: ${m.id} | User: ${m.senderName} | Content: ${m.content}`)
      .join('\n');

    const prompt = `
Bạn là một chuyên gia hiệu đính hồ sơ.
Nhiệm vụ: Chèn các dẫn nguồn (citations) vào CÂU TRẢ LỜI dựa trên các TÀI LIỆU được cung cấp.

Quy tắc:
1. Mỗi khẳng định sự thật trong câu trả lời phải có dẫn nguồn đi kèm.
2. Định dạng dẫn nguồn là [src:ID] ngay sau câu khẳng định.
3. Nếu câu trả lời đã có dẫn nguồn, hãy kiểm tra tính chính xác của ID và định dạng lại nếu cần.
4. Chỉ dẫn nguồn từ các ID có trong danh sách tài liệu.
5. Giữ nguyên nội dung và văn phong của câu trả lời gốc, chỉ chèn thêm các marker dẫn nguồn.

== DANH SÁCH TÀI LIỆU ==
${contextStr}

== CÂU TRẢ LỜI GỐC ==
${params.answer}

Trả về câu trả lời đã được chèn dẫn nguồn:
`;

    try {
      const formatted = await this.gemini.generateText(prompt, { temperature: 0.1 });
      return formatted || params.answer;
    } catch (err: any) {
      this.logger.error(`Citation enforcement failed: ${err.message}`);
      return params.answer;
    }
  }
}
