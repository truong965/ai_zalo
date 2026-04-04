import { Injectable, Logger } from '@nestjs/common';
import { LlmGatewayService } from '../shared/llm-gateway.service';
import { RelevanceJudgment, RelevanceJudgmentSchema, RewrittenQueries, RewrittenQueriesSchema } from './schemas/crag.schema';

@Injectable()
export class CragService {
  private readonly logger = new Logger(CragService.name);

  constructor(private readonly openai: LlmGatewayService) {}

  /**
   * Grade the relevance of retrieved documents to the user question
   */
  async gradeDocuments(params: {
    question: string;
    documents: any[];
  }): Promise<RelevanceJudgment> {
    this.logger.debug(`Grading ${params.documents.length} documents for: "${params.question}"`);

    if (params.documents.length === 0) {
      return {
        verdict: 'INCORRECT',
        score: 0,
        reasoning: 'No documents retrieved.'
      };
    }

    const docContext = params.documents
      .map((d, i) => `Document [${i + 1}]: ${d.content || d.text}`)
      .join('\n\n');

    const systemPrompt = `
Bạn là một trợ lý đánh giá mức độ liên quan của tài liệu cho hệ thống RAG (ai_zalo).
Nhiệm vụ: Đánh giá xem CÂU HỎI của người dùng có thể được trả lời bằng cách sử dụng các TÀI LIỆU được cung cấp hay không.

Tiêu chí đánh giá:
- "CORRECT": Tài liệu chứa thông tin trực tiếp hoặc gián tiếp đầy đủ để trả lời câu hỏi.
- "AMBIGUOUS": Tài liệu có liên quan nhưng không hoàn toàn đầy đủ, hoặc cần thêm thông tin để chắc chắn.
- "INCORRECT": Tài liệu hoàn toàn không chứa thông tin liên quan đến câu hỏi.

Bạn phải trả về verdict: CORRECT, AMBIGUOUS, hoặc INCORRECT kèm theo điểm số (0-1).
`;

    const prompt = `
== CÂU HỎI ==
${params.question}

== TÀI LIỆU (Context) ==
${docContext}
`;

    try {
      return await this.openai.structured(
        systemPrompt + prompt,
        RelevanceJudgmentSchema,
        'relevance_judgment'
      );
    } catch (err: any) {
      this.logger.error(`CRAG grading failed: ${err.message}`);
      // Fallback: Assume Ambiguous to trigger rewrite/retry if grading fails
      return {
        verdict: 'AMBIGUOUS',
        score: 0.5,
        reasoning: 'Relevance grading failed. Falling back to retry.'
      };
    }
  }

  /**
   * Rewrite the user question into better search queries
   */
  async rewriteQuery(params: {
    question: string;
    reasoning?: string;
  }): Promise<RewrittenQueries> {
    this.logger.debug(`Rewriting query for better recall: "${params.question}"`);

    const systemPrompt = `
Bạn là một chuyên gia tối ưu hóa truy vấn tìm kiếm (Query Rewriter).
Nhiệm vụ: Viết lại "Câu hỏi gốc" của người dùng thành 2-3 truy vấn tìm kiếm khác nhau để tăng khả năng tìm thấy thông tin liên quan trong lịch sử chat.
Hãy tập trung vào các từ khóa chính, các biến thể của câu hỏi và ngữ cảnh tiềm năng.

Trả về mảng 2-3 truy vấn ngắn gọn.
`;

    const prompt = `
== CÂU HỎI GỐC ==
${params.question}

== LÝ DO CẦN VIẾT LẠI ==
${params.reasoning || 'Tài liệu tìm thấy trước đó không đủ liên quan.'}
`;

    try {
      return await this.openai.structured(
        systemPrompt + prompt,
        RewrittenQueriesSchema,
        'query_rewrite'
      );
    } catch (err: any) {
      this.logger.error(`CRAG rewrite failed: ${err.message}`);
      // Fallback: Use original question if rewrite fails
      return {
        queries: [params.question],
        reasoning: 'Rewrite service error fallback.'
      };
    }
  }
}
