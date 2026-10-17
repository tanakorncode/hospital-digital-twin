import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppointmentService } from './appointment.service';
import { AuditService } from './audit.service';
import { BookingService } from './booking.service';
import { AppError } from './errors';
import { FeaturesService } from './features.service';
import { FlowGateway } from './flow.gateway';
import { IdempotencyService } from './idempotency.service';
import { devLoginAllowed, PatientIdentityService, type PatientSession } from './patient-identity.service';
import { TicketsService } from './tickets.service';
import { VisitsService } from './visits.service';

// The patient's own API, used by the LIFF pages inside LINE (REST, "Authorization: Bearer <app session>").
// Identity always comes from the verified session — never from an id in the request.
//   GET  /api/v1/patient/config        what the page needs to start (LIFF id; whether test sign-in is allowed)
//   POST /api/v1/patient/line/session  { idToken } → app session
//   GET  /api/v1/patient/me            linked or not (HN last 4 only)
//   POST /api/v1/patient/link/start    one-time QR + code to show at the counter
//   POST /api/v1/patient/link/unlink   end the link from the phone
//   POST /api/v1/patient/logout
// Linked patients only (stage 2.6):
//   GET  /queue                              today's queue numbers (+ the link to the live queue page) and today's bookings/appointments
//   GET  /booking/services, /booking/slots   what can be booked;  POST /bookings {slotId} (Idempotency-Key header)
//   GET  /bookings;  POST /bookings/:id/cancel {reason}
//   GET  /appointments;  GET /appointments/:id/slots?date=;  POST /appointments/:id/cancel {reason}
//   POST /appointments/:id/reschedule {slotId, reason}   moves at once, or files a request when the clinic approves moves
const LIMIT = { max: 30, windowMs: 60_000 };
// Opaque reference for the audit trail (not the LINE user id itself).
export const lineRef = (s: PatientSession) => `line:${createHash('sha256').update(s.subject).digest('hex').slice(0, 16)}`;

@Controller('api/v1/patient')
export class PatientController {
  private hits = new Map<string, number[]>();
  constructor(private readonly identity: PatientIdentityService, private readonly features: FeaturesService, private readonly audit: AuditService,
    private readonly booking: BookingService, private readonly appts: AppointmentService, private readonly visits: VisitsService, private readonly tickets: TicketsService,
    private readonly idempotency: IdempotencyService, private readonly gateway: FlowGateway) {}
  // A signed-in patient whose LINE account is linked to their hospital record.
  private linked(ip: string, auth: unknown): PatientSession & { profileId: string } {
    this.limit(ip);
    const s = this.identity.require(auth);
    if (!s.profileId) throw new AppError('FORBIDDEN', 'กรุณาเชื่อมบัญชีผู้ป่วยก่อน');
    return s as PatientSession & { profileId: string };
  }
  private who(s: PatientSession) { return { actorType: 'patient' as const, actorId: lineRef(s) }; }

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
  // ---- my queue ------------------------------------------------------------------------------------------------
  @Get('queue')
  queue(@Ip() ip: string, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    const visits = this.visits.forProfile(s.profileId).map((v) => ({ ...v, link: this.tickets.issue(v.id, 'LINE').token }));
    const today = this.booking.now().toLocaleDateString('sv-SE'), isToday = (iso: string) => new Date(iso).toLocaleDateString('sv-SE') === today;
    return { ok: true, visits,
      bookings: this.booking.forProfile(s.profileId).filter((b) => b.status === 'CONFIRMED' && isToday(b.startsAt)),
      appointments: this.appts.forProfile(s.profileId).filter((a) => a.status === 'CONFIRMED' && isToday(a.startsAt)) };
  }

