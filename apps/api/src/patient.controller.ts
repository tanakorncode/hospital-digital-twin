import { Body, Controller, Get, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from './audit.service';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { devLoginAllowed, PatientIdentityService, type PatientSession } from './patient-identity.service';

// The patient's own API, used by the LIFF pages inside LINE (REST, "Authorization: Bearer <app session>").
// Identity always comes from the verified session — never from an id in the request.
//   GET  /api/v1/patient/config        what the page needs to start (LIFF id; whether test sign-in is allowed)
//   POST /api/v1/patient/line/session  { idToken } → app session
//   GET  /api/v1/patient/me            linked or not (HN last 4 only)
//   POST /api/v1/patient/link/start    one-time QR + code to show at the counter
//   POST /api/v1/patient/link/unlink   end the link from the phone
//   POST /api/v1/patient/logout
const LIMIT = { max: 30, windowMs: 60_000 };
// Opaque reference for the audit trail (not the LINE user id itself).
export const lineRef = (s: PatientSession) => `line:${createHash('sha256').update(s.subject).digest('hex').slice(0, 16)}`;

@Controller('api/v1/patient')
export class PatientController {
  private hits = new Map<string, number[]>();
  constructor(private readonly identity: PatientIdentityService, private readonly features: FeaturesService, private readonly audit: AuditService) {}

  // Per client address: enough for a person, too few for guessing.
  private limit(ip: string) {
    const now = Date.now(), list = (this.hits.get(ip) ?? []).filter((t) => now - t < LIMIT.windowMs);
    list.push(now); this.hits.set(ip, list);
    if (this.hits.size > 5000) this.hits.clear();
    if (list.length > LIMIT.max) throw new AppError('RATE_LIMITED', 'ทำรายการถี่เกินไป กรุณารอสักครู่');
  }

  @Get('config')
  config() {
    return { ok: true, liffId: process.env.LINE_LIFF_ID || null, devLogin: devLoginAllowed(), linking: this.features.on('accountLinking') };
  }
  @Post('line/session')
  @HttpCode(200)
  async session(@Ip() ip: string, @Body() body: { idToken?: unknown }) {
    this.limit(ip);
    return { ok: true, ...(await this.identity.startSession(body?.idToken)) };
  }
  @Get('me')
  me(@Ip() ip: string, @Headers('authorization') auth?: string) {
    this.limit(ip);
    return { ok: true, ...this.identity.me(this.identity.require(auth)) };
  }
  @Post('link/start')
  @HttpCode(200)
  startLink(@Ip() ip: string, @Headers('authorization') auth?: string) {
    this.limit(ip);
    const s = this.identity.require(auth);
    this.features.require('accountLinking');
    return { ok: true, ...this.identity.startLink(s) };
  }
  @Post('link/unlink')
  @HttpCode(200)
  unlink(@Ip() ip: string, @Headers('authorization') auth?: string) {
    this.limit(ip);
    const s = this.identity.require(auth);
    if (this.identity.unlink(s)) this.audit.record({ actorType: 'patient', actorId: lineRef(s), action: 'line.unlink', targetType: 'line-link' });
    return { ok: true, linked: false };
  }
  @Post('logout')
  @HttpCode(200)
  logout(@Headers('authorization') auth?: string) {
    this.identity.logout(auth);
    return { ok: true };
  }
}
