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
    const requiredSize = this.configService.get<number>('QDRANT_VECTOR_SIZE', 3072);
    const requiredDistance = 'Cosine';

    try {
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c) => c.name === this.collectionName);

      if (exists) {
        // Check current specs
        const info = await this.client.getCollection(this.collectionName);
        const currentConfig = info.config.params.vectors;
        
        // Handle different vector configurations (Qdrant can have multiple, but here we use single default)
        const currentSize = (currentConfig as any).size;
        const currentDistance = (currentConfig as any).distance;

        if (currentSize !== requiredSize || currentDistance !== requiredDistance) {
          this.logger.warn(
            `Collection ${this.collectionName} dimension mismatch (Expected: ${requiredSize}, Found: ${currentSize}). Re-creating...`
          );
          await this.client.deleteCollection(this.collectionName);
          await this.createCollection(requiredSize, requiredDistance);
        } else {
          this.logger.log(`Collection ${this.collectionName} is ready (Size: ${currentSize})`);
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
        size,
        distance,
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
    
    this.logger.log(`Collection ${this.collectionName} created with size ${size}`);
  }

  async upsert(messageId: string, vector: number[], payload: any) {
    this.logger.debug(`Upserting message ${messageId} to Qdrant (Vector size: ${vector.length})`);
    
    // Qdrant IDs must be UUIDs or unsigned integers.
    // If messageId is purely numeric, we should pass it as a Number.
    const pointId = !isNaN(Number(messageId)) ? Number(messageId) : messageId;

    try {
      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector: vector,
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

  async search(vector: number[], filter: { conversationId: string; limit?: number }) {
    this.logger.debug(`Searching similarity for conversation ${filter.conversationId}`);
    try {
      return await this.client.search(this.collectionName, {
        vector: vector,
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

  /**
   * Clears all data by deleting and recreating the collection
   */
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
