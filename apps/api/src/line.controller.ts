import { Controller, HttpCode, HttpException, HttpStatus, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { LineService } from './line.service';

// LINE Messaging API webhook (set it in the LINE Developers console: https://<domain>/line/webhook).
// Every request is checked against the channel secret before anything is read.
@Controller('line')
export class LineController {
  constructor(private readonly line: LineService) {}
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<{ headers: Record<string, string | string[] | undefined>; body: Parameters<LineService['handleWebhook']>[0] }>) {
    if (!this.line.enabled) throw new HttpException('LINE is not configured', HttpStatus.SERVICE_UNAVAILABLE);
    if (!this.line.verify(req.rawBody, req.headers['x-line-signature'] as string | undefined)) throw new HttpException('bad signature', HttpStatus.UNAUTHORIZED);
    await this.line.handleWebhook(req.body);
    return { ok: true };
  }
}
