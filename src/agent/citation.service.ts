import { Injectable, Logger } from '@nestjs/common';
import { GeminiService } from '../shared/gemini.service';
import { AskMessage } from '../ask/retriever.service';

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

    let formattedAnswer = params.answer;
    
    // Deterministic citation: Append sources list at the end
    const sourcesText = params.context
      .map((s, i) => `[${i + 1}] ${s.senderName}: "${(s.content || '').substring(0, 100).replace(/\n/g, ' ')}..." (${new Date(s.createdAt).toLocaleDateString('vi-VN')})`)
      .join('\n');

    return `${formattedAnswer}\n\n📌 Nguồn tham khảo:\n${sourcesText}`;
  }
}
