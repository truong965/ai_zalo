import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { AiFeatureType, Prisma } from '../../prisma/generated/client';
import { PrismaService } from '../database/prisma.service';

type CreateSessionInput = {
  userId: string;
  conversationId: string;
  featureType: AiFeatureType;
  title?: string;
  contextSnapshot: Prisma.InputJsonValue;
  lastMessageIdSynced?: string;
  expiresAt?: Date;
};

type SessionLimitPolicy = {
  userId: string;
  conversationId: string;
  featureType: AiFeatureType;
  maxActive: number;
};

@Injectable()
export class SessionCacheService {
  private readonly logger = new Logger(SessionCacheService.name);
  private readonly SESSION_META_TTL_SECONDS = 60 * 60;
  private readonly SESSION_MESSAGES_TTL_SECONDS = 60 * 60;
  private readonly USER_ACTIVE_SESSIONS_TTL_SECONDS = 30 * 60;
  private readonly TRANSLATION_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
  private readonly SESSION_MESSAGES_CACHE_MAX = 50;
  private readonly ASK_SESSION_LOCK_SECONDS = 5;
  private readonly LOCK_MAX_ATTEMPTS = 8;
  private readonly LOCK_RETRY_BASE_MS = 80;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async createSession(input: CreateSessionInput) {
    const session = await this.prisma.aiSession.create({
      data: {
        userId: input.userId,
        conversationId: input.conversationId,
        featureType: input.featureType,
        title: input.title,
        contextSnapshot: input.contextSnapshot,
        lastMessageIdSynced: input.lastMessageIdSynced,
        expiresAt: input.expiresAt,
      },
    });

    await this.writeSessionMetaCache(session.id, session);
    await this.invalidateUserActiveSessionsCache(input.userId);
    return session;
  }

