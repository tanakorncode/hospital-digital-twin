import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DbService } from './db.service';
import { AppError } from './errors';

// The kiosk's character ("น้องใจดี"): drawn in 2D by the kiosk itself, or a 3D model (GLB). The web ships a default
// model; an administrator may upload another (Settings → ตู้ต้อนรับ), e.g. the same character rigged with gestures.
// A model is checked when it arrives — a glTF 2.0 binary the kiosk can draw without anything fetched from elsewhere
// (no Draco / Basis: their decoders would come from a CDN) — and what it holds is noted: triangles, textures, whether
// it has a skeleton, and its animations (the kiosk plays those whose names match its states: Idle, Wave, Talk…).
// Uploads come in pieces (sockets carry at most ~3 MB a message); a piece left over for 10 minutes is dropped.
export type AvatarMode = '2d' | '3d';
export type AvatarSettings = { mode: AvatarMode; id: string | null }; // id: an uploaded model; null = the web's default
export type AvatarInfo = { id: string; name: string; size: number; triangles: number; textures: number; rigged: boolean; animations: string[]; uploadedAt: string; uploadedBy: string };
const KEY = 'reception.avatar';
const MAX_BYTES = 12_000_000, MAX_PIECE = 2_000_000, MAX_TRIANGLES = 400_000, PIECE_TTL = 10 * 60_000;
// Extensions three.js reads on its own (no extra decoder to download).
const SUPPORTED = new Set(['KHR_mesh_quantization', 'EXT_meshopt_compression', 'KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_materials_unlit',
  'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_specular', 'KHR_materials_ior', 'KHR_materials_transmission', 'KHR_materials_volume',
  'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'EXT_texture_webp', 'KHR_lights_punctual']);
const bad = (reason: string) => new AppError('VALIDATION_ERROR', reason);

// What a GLB holds, or why it cannot be used.
export function glbInfo(buf: Uint8Array): { triangles: number; textures: number; rigged: boolean; animations: string[] } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 20 || v.getUint32(0, true) !== 0x46546c67) throw bad('ไม่ใช่ไฟล์ GLB (glTF แบบไฟล์เดียว)');
  if (v.getUint32(4, true) !== 2) throw bad('รองรับเฉพาะ glTF 2.0');
  const jsonLen = v.getUint32(12, true);
  if (v.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > buf.length) throw bad('ไฟล์ GLB ไม่สมบูรณ์');
  let j: { meshes?: { primitives?: { mode?: number; indices?: number; attributes?: Record<string, number> }[] }[]; accessors?: { count?: number }[];
    textures?: unknown[]; skins?: unknown[]; animations?: { name?: string }[]; extensionsRequired?: string[]; extensionsUsed?: string[] };
  try { j = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen))); } catch { throw bad('ไฟล์ GLB ไม่สมบูรณ์'); }
  const unknown = [...new Set([...(j.extensionsRequired ?? []), ...(j.extensionsUsed ?? [])])].filter((e) => !SUPPORTED.has(e));
  if (unknown.some((e) => e === 'KHR_draco_mesh_compression')) throw bad('ไฟล์บีบอัดแบบ Draco ใช้ไม่ได้ (ตู้ต้องโหลดตัวถอดรหัสจากภายนอก) — ส่งออกแบบไม่บีบอัด หรือใช้ gltfpack -cc (meshopt)');
  if (unknown.some((e) => e === 'KHR_texture_basisu')) throw bad('ภาพพื้นผิวแบบ KTX2/Basis ใช้ไม่ได้ — ส่งออกเป็น PNG / JPEG / WebP');
  if ((j.extensionsRequired ?? []).some((e) => !SUPPORTED.has(e))) throw bad(`ไฟล์ต้องใช้ส่วนขยายที่ตู้ไม่รองรับ: ${unknown.join(', ')}`);
  let triangles = 0;
  for (const m of j.meshes ?? []) for (const p of m.primitives ?? []) {
    const mode = p.mode ?? 4; if (mode !== 4 && mode !== 5 && mode !== 6) continue;
    const n = p.indices !== undefined ? j.accessors?.[p.indices]?.count ?? 0 : j.accessors?.[p.attributes?.POSITION ?? -1]?.count ?? 0;
    triangles += mode === 4 ? Math.floor(n / 3) : Math.max(0, n - 2);
  }
  if (!triangles) throw bad('ไม่พบพื้นผิวในไฟล์ (ไฟล์ point cloud หรือไม่มีโมเดล) — ใช้ไฟล์โมเดลที่มีพื้นผิว');
  if (triangles > MAX_TRIANGLES) throw bad(`โมเดลละเอียดเกินไป (${triangles.toLocaleString()} สามเหลี่ยม) — ลดให้ไม่เกิน ${MAX_TRIANGLES.toLocaleString()} เช่น gltfpack -si 0.1`);
  return { triangles, textures: j.textures?.length ?? 0, rigged: !!j.skins?.length, animations: (j.animations ?? []).map((a, i) => a.name?.trim() || `animation ${i + 1}`).slice(0, 40) };
}

