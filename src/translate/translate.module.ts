import { Module } from '@nestjs/common';
import { TranslateService } from './translate.service';
import { SharedModule } from '../shared/shared.module';
import { SessionModule } from '../sessions/session.module';
import { InternalClientModule } from '../internal-client/internal-client.module';

@Module({
  imports: [SharedModule, InternalClientModule, SessionModule],
  providers: [TranslateService],
  exports: [TranslateService],
})
export class TranslateModule {}
