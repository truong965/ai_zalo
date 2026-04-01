import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { InternalClientService } from './internal-client.service';

@Global()
@Module({
  imports: [HttpModule],
  providers: [InternalClientService],
  exports: [InternalClientService],
})
export class InternalClientModule {}
