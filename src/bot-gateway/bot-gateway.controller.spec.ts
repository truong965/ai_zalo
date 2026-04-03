import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { BotGatewayController } from './bot-gateway.controller';
import { BotGatewayService } from './bot-gateway.service';
import { ConfigService } from '@nestjs/config';

describe('BotGatewayController', () => {
  let controller: BotGatewayController;
  let botGatewayService: { handleTrigger: ReturnType<typeof jest.fn> };
  let configService: { get: ReturnType<typeof jest.fn> };

  beforeEach(async () => {
    const handleTrigger = jest.fn(async () => ({ ok: true }));

    botGatewayService = {
      handleTrigger,
    };

    configService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BotGatewayController],
      providers: [
        {
          provide: BotGatewayService,
          useValue: botGatewayService,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    controller = module.get<BotGatewayController>(BotGatewayController);
  });

  it('accepts INTERNAL_API_KEY when validating trigger auth', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'INTERNAL_API_KEY') {
        return 'shared-secret';
      }

      return undefined;
    });

    await expect(
      controller.handleTrigger({ type: 'translate' }, 'shared-secret'),
    ).resolves.toEqual({ ok: true });

    expect(botGatewayService.handleTrigger).toHaveBeenCalledWith({ type: 'translate' });
  });

  it('falls back to MAIN_APP_INTERNAL_API_KEY when INTERNAL_API_KEY is absent', async () => {
    configService.get.mockImplementation((key: string) => {
      if (key === 'MAIN_APP_INTERNAL_API_KEY') {
        return 'legacy-secret';
      }

      return undefined;
    });

    await expect(
      controller.handleTrigger({ type: 'translate' }, 'legacy-secret'),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects mismatched keys', async () => {
    configService.get.mockReturnValue('shared-secret');

    await expect(
      controller.handleTrigger({ type: 'translate' }, 'wrong-secret'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
