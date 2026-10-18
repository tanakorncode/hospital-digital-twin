import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query, Res } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuthService } from './auth.service';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { KioskDeviceService } from './kiosk-device.service';
import { ReceptionAvatarService } from './reception-avatar.service';
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
//   POST /api/reception/v1/kiosk/pair             {username, password} → a pairing ticket + the kiosks and places — set up on the kiosk
//   POST /api/reception/v1/kiosk/pair/finish      {ticket, kioskId | name + atCode} → this kiosk's credential
//   GET  /api/reception/v1/avatars/:id            an uploaded character model (GLB; ids are never reused, cached for good)
// Kiosk calls carry "Authorization: Bearer <kiosk token>". Everything answers FEATURE_DISABLED while the switch is off.
const SIGN_IN_LIMIT = { max: 10, windowMs: 60_000 };

@Controller('api/reception/v1')
export class ReceptionController {
  private tries = new Map<string, number[]>();
  constructor(private readonly devices: KioskDeviceService, private readonly reception: ReceptionService, private readonly features: FeaturesService,
    private readonly auth: AuthService, private readonly audit: AuditService, private readonly avatars: ReceptionAvatarService) {}
  private limit(ip: string) {
    const now = Date.now(), list = (this.tries.get(ip) ?? []).filter((t) => now - t < SIGN_IN_LIMIT.windowMs);
    list.push(now); this.tries.set(ip, list);
    if (this.tries.size > 5000) this.tries.clear();
    if (list.length > SIGN_IN_LIMIT.max) throw new AppError('RATE_LIMITED', 'ลองบ่อยเกินไป กรุณารอสักครู่');
  }

  private kiosk(auth?: string) {
    this.features.require('reception');
    return this.devices.kiosk(auth?.startsWith('Bearer ') ? auth.slice(7) : undefined);
  }

  @Post('kiosk/session')
  @HttpCode(200)
  signIn(@Ip() ip: string, @Body() body: { credential?: unknown }) {
    this.features.require('reception');
    this.limit(ip);
    const r = this.devices.signIn(body?.credential);
    return { ok: true, token: r.token, expiresInSeconds: r.expiresInSeconds, kiosk: { id: r.kiosk.id, name: r.kiosk.name } };
  }
  // Set up on the kiosk: an administrator signs in on it once. The staff session ends at once (the kiosk never keeps an
  // account); what stays is a ticket to pick this kiosk from the list, or add it.
  @Post('kiosk/pair')
  @HttpCode(200)
  pairStart(@Ip() ip: string, @Body() body: { username?: unknown; password?: unknown }) {
    this.features.require('reception');
    this.limit(ip);
    const r = this.auth.login(String(body?.username ?? ''), String(body?.password ?? ''), `kiosk-pair:${ip}`);
    if (!r.ok) throw new AppError('AUTH_REQUIRED', r.reason);
    this.auth.logout(r.token);
    if (r.user.role !== 'admin') throw new AppError('FORBIDDEN', 'ตั้งค่าตู้ได้เฉพาะผู้ดูแลระบบ');
    const t = this.devices.pairTicket(`user:${r.user.id}`);
    this.audit.record({ actorType: 'staff', actorId: `user:${r.user.id}`, action: 'reception.kiosk.pair.start', targetType: 'kiosk' });
    return { ok: true, ...t, admin: r.user.name,
      kiosks: this.devices.list().filter((k) => k.status === 'ACTIVE').map((k) => ({ id: k.id, name: k.name, atCode: k.atCode, lastSeenAt: k.lastSeenAt, online: this.devices.online(k) })),
      places: this.reception.places().map((p) => ({ code: p.code, nameTh: p.nameTh, whereTh: p.whereTh })) };
  }
  // This kiosk is one already registered (a new credential: one used elsewhere stops working) or a new one.
  @Post('kiosk/pair/finish')
  @HttpCode(200)
  pairFinish(@Ip() ip: string, @Body() body: { ticket?: unknown; kioskId?: unknown; name?: unknown; atCode?: unknown }) {
    this.features.require('reception');
    this.limit(ip);
    const by = this.devices.usePairTicket(body?.ticket);
    const r = body?.kioskId !== undefined ? this.devices.rotate(body.kioskId) : this.devices.save({ name: body?.name, atCode: body?.atCode }, by);
    this.audit.record({ actorType: 'staff', actorId: by, action: body?.kioskId !== undefined ? 'reception.kiosk.pair.rotate' : 'reception.kiosk.pair.create', targetType: 'kiosk', targetId: r.device.id });
    return { ok: true, credential: r.credential, kiosk: { id: r.device.id, name: r.device.name } };
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
      avatar: this.avatars.settings(),
      capabilities: { wayfinding: true, speech: process.env.RECEPTION_SPEECH !== 'off', voiceInput: false, ai: false, generalQueueInfo: this.reception.settings().queueInfo, myQueue: this.reception.settings().myQueue } };
  }
  // The character's model: public like the floor pictures (a mascot, nothing about anyone).
  @Get('avatars/:id')
  avatar(@Param('id') id: string, @Res() res: { setHeader: (k: string, v: string) => void; end: (b: Uint8Array) => void }) {
    const bytes = this.avatars.bytes(id);
    if (!bytes) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบไฟล์ตัวละคร');
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(bytes);
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