  async findActiveSession(userId: string, conversationId: string, featureType: AiFeatureType) {
    return this.prisma.aiSession.findFirst({
      where: {
        userId,
        conversationId,
        featureType,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listRecentSessions(userId: string, conversationId: string, featureType: AiFeatureType, limit: number) {
    return this.prisma.aiSession.findMany({
      where: {
        userId,
        conversationId,
        featureType,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getSessionById(sessionId: string) {
    const key = this.sessionMetaKey(sessionId);
    const cached = await this.readJsonCache<any>(key, this.SESSION_META_TTL_SECONDS);
    if (cached) return cached;

    const session = await this.prisma.aiSession.findUnique({ where: { id: sessionId } });
    if (session) {
      await this.writeSessionMetaCache(sessionId, session);
    }
    return session;
  }

  async getSessionMessages(sessionId: string, limit = 20) {
    const key = this.sessionMessagesKey(sessionId);
    const cached = await this.readJsonCache<any[]>(key, this.SESSION_MESSAGES_TTL_SECONDS);
    if (cached) {
      return cached.slice(-limit);
    }

    const rows = await this.prisma.aiMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: Math.max(limit, this.SESSION_MESSAGES_CACHE_MAX),
    });

    const ordered = rows.reverse().map((row) => ({
      ...row,
      id: row.id.toString(),
    }));

    const compact = ordered.slice(-this.SESSION_MESSAGES_CACHE_MAX);
    await this.writeJsonCache(key, compact, this.SESSION_MESSAGES_TTL_SECONDS);
    return compact.slice(-limit);
  }

  async addSessionMessage(
    sessionId: string,
    role: string,
    content: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    const message = await this.prisma.aiMessage.create({
      data: {
        sessionId,
        role,
        content,
        metadata,
      },
    });

    const key = this.sessionMessagesKey(sessionId);
    const existing = await this.readJsonCache<any[]>(key, this.SESSION_MESSAGES_TTL_SECONDS);
    if (existing) {
      const merged = [
        ...existing,
        {
          ...message,
          id: message.id.toString(),
        },
      ];
      await this.writeJsonCache(
        key,
        merged.slice(-this.SESSION_MESSAGES_CACHE_MAX),
        this.SESSION_MESSAGES_TTL_SECONDS,
      );
    }

    return {
      ...message,
      id: message.id.toString(),
    };
  }

  async updateSessionSyncMarker(sessionId: string, lastMessageIdSynced: string | null) {
    const updated = await this.prisma.aiSession.update({
      where: { id: sessionId },
      data: { lastMessageIdSynced: lastMessageIdSynced ?? undefined },
    });

    await this.writeSessionMetaCache(sessionId, updated);
    return updated;
  }

  async softDeleteSession(sessionId: string, userId: string) {
    const updated = await this.prisma.aiSession.update({
      where: { id: sessionId },
      data: { isActive: false },
    });

    await this.invalidateSessionCache(sessionId, userId);

    return updated;
  }

  async invalidateSessionCache(sessionId: string, userId?: string) {
    await Promise.all([
      this.redis.del(this.sessionMetaKey(sessionId)),
      this.redis.del(this.sessionMessagesKey(sessionId)),
      ...(userId ? [this.invalidateUserActiveSessionsCache(userId)] : []),
    ]);
  }

  async invalidateActiveSessionsCache(userId: string) {
    await this.invalidateUserActiveSessionsCache(userId);
  }

  async enforceSessionLimit(policy: SessionLimitPolicy) {
    const sessions = await this.prisma.aiSession.findMany({
      where: {
        userId: policy.userId,
        conversationId: policy.conversationId,
        featureType: policy.featureType,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (sessions.length <= policy.maxActive) return;

    const toDeactivate = sessions.slice(policy.maxActive).map((s) => s.id);
    await this.prisma.aiSession.updateMany({
      where: { id: { in: toDeactivate } },
      data: { isActive: false },
    });

    await Promise.all([
      this.invalidateUserActiveSessionsCache(policy.userId),
      ...toDeactivate.map((id) => this.redis.del(this.sessionMetaKey(id))),
      ...toDeactivate.map((id) => this.redis.del(this.sessionMessagesKey(id))),
    ]);

    this.logger.debug(`Soft-deactivated ${toDeactivate.length} sessions for ${policy.featureType}`);
  }

  async getTranslationCache(messageId: string, targetLang: string) {
    return this.readJsonCache<any>(
      this.translationCacheKey(messageId, targetLang),
      this.TRANSLATION_CACHE_TTL_SECONDS,
    );
  }

  async setTranslationCache(messageId: string, targetLang: string, value: unknown) {
    await this.writeJsonCache(
      this.translationCacheKey(messageId, targetLang),
      value,
      this.TRANSLATION_CACHE_TTL_SECONDS,
    );
  }

  async getUserActiveSessions(userId: string) {
    const key = this.userActiveSessionsKey(userId);
    const cached = await this.readJsonCache<any[]>(key, this.USER_ACTIVE_SESSIONS_TTL_SECONDS);
    if (cached) return cached;

    const sessions = await this.prisma.aiSession.findMany({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        conversationId: true,
        featureType: true,
        updatedAt: true,
      },
    });

    await this.writeJsonCache(key, sessions, this.USER_ACTIVE_SESSIONS_TTL_SECONDS);
    return sessions;
  }

  async getOrCreateActiveAskSession(input: Omit<CreateSessionInput, 'featureType'>) {
    const lockKey = `ai:lock:ask:${input.userId}:${input.conversationId}`;
    const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    try {
      return await this.withLock(lockKey, lockToken, async () => {
        const existing = await this.findActiveSession(
          input.userId,
          input.conversationId,
          AiFeatureType.ASK,
        );
        if (existing) return existing;

        return this.createSession({
          ...input,
          featureType: AiFeatureType.ASK,
        });
      });
    } catch (error: any) {
      // Graceful fallback under transient contention: re-check for a session created by a competing request.
      if (error?.message?.includes('Unable to acquire lock')) {
        for (let i = 0; i < 4; i += 1) {
          await this.delay(100 + i * 75);
          const existing = await this.findActiveSession(
            input.userId,
            input.conversationId,
            AiFeatureType.ASK,
          );
          if (existing) return existing;
        }
      }

      throw error;
    }
  }

  private async invalidateUserActiveSessionsCache(userId: string) {
    await this.redis.del(this.userActiveSessionsKey(userId));
  }

  private sessionMetaKey(sessionId: string) {
    return `ai:session:${sessionId}:meta`;
  }

  private sessionMessagesKey(sessionId: string) {
    return `ai:session:${sessionId}:messages`;
  }

  private userActiveSessionsKey(userId: string) {
    return `ai:user:${userId}:active_sessions`;
  }

  private translationCacheKey(messageId: string, targetLang: string) {
    return `ai:translation:${messageId}:${targetLang}`;
  }

  private async writeSessionMetaCache(sessionId: string, value: unknown) {
    await this.writeJsonCache(this.sessionMetaKey(sessionId), value, this.SESSION_META_TTL_SECONDS);
  }

  private async readJsonCache<T>(key: string, ttlSeconds: number): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;

      await this.redis.expire(key, ttlSeconds);
      return JSON.parse(raw) as T;
    } catch (error: any) {
      this.logger.warn(`Cache read failed for key ${key}: ${error.message}`);
      return null;
    }
  }

  private async writeJsonCache(key: string, value: unknown, ttlSeconds: number) {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error: any) {
      this.logger.warn(`Cache write failed for key ${key}: ${error.message}`);
    }
  }

  private async withLock<T>(key: string, token: string, callback: () => Promise<T>) {
    let acquired = false;

    for (let attempt = 1; attempt <= this.LOCK_MAX_ATTEMPTS; attempt += 1) {
      acquired = await this.tryAcquireLock(key, token);
      if (acquired) break;

      if (attempt < this.LOCK_MAX_ATTEMPTS) {
        const jitter = Math.floor(Math.random() * 40);
        const waitMs = this.LOCK_RETRY_BASE_MS * attempt + jitter;
        await this.delay(waitMs);
      }
    }

    if (!acquired) {
      throw new Error(`Unable to acquire lock for key ${key}`);
    }

    try {
      return await callback();
    } finally {
      await this.releaseLock(key, token);
    }
  }

  private async tryAcquireLock(key: string, token: string) {
    try {
      const result = await this.redis.set(
        key,
        token,
        'EX',
        this.ASK_SESSION_LOCK_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (error: any) {
      this.logger.warn(`Failed to acquire lock ${key}: ${error.message}`);
      return false;
    }
  }

  private async releaseLock(key: string, token: string) {
    // Only lock owner can delete the key.
    const lua = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
    try {
      await this.redis.eval(lua, 1, key, token);
    } catch (error: any) {
      this.logger.warn(`Failed to release lock ${key}: ${error.message}`);
    }
  }

  private async delay(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
