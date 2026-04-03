import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers?.['x-internal-api-key'];
    const secret = this.configService.get<string>('INTERNAL_API_KEY');

    if (!secret || apiKey !== secret) {
      throw new UnauthorizedException('Invalid API Key');
    }

    return true;
  }
}
