import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { SessionCacheService } from './session-cache.service';

type ListSessionsQuery = {
  userId: string;
  conversationId?: string;
  featureType?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
};

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionCache: SessionCacheService,
  ) {}

  async listSessions(query: ListSessionsQuery) {
    const where: any = {
      userId: query.userId,
    };

    if (query.featureType) {
      where.featureType = query.featureType;
    }

    if (query.conversationId) {
      where.conversationId = query.conversationId;
    }

    if (query.activeOnly) {
      where.isActive = true;
    }

    const sessions = await this.prisma.aiSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
      include: {
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    return { sessions };
  }

  async getSession(id: string, userId: string) {
    const session = await this.prisma.aiSession.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this session');
    }

    return {
      session: {
        ...session,
        messages: session.messages.map((message) => ({
          ...message,
          id: message.id.toString(),
        })),
      },
    };
  }

  async deleteSession(id: string, userId: string) {
    const session = await this.prisma.aiSession.findUnique({
      where: { id },
      select: { id: true, userId: true, isActive: true },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this session');
    }

    await this.sessionCache.softDeleteSession(id, userId);

    return {
      success: true,
      sessionId: id,
    };
  }
}