  // ---- booking -----------------------------------------------------------------------------------------------
  @Get('booking/services')
  bookingServices(@Ip() ip: string, @Headers('authorization') auth?: string) {
    this.linked(ip, auth);
    if (!this.features.on('generalBooking')) return { ok: true, services: [] };
    return { ok: true, services: this.booking.policies().filter((p) => p.enabled).map((p) => ({ serviceCode: p.serviceCode, displayName: p.displayName, advanceDays: p.advanceDays, cancelCutoffMinutes: p.cancelCutoffMinutes })) };
  }
  @Get('booking/slots')
  bookingSlots(@Ip() ip: string, @Query('service') service: string, @Query('date') date: string, @Headers('authorization') auth?: string) {
    this.linked(ip, auth);
    this.features.require('generalBooking');
    return { ok: true, slots: this.booking.bookable(service, date).map(({ id, startsAt, endsAt, remaining }) => ({ id, startsAt, endsAt, remaining })) };
  }
  @Get('bookings')
  myBookings(@Ip() ip: string, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    return { ok: true, bookings: this.booking.forProfile(s.profileId) };
  }
  @Post('bookings')
  @HttpCode(200)
  book(@Ip() ip: string, @Body() body: { slotId?: unknown }, @Headers('authorization') auth?: string, @Headers('idempotency-key') key?: string) {
    const s = this.linked(ip, auth);
    this.features.require('generalBooking');
    const { result, replayed } = this.idempotency.run(`booking:create:patient:${s.profileId}`, key, { slotId: body?.slotId }, () =>
      this.booking.book(s.profileId, body?.slotId, 'LINE', lineRef(s)));
    if (!replayed) { this.audit.record({ ...this.who(s), action: 'booking.create', targetType: 'booking', targetId: result.id, meta: { channel: 'LINE', serviceCode: result.serviceCode } }); this.gateway.bookingChanged(result.serviceCode, result.startsAt); }
    return { ok: true, booking: result };
  }
  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancelBooking(@Ip() ip: string, @Param('id') id: string, @Body() body: { reason?: unknown }, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    const r = this.booking.cancel(id, body?.reason, { kind: 'patient', profileId: s.profileId });
    if (r.changed) { this.audit.record({ ...this.who(s), action: 'booking.cancel', targetType: 'booking', targetId: r.booking.id, reason: r.booking.cancellationReason }); this.gateway.bookingChanged(r.booking.serviceCode, r.booking.startsAt); }
    return { ok: true, booking: r.booking };
  }

  // ---- appointments ------------------------------------------------------------------------------------------
  @Get('appointments')
  myAppointments(@Ip() ip: string, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    return { ok: true, appointments: this.appts.forProfile(s.profileId),
      rules: Object.fromEntries(this.appts.policies().map((p) => [p.clinicCode, { cancelCutoffMinutes: p.cancelCutoffMinutes, rescheduleNeedsApproval: p.rescheduleNeedsApproval, advanceDays: p.advanceDays }])) };
  }
  @Get('appointments/:id/slots')
  appointmentSlots(@Ip() ip: string, @Param('id') id: string, @Query('date') date: string, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    return { ok: true, slots: this.appts.movableSlots(id, date, s.profileId).map(({ id: sid, startsAt, endsAt, remaining, providerName }) => ({ id: sid, startsAt, endsAt, remaining, providerName })) };
  }
  @Post('appointments/:id/cancel')
  @HttpCode(200)
  cancelAppointment(@Ip() ip: string, @Param('id') id: string, @Body() body: { reason?: unknown }, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    const r = this.appts.cancel(id, body?.reason, { kind: 'patient', profileId: s.profileId });
    if (r.changed) { this.audit.record({ ...this.who(s), action: 'appointment.cancel', targetType: 'appointment', targetId: r.appointment.id, reason: r.appointment.cancellationReason }); this.gateway.apptChanged(); }
    return { ok: true, appointment: r.appointment };
  }
  @Post('appointments/:id/reschedule')
  @HttpCode(200)
  rescheduleAppointment(@Ip() ip: string, @Param('id') id: string, @Body() body: { slotId?: unknown; reason?: unknown }, @Headers('authorization') auth?: string) {
    const s = this.linked(ip, auth);
    this.features.require('appointments');
    const r = this.appts.requestReschedule(id, body?.slotId, body?.reason, { kind: 'patient', profileId: s.profileId });
    this.audit.record({ ...this.who(s), action: r.immediate ? 'appointment.reschedule' : 'appointment.reschedule.request', targetType: 'appointment', targetId: r.appointment.id });
    this.gateway.apptChanged();
    return { ok: true, immediate: r.immediate, appointment: r.appointment };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Headers('authorization') auth?: string) {
    this.identity.logout(auth);
    return { ok: true };
  }
}