@Injectable()
export class ReceptionAvatarService {
  now = () => new Date();
  private uploads = new Map<string, { by: string; name: string; total: number; pieces: Uint8Array[]; size: number; started: number }>();
  constructor(private readonly store: DbService) {}

  // 3D with the web's default model until an administrator says otherwise.
  settings(): AvatarSettings {
    const s = this.store.getKv<Partial<AvatarSettings>>(KEY) ?? {};
    const id = typeof s.id === 'string' && this.get(s.id) ? s.id : null;
    return { mode: s.mode === '2d' ? '2d' : '3d', id };
  }
  setSettings(input: { mode?: unknown; id?: unknown }): AvatarSettings {
    const cur = this.settings();
    const mode = input.mode === undefined ? cur.mode : input.mode === '2d' || input.mode === '3d' ? input.mode : undefined;
    if (!mode) throw bad('เลือก 2D หรือ 3D');
    const id = input.id === undefined ? cur.id : input.id === null || input.id === '' ? null : typeof input.id === 'string' && this.get(input.id) ? input.id : undefined;
    if (id === undefined) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบไฟล์ตัวละครนี้');
    this.store.setKv(KEY, { mode, id });
    return { mode, id };
  }

  list(): AvatarInfo[] {
    return (this.store.db.prepare('SELECT id, name, length(bytes) AS size, info_json, uploaded_at, uploaded_by FROM reception_avatars ORDER BY uploaded_at DESC').all() as
      { id: string; name: string; size: number; info_json: string; uploaded_at: string; uploaded_by: string }[])
      .map((r) => ({ id: r.id, name: r.name, size: r.size, ...JSON.parse(r.info_json), uploadedAt: r.uploaded_at, uploadedBy: r.uploaded_by }));
  }
  get(id: unknown): AvatarInfo | undefined { return typeof id === 'string' ? this.list().find((a) => a.id === id) : undefined; }
  bytes(id: unknown): Uint8Array | undefined {
    if (typeof id !== 'string' || !/^av_[A-Za-z0-9_-]{6,20}$/.test(id)) return undefined;
    return (this.store.db.prepare('SELECT bytes FROM reception_avatars WHERE id = ?').get(id) as { bytes: Uint8Array } | undefined)?.bytes;
  }

  // One piece of an upload (index 0 starts it and gets the upload's id back). The last piece checks and stores the model.
  piece(by: string, input: { uploadId?: unknown; name?: unknown; index?: unknown; total?: unknown; bytes?: unknown }): { uploadId: string; done: false } | { done: true; avatar: AvatarInfo } {
    const now = this.now().getTime();
    for (const [k, u] of this.uploads) if (now - u.started > PIECE_TTL) this.uploads.delete(k);
    const buf = input.bytes instanceof Uint8Array ? input.bytes : input.bytes instanceof ArrayBuffer ? new Uint8Array(input.bytes) : null;
    if (!buf || !buf.length || buf.length > MAX_PIECE) throw bad('ส่งไฟล์ไม่สำเร็จ ลองใหม่');
    const index = Number(input.index), total = Number(input.total);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > Math.ceil(MAX_BYTES / MAX_PIECE) || index < 0 || index >= total) throw bad(`ไฟล์ใหญ่เกิน ${MAX_BYTES / 1e6} MB`);
    let id = typeof input.uploadId === 'string' ? input.uploadId : '';
    if (index === 0) {
      id = `up_${randomBytes(9).toString('base64url')}`;
      this.uploads.set(id, { by, name: typeof input.name === 'string' ? input.name.slice(0, 120) : 'model.glb', total, pieces: [], size: 0, started: now });
    }
    const u = this.uploads.get(id);
    if (!u || u.by !== by || u.total !== total || u.pieces.length !== index) throw bad('การส่งไฟล์ขาดตอน — เลือกไฟล์แล้วส่งใหม่');
    u.pieces.push(buf); u.size += buf.length;
    if (u.size > MAX_BYTES) { this.uploads.delete(id); throw bad(`ไฟล์ใหญ่เกิน ${MAX_BYTES / 1e6} MB`); }
    if (u.pieces.length < u.total) return { uploadId: id, done: false };
    this.uploads.delete(id);
    const all = new Uint8Array(u.size); let at = 0; for (const p of u.pieces) { all.set(p, at); at += p.length; }
    const info = glbInfo(all), avId = `av_${randomBytes(9).toString('base64url')}`, when = this.now().toISOString();
    this.store.db.prepare('INSERT INTO reception_avatars (id, name, bytes, info_json, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(avId, u.name, all, JSON.stringify(info), when, by);
    return { done: true, avatar: this.get(avId)! };
  }
  // A model in use cannot go; choose another (or the default) first.
  delete(id: unknown) {
    const a = this.get(id);
    if (!a) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบไฟล์ตัวละครนี้');
    if (this.settings().id === a.id) throw new AppError('INVALID_STATE_TRANSITION', 'ไฟล์นี้กำลังใช้อยู่ — เลือกตัวละครอื่นก่อนลบ');
    this.store.db.prepare('DELETE FROM reception_avatars WHERE id = ?').run(a.id);
  }
}
