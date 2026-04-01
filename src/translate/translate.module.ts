import { Module } from '@nestjs/common';
import { TranslateService } from './translate.service';
import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [SharedModule],
  providers: [TranslateService],
  exports: [TranslateService],
})
export class TranslateModule {}
