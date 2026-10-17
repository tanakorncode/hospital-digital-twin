import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from './db.service';
import { AppError } from './errors';

// Idempotent mutations: the client sends a fresh key per intended action (Idempotency-Key header, or `key` in a
// socket message) and repeats the same key when it retries. The server keeps key → request hash → result:
//   same key, same request  → the stored result, nothing done again
//   same key, other request → IDEMPOTENCY_KEY_REUSED
// Keys are scoped (e.g. "booking:create:patient:<id>") so one caller can never replay or probe another's keys.
// The hash is computed here from the canonical request — never taken from the client.
export const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const KEEP_DAYS = 7; // longer than any client retries; the record also explains a duplicate during an incident review

// JSON with object keys sorted, so {a,b} and {b,a} hash the same.
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const requestHash = (request: unknown) => createHash('sha256').update(canonical(request)).digest('hex');

@Injectable()
export class IdempotencyService {
  constructor(private readonly store: DbService) {
    this.purge();
  }

  // Run fn once per (scope, key) inside one transaction with its stored result — so the action and its record
  // are saved together or not at all. fn is synchronous (see DbService.tx). Failures (thrown) are not stored:
  // fixing the request and retrying with the same key is allowed.
  run<T>(scope: string, key: unknown, request: unknown, fn: () => T): { result: T; replayed: boolean } {
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw new AppError('VALIDATION_ERROR', 'รหัสคำขอไม่ถูกต้อง');
    const hash = requestHash(request);
    return this.store.tx(() => {
      const row = this.store.db.prepare('SELECT request_hash, result_json FROM idempotency_keys WHERE scope = ? AND key = ?').get(scope, key) as { request_hash: string; result_json: string } | undefined;
      if (row) {
        if (row.request_hash !== hash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'รหัสคำขอนี้ถูกใช้กับรายการอื่นแล้ว');
        return { result: JSON.parse(row.result_json) as T, replayed: true };
      }
      const result = fn();
      this.store.db.prepare('INSERT INTO idempotency_keys (scope, key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(scope, key, hash, JSON.stringify(result ?? null), new Date().toISOString());
      return { result, replayed: false };
    });
  }

  purge(now = Date.now()) {
    return this.store.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(now - KEEP_DAYS * 86_400_000).toISOString()).changes;
  }
}
