import { Injectable, Logger } from '@nestjs/common';
import { OpenAIService } from '../shared/openai.service';
import { CriticOutput, CriticOutputSchema } from './schemas/critic-output.schema';

@Injectable()
export class CriticService {
  private readonly logger = new Logger(CriticService.name);

  private readonly SYSTEM_PROMPT = `
Bạn là một bộ đánh giá chất lượng câu trả lời AI (ai_zalo Critic).
Nhiệm vụ của bạn là so sánh CÂU TRẢ LỜI (Answer) với NGỮ CẢNH (Context) và CÂU HỎI (Question).

Bạn phải xác định:
1. Groundedness: Câu trả lời có hoàn toàn dựa trên thông tin trong Context không? (1.0 = hoàn toàn dựa trên context, 0.0 = không liên quan).
2. Completeness: Câu trả lời có trả lời đầy đủ câu hỏi không?
3. Hallucination Risk: Câu trả lời có chứa thông tin "bịa đặt" không có trong context không?

Quy tắc chấm điểm:
- Nếu một khẳng định (claim) trong Answer KHÔNG có trong Context, hãy đánh dấu là hallucination.
- Nếu Answer đúng nhưng Context không chứa thông tin đó, vẫn tính là low groundedness (vì trợ lý phải dựa trên tài liệu).
- Trả về verdict = PASS nếu: groundedness >= 0.7 VÀ hallucination_risk < 0.3.
- Trả về verdict = FAIL nếu: groundedness < 0.5 HOẶC hallucination_risk >= 0.5.
- Trả về verdict = PARTIAL cho các trường hợp ở giữa.
`;

  constructor(private readonly openai: OpenAIService) {}

  /**
   * Evaluate the quality of a generated RAG answer
   */
  async evaluate(params: {
    question: string;
    context: string;
    answer: string;
  }): Promise<CriticOutput> {
    this.logger.debug(`Evaluating answer quality for question: "${params.question.substring(0, 50)}..."`);

    const prompt = `
== CÂU HỎI ==
${params.question}

== NGỮ CẢNH (CONTEXT) ==
${params.context}

== CÂU TRẢ LỜI CẦN ĐÁNH GIÁ ==
${params.answer}

Hãy thực hiện đánh giá và trả về kết quả theo định dạng yêu cầu.
`;

    try {
      const result = await this.openai.structured(
        this.SYSTEM_PROMPT + prompt,
        CriticOutputSchema,
        'critic_evaluation'
      );

      this.logger.log(`Evaluation result: ${result.verdict} (Groundedness: ${result.groundedness}, Hallucination: ${result.hallucination_risk})`);
      return result;
    } catch (err: any) {
      this.logger.error(`Critic evaluation failed: ${err.message}`);
      // Fallback: Default to PARTIAL if evaluation fails to avoid blocking the user
      return {
        groundedness: 0.5,
        completeness: 0.5,
        hallucination_risk: 0.5,
        hallucinations: ['Lỗi hệ thống khi đánh giá chất lượng.'],
        verdict: 'PARTIAL',
        reasoning: 'Evaluation service error fallback.',
      };
    }
  }
}
