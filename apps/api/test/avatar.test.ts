import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppError } from '../src/errors';
import { glbInfo } from '../src/reception-avatar.service';
import { ADMIN_PASSWORD, makeApi, receptionController, signIn } from './helpers';

// The reception kiosk's character: 2D or 3D, the web's default model or one an administrator uploaded (in pieces).
// A model is checked on arrival — and what it holds noted, so Settings can say whether it moves (skeleton, animations).
type R = { ok: boolean; code?: string; reason?: string; uploadId?: string; done?: boolean; avatar?: { id: string; triangles: number; rigged: boolean; animations: string[]; size: number }; settings?: { mode: string; id: string | null } };
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AppError).code; } return undefined; };
// A GLB with the given JSON and `bin` bytes of payload.
function glb(json: object, bin = 12): Uint8Array {
  const js = Buffer.from(JSON.stringify(json)), jp = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]), bp = Buffer.alloc(bin + ((4 - (bin % 4)) % 4));
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jp.length + 8 + bp.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(jp.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bp.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return new Uint8Array(Buffer.concat([head, c1, jp, c2, bp]));
}
const mesh = (tris: number, extra: object = {}) => ({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], accessors: [{ count: tris * 3 }, { count: tris * 3 }], ...extra });

test('a model is checked: GLB 2.0 with a surface, readable here, not too detailed — and what it holds is noted', () => {
  assert.deepEqual(glbInfo(glb(mesh(80_000, { textures: [{}, {}, {}] }))), { triangles: 80_000, textures: 3, rigged: false, animations: [] });
  assert.deepEqual(glbInfo(glb(mesh(5_000, { skins: [{}], animations: [{ name: 'Idle' }, { name: 'Wave' }, {}] }))).animations, ['Idle', 'Wave', 'animation 3']);
  assert.equal(codeOf(() => glbInfo(new Uint8Array(Buffer.from('not a model at all, sorry')))), 'VALIDATION_ERROR');
  assert.equal(codeOf(() => glbInfo(glb({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }], accessors: [{ count: 40960 }] }))), 'VALIDATION_ERROR', 'a point cloud has no surface');
  assert.equal(codeOf(() => glbInfo(glb(mesh(10, { extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] })))), 'VALIDATION_ERROR', 'Draco needs a decoder from elsewhere');
  assert.equal(codeOf(() => glbInfo(glb(mesh(500_000)))), 'VALIDATION_ERROR', 'too detailed for a kiosk');
  assert.equal(glbInfo(glb(mesh(10, { extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression'] }))).triangles, 10, 'meshopt is read without help');
});

test('administrators upload a model in pieces, choose 2D / 3D and which model; kiosks are told and fetch it publicly', () => {
  const api = makeApi(), admin = signIn(api, 'admin', ADMIN_PASSWORD), ctl = receptionController(api);
  api.gateway.saveUser(admin, { username: 'staff.av', name: 'เอวี', role: 'staff', password: 'password-8' });
  const staff = signIn(api, 'staff.av', 'password-8');
  assert.deepEqual((api.gateway.receptionAvatar(admin) as R).settings, { mode: '3d', id: null }, '3D with the default model to start with');
  const file = glb(mesh(20_000, { skins: [{}], animations: [{ name: 'Idle' }, { name: 'Wave' }] }), 3_100_000); // 3 pieces of ≤ 2 MB
  const pieces = [file.subarray(0, 2_000_000), file.subarray(2_000_000)];
  assert.equal((api.gateway.receptionAvatarUpload(staff, { index: 0, total: 2, name: 'x.glb', bytes: pieces[0] }) as R).code, 'FORBIDDEN');
  const first = api.gateway.receptionAvatarUpload(admin, { index: 0, total: 2, name: 'jaidee-rigged.glb', bytes: pieces[0] }) as R;
  assert.equal(first.done, false);
  assert.equal((api.gateway.receptionAvatarUpload(admin, { uploadId: first.uploadId, index: 2, total: 2, bytes: pieces[1] }) as R).code, 'VALIDATION_ERROR', 'out of order');
  const last = api.gateway.receptionAvatarUpload(admin, { uploadId: first.uploadId, index: 1, total: 2, bytes: pieces[1] }) as R;
  assert.equal(last.done, true, last.reason);
  assert.deepEqual([last.avatar!.triangles, last.avatar!.rigged, last.avatar!.animations, last.avatar!.size], [20_000, true, ['Idle', 'Wave'], file.length]);
  // a broken file is refused at the end, nothing stored
  const junk = api.gateway.receptionAvatarUpload(admin, { index: 0, total: 1, name: 'pc.glb', bytes: glb({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }], accessors: [{ count: 9 }] }) }) as R;
  assert.equal(junk.code, 'VALIDATION_ERROR');
  assert.equal((api.gateway.receptionAvatar(admin) as { avatars: unknown[] }).avatars.length, 1);
  // choose it; the kiosk's capabilities say so, and the file is served
  assert.equal((api.gateway.receptionAvatarSet(admin, { mode: '3d', id: last.avatar!.id }) as R).ok, true);
  api.gateway.setFeatures(admin, { patch: { reception: true } });
  const made = api.gateway.saveKiosk(admin, { name: 'ตู้ทดสอบ' }) as { credential: string };
  const auth = `Bearer ${ctl.signIn('10.2.0.1', { credential: made.credential }).token}`;
  assert.deepEqual((ctl.capabilities(auth) as unknown as { avatar: unknown }).avatar, { mode: '3d', id: last.avatar!.id });
  let sent: Uint8Array | undefined; const headers: Record<string, string> = {};
  ctl.avatar(last.avatar!.id, { setHeader: (k, v) => { headers[k] = v; }, end: (b) => { sent = b; } });
  assert.equal(sent!.length, file.length); assert.equal(headers['Content-Type'], 'model/gltf-binary');
  // a model in use stays; back to 2D / the default
  assert.equal((api.gateway.receptionAvatarDelete(admin, { id: last.avatar!.id }) as R).code, 'INVALID_STATE_TRANSITION');
  assert.deepEqual((api.gateway.receptionAvatarSet(admin, { mode: '2d', id: null }) as R).settings, { mode: '2d', id: null });
  assert.equal((api.gateway.receptionAvatarDelete(admin, { id: last.avatar!.id }) as R).ok, true);
  assert.equal((api.gateway.receptionAvatarSet(admin, { id: last.avatar!.id }) as R).code, 'RESOURCE_NOT_FOUND');
});
