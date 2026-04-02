import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CohereClientV2 } from 'cohere-ai';

@Injectable()
export class RerankerService implements OnModuleInit {
  private readonly logger = new Logger(RerankerService.name);
  private cohere: CohereClientV2;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const apiKey = this.configService.get<string>('COHERE_API_KEY');
    if (apiKey) {
      this.cohere = new CohereClientV2({
        token: apiKey,
      });
      this.logger.log('RerankerService initialized with Cohere API.');
    } else {
      this.logger.warn('COHERE_API_KEY not found. Reranker will be disabled (fallback to original order).');
    }
  }

  /**
   * Rerank documents based on query relevance using Cohere V2
   */
  async rerank(params: {
    query: string;
    documents: { id: string; text: string; [key: string]: any }[];
    topN?: number;
  }): Promise<{ id: string; text: string; relevanceScore: number; [key: string]: any }[]> {
    if (!this.cohere || params.documents.length === 0) {
      return params.documents.slice(0, params.topN || params.documents.length).map(doc => ({
        ...doc,
        relevanceScore: 1.0,
      }));
    }

    const model = this.configService.get<string>('COHERE_RERANK_MODEL', 'rerank-v3.5');
    const topN = params.topN || this.configService.get<number>('RERANK_TOP_N', 5);

    try {
      this.logger.debug(`Reranking ${params.documents.length} docs for query: "${params.query}"`);
      
      const response = await this.cohere.rerank({
        model,
        query: params.query,
        documents: params.documents.map(d => d.text),
        topN,
      });

      // Map back to original documents
      const reranked = response.results.map(result => {
        const originalDoc = params.documents[result.index];
        return {
          ...originalDoc,
          relevanceScore: result.relevanceScore,
        };
      });

      return reranked;
    } catch (err: any) {
      this.logger.error(`Cohere rerank failed: ${err.message}`);
      // Fallback: return original docs limited to topN
      return params.documents.slice(0, topN).map(doc => ({
        ...doc,
        relevanceScore: 0.5,
      }));
    }
  }
}
