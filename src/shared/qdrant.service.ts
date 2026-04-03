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

        const isNamed = !(vectorsConfig as any).size;
        const denseConfig = isNamed ? (vectorsConfig as any).dense : vectorsConfig;

        const hasSparse = !!info.config.params.sparse_vectors;

        if (!denseConfig || denseConfig.size !== requiredSize || !hasSparse) {
          this.logger.warn(
            `Collection ${this.collectionName} config mismatch or missing sparse vectors. Re-creating...`,
          );
          await this.client.deleteCollection(this.collectionName);
          await this.createCollection(requiredSize, requiredDistance);
        } else {
          this.logger.log(`Collection ${this.collectionName} is ready with Hybrid Search support.`);
        }
      } else {
        await this.createCollection(requiredSize, requiredDistance);
      }
    } catch (err: any) {
      this.logger.error(`Qdrant ensureCollection failed: ${err.message}`);
      throw err;
    }
  }

  private async createCollection(size: number, distance: string) {
    this.logger.log(`Creating collection ${this.collectionName} with size=${size}, distance=${distance}...`);

    await this.client.createCollection(this.collectionName, {
      vectors: {
        dense: {
          size,
          distance: distance as any,
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

    await this.client.createPayloadIndex(this.collectionName, {
      field_name: 'conversationId',
      field_schema: 'keyword',
    });

    await this.client.createPayloadIndex(this.collectionName, {
      field_name: 'createdAt',
      field_schema: 'datetime',
    });

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
            },
            payload,
          },
        ],
      });
    } catch (err: any) {
      const detail = err.response?.data?.status?.error || err.message;
      this.logger.error(`Qdrant upsert failed: ${detail}`);
      throw err;
    }
  }

  async hybridSearch(params: {
    denseVector: number[];
    textQuery: string;
    conversationId: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
  }) {
    this.logger.debug(`Performing Hybrid Search for conversation ${params.conversationId}`);

    const mustConditions: any[] = [{ key: 'conversationId', match: { value: params.conversationId } }];

    if (params.startDate || params.endDate) {
      const rangeCondition: any = {};
      if (params.startDate) rangeCondition.gte = params.startDate;
      if (params.endDate) rangeCondition.lte = params.endDate;
      mustConditions.push({ key: 'createdAt', range: rangeCondition });
    }

    try {
      return await this.client.query(this.collectionName, {
        prefetch: [
          {
            query: params.denseVector,
            using: 'dense',
            filter: { must: mustConditions },
            limit: (params.limit ?? 10) * 2,
          },
          {
            filter: {
              must: [...mustConditions],
              should: params.textQuery
                .split(/\s+/)
                .filter(Boolean)
                .map((token) => ({
                  key: 'text',
                  match: { text: token },
                })),
            },
            limit: (params.limit ?? 10) * 2,
          },
        ],
        query: {
          fusion: 'rrf',
        },
        limit: params.limit ?? 10,
        with_payload: true,
      });
    } catch (err: any) {
      this.logger.warn(`Hybrid Search failed, falling back to Vector Search: ${err.message}`);
      return this.search(params.denseVector, { conversationId: params.conversationId, limit: params.limit });
    }
  }

  /**
   * Bulk update displayName for all messages of a specific user
   */
  async updateUserDisplayName(userId: string, newDisplayName: string) {
    this.logger.log(`Updating displayName for userId ${userId} to "${newDisplayName}"`);

    try {
      await this.client.setPayload(this.collectionName, {
        wait: true,
        payload: {
          displayName: newDisplayName,
        },
        filter: {
          must: [
            {
              key: 'userId',
              match: { value: userId },
            },
          ],
        },
      });

      this.logger.log(`Updated displayName payload in Qdrant for user ${userId}`);
    } catch (err: any) {
      this.logger.error(`Failed to update displayName for user ${userId}: ${err.message}`);
      throw err;
    }
  }

  async search(vector: number[], filter: { conversationId: string; limit?: number }) {
    this.logger.debug(`Searching vector similarity (dense) for conversation ${filter.conversationId}`);
    try {
      return await this.client.search(this.collectionName, {
        vector: {
          name: 'dense',
          vector,
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
