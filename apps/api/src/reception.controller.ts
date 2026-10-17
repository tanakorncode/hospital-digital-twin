import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { KioskDeviceService } from './kiosk-device.service';
import { ReceptionService } from './reception.service';

// Digital Reception kiosks (/reception), REST only — a kiosk opens no socket, so it never holds the live queue.
//   POST /api/reception/v1/kiosk/session          {credential} → kiosk token (15 min)   — the device signs in
//   POST /api/reception/v1/kiosk/session/refresh  → a fresh token
//   GET  /api/reception/v1/capabilities           what this kiosk may do now (voice / AI / queue info: off)
//   POST /api/reception/v1/sessions               a visitor starts (5 min idle)
//   POST /api/reception/v1/sessions/:id/turns     {input} → {turnId, status, response}   — rules + approved content only
//   POST /api/reception/v1/sessions/:id/help      call a member of staff to this kiosk
//   POST /api/reception/v1/sessions/:id/end       the visitor is done (screen back to the start)
//   GET  /api/reception/v1/places?q=              public places (directory / search)
// Kiosk calls carry "Authorization: Bearer <kiosk token>". Everything answers FEATURE_DISABLED while the switch is off.
const SIGN_IN_LIMIT = { max: 10, windowMs: 60_000 };

@Controller('api/reception/v1')
export class ReceptionController {
  private tries = new Map<string, number[]>();
  constructor(private readonly devices: KioskDeviceService, private readonly reception: ReceptionService, private readonly features: FeaturesService) {}

  private kiosk(auth?: string) {
    this.features.require('reception');
    return this.devices.kiosk(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
  }

  @Post('kiosk/session')
  @HttpCode(200)
  signIn(@Ip() ip: string, @Body() body: { credential?: unknown }) {
    this.features.require('reception');
    const now = Date.now(), list = (this.tries.get(ip) ?? []).filter((t) => now - t < SIGN_IN_LIMIT.windowMs);
    list.push(now); this.tries.set(ip, list);
    if (this.tries.size > 5000) this.tries.clear();
    if (list.length > SIGN_IN_LIMIT.max) throw new AppError('RATE_LIMITED', 'ลองบ่อยเกินไป กรุณารอสักครู่');
    const r = this.devices.signIn(body?.credential);
    return { ok: true, token: r.token, expiresInSeconds: r.expiresInSeconds, kiosk: { id: r.kiosk.id, name: r.kiosk.name } };
  }
  @Post('kiosk/session/refresh')
  @HttpCode(200)
  refresh(@Headers('authorization') auth?: string) {
    this.features.require('reception');
    return { ok: true, ...this.devices.refresh(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined) };
  }
  @Get('capabilities')
  capabilities(@Headers('authorization') auth?: string) {
    const k = this.kiosk(auth);
    const at = k.atCode ? this.reception.places().find((p) => p.code === k.atCode) : undefined;
    return { ok: true, kiosk: { id: k.id, name: k.name, at }, contact: process.env.HOSPITAL_CONTACT?.trim() || undefined,
      // Speech: the kiosk reads approved text with a voice installed on the kiosk itself (never a cloud voice).
      // Voice input (Release B) and an LLM (only after evaluation) are not built, so always off. Queue: as an administrator set it.
      capabilities: { wayfinding: true, speech: process.env.RECEPTION_SPEECH !== 'off', voiceInput: false, ai: false, generalQueueInfo: this.reception.settings().queueInfo, myQueue: this.reception.settings().myQueue } };
  }
  @Post('sessions')
  @HttpCode(200)
  start(@Headers('authorization') auth?: string) {
    return { ok: true, ...this.reception.start(this.kiosk(auth)) };
  }
  @Post('sessions/:id/turns')
  @HttpCode(200)
  turn(@Param('id') id: string, @Body() body: { input?: unknown }, @Headers('authorization') auth?: string) {
    return { ok: true, ...this.reception.turn(this.kiosk(auth), id, body?.input) };
  }
  @Post('sessions/:id/help')
  @HttpCode(200)
  help(@Param('id') id: string, @Headers('authorization') auth?: string) {
    const r = this.reception.requestHelp(this.kiosk(auth), id);
    return { ok: true, requestedAt: r.createdAt };
  }
  @Post('sessions/:id/end')
  @HttpCode(200)
  end(@Param('id') id: string, @Headers('authorization') auth?: string) {
    this.reception.end(this.kiosk(auth), id);
    return { ok: true };
  }
  @Get('places')
  places(@Query('q') q: string, @Headers('authorization') auth?: string) {
    this.kiosk(auth);
    return { ok: true, places: this.reception.places(q) };
  }
}
