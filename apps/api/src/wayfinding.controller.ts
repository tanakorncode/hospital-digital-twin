import { Controller, Get, Ip, Param } from '@nestjs/common';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { WayfindingService } from './wayfinding.service';

// Public (no sign-in): what a QR sign or the LINE map needs. Places only — nothing about any patient.
//   GET /api/v1/wayfinding/destinations         every public place in use
//   GET /api/v1/wayfinding/destinations/:code   one place; a retired one answers with where it went
const LIMIT = { max: 60, windowMs: 60_000 };
@Controller('api/v1/wayfinding')
export class WayfindingController {
  private hits = new Map<string, number[]>();
  constructor(private readonly wayfinding: WayfindingService, private readonly features: FeaturesService) {}
  private guard(ip: string) {
    const now = Date.now(), list = (this.hits.get(ip) ?? []).filter((t) => now - t < LIMIT.windowMs);
    list.push(now); this.hits.set(ip, list);
    if (this.hits.size > 5000) this.hits.clear();
    if (list.length > LIMIT.max) throw new AppError('RATE_LIMITED', 'ทำรายการถี่เกินไป กรุณารอสักครู่');
    this.features.require('wayfinding');
  }
  @Get('destinations')
  destinations(@Ip() ip: string) {
    this.guard(ip);
    return { ok: true, destinations: this.wayfinding.list() };
  }
  @Get('destinations/:code')
  destination(@Ip() ip: string, @Param('code') code: string) {
    this.guard(ip);
    return { ok: true, ...this.wayfinding.lookup(code) };
  }
}
