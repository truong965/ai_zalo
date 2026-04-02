import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;
  private collectionName: string;

  constructor(private configService: ConfigService) {
    this.client = new QdrantClient({
      url: this.configService.getOrThrow<string>('QDRANT_URL'),
      apiKey: this.configService.getOrThrow<string>('QDRANT_API_KEY'),
    });
    this.collectionName = this.configService.get<string>('QDRANT_COLLECTION_NAME', 'chat_messages');
  }

  async onModuleInit() {
    this.logger.log(`QdrantService initialized. Target collection: ${this.collectionName}`);
    await this.ensureCollection();
  }

  private async ensureCollection() {
    const requiredSize = this.configService.get<number>('QDRANT_VECTOR_SIZE', 768);
    const requiredDistance = 'Cosine';

    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collectionName);

      if (exists) {
        const info = await this.client.getCollection(this.collectionName);
        const vectorsConfig = info.config.params.vectors;
        
        // Check if using named vectors (object) or single vector (object with size)
        const isNamed = !(vectorsConfig as any).size;
        const denseConfig = isNamed ? (vectorsConfig as any).dense : vectorsConfig;
        
        const hasSparse = !!info.config.params.sparse_vectors;

        if (!denseConfig || denseConfig.size !== requiredSize || !hasSparse) {
          this.logger.warn(
            `Collection ${this.collectionName} config mismatch or missing sparse vectors. Re-creating...`
          );
          await this.client.deleteCollection(this.collectionName);
          await this.createCollection(requiredSize, requiredDistance);
        } else {
          this.logger.log(`Collection ${this.collectionName} is ready with Hybrid Search support.`);
        }
      } else {
        this.logger.log(`Collection ${this.collectionName} not found. Creating...`);
        await this.createCollection(requiredSize, requiredDistance);
      }
    } catch (err: any) {
      this.logger.error(`Failed to ensure Qdrant collection: ${err.message}`);
    }
  }

  private async createCollection(size: number, distance: any) {
    await this.client.createCollection(this.collectionName, {
      vectors: {
        dense: {
          size,
          distance,
        },
      },
      sparse_vectors: {
        sparse: {
          index: {
            on_disk: true,
          },
        },
      },
    });

    // Add indexes for faster filtering
    await this.client.createPayloadIndex(this.collectionName, {
      field_name: 'conversationId',
      field_schema: 'keyword',
    });

    await this.client.createPayloadIndex(this.collectionName, {
      field_name: 'createdAt',
      field_schema: 'datetime',
    });

    // Full-text index for BM25 search
    await this.client.createPayloadIndex(this.collectionName, {
      field_name: 'text',
      field_schema: 'text',
    });
    
    this.logger.log(`Collection ${this.collectionName} created with Hybrid Search (Dense: ${size} + Sparse)`);
  }

  async upsert(messageId: string, denseVector: number[], payload: any) {
    this.logger.debug(`Upserting message ${messageId} to Qdrant`);
    
    const pointId = !isNaN(Number(messageId)) ? Number(messageId) : messageId;

    try {
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: {
              dense: denseVector,
              // Sparse vector will be automatically indexed if we use Qdrant's internal 
              // but here we are using manual payload text + full-text index for BM25.
              // Note: If using Qdrant's sparse vectors feature properly, we'd need to provide sparse indices/values.
              // For now, we rely on Dense + Text Search if sparse is not fully manual.
            },
            payload: payload,
          },
        ],
      });
    } catch (err: any) {
      const detail = err.response?.data?.status?.error || err.message;
      this.logger.error(`Qdrant upsert failed: ${detail}`);
      throw err;
    }
  }

  /**
   * Hybrid Search using RRF (Reciprocal Rank Fusion)
   */
  async hybridSearch(params: {
    denseVector: number[];
    textQuery: string;
    conversationId: string;
    limit?: number;
  }) {
    this.logger.debug(`Performing Hybrid Search for conversation ${params.conversationId}`);
    
    try {
      // In Qdrant 1.10+, we use universal query API for RRF
      // If version is older, we'd do 2 searches and merge.
      // Assuming 2026 stack => Qdrant 1.10+
      return await this.client.query(this.collectionName, {
        prefetch: [
          {
            query: params.denseVector,
            using: 'dense',
            filter: {
              must: [{ key: 'conversationId', match: { value: params.conversationId } }],
            },
            limit: (params.limit ?? 10) * 2,
          },
          {
            filter: {
              must: [
                { key: 'text', match: { text: params.textQuery } },
                { key: 'conversationId', match: { value: params.conversationId } },
              ],
            },
            limit: (params.limit ?? 10) * 2,
          },
        ],
        query: {
            fusion: 'rrf'
        },
        limit: params.limit ?? 10,
        with_payload: true,
      });
    } catch (err: any) {
      this.logger.warn(`Hybrid Search failed, falling back to Vector Search: ${err.message}`);
      return this.search(params.denseVector, { conversationId: params.conversationId, limit: params.limit });
    }
  }

  async search(vector: number[], filter: { conversationId: string; limit?: number }) {
    this.logger.debug(`Searching vector similarity (dense) for conversation ${filter.conversationId}`);
    try {
      return await this.client.search(this.collectionName, {
        vector: {
          name: 'dense',
          vector: vector,
        },
        filter: {
          must: [
            {
              key: 'conversationId',
              match: {
                value: filter.conversationId,
              },
            },
          ],
        },
        limit: filter.limit ?? 10,
        with_payload: true,
      });
    } catch (err: any) {
      this.logger.error(`Qdrant search failed: ${err.message}`);
      throw err;
    }
  }

  async clearCollection() {
    this.logger.warn(`Clearing all data in collection ${this.collectionName}...`);
    try {
      await this.client.deleteCollection(this.collectionName);
      await this.ensureCollection();
      this.logger.log(`Collection ${this.collectionName} cleared and reset.`);
    } catch (err: any) {
      this.logger.error(`Failed to clear collection: ${err.message}`);
      throw err;
    }
  }
}
