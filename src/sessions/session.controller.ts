import { Controller, Delete, Get, Logger, Param, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { SessionService } from './session.service';
import { ParseUUIDPipe } from '@nestjs/common';
import { InternalApiKeyGuard } from './internal-api-key.guard';

@Controller('sessions')
@UseGuards(InternalApiKeyGuard)
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(private readonly sessionService: SessionService) {}

  @Get()
  async listSessions(
    @Query('userId') userId: string,
    @Query('conversationId') conversationId?: string,
    @Query('featureType') featureType?: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Missing userId');
    }

    this.logger.debug(`Listing sessions for user ${userId}`);
    return this.sessionService.listSessions({
      userId,
      conversationId,
      featureType,
      activeOnly: activeOnly === undefined ? true : activeOnly !== 'false' && activeOnly !== '0',
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get(':id')
  async getSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Missing userId');
    }

    this.logger.debug(`Fetching session ${id} for user ${userId}`);
    return this.sessionService.getSession(id, userId);
  }

  @Delete(':id')
  async deleteSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new UnauthorizedException('Missing userId');
    }

    this.logger.debug(`Soft-deleting session ${id} for user ${userId}`);
    return this.sessionService.deleteSession(id, userId);
  }
}