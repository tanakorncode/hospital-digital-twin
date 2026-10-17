import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownActions } from '../lib/reception/client';
import { localThaiVoice, spoken } from '../lib/reception/speech';

// Digital Reception kiosk (browser side): it never uses a cloud voice, and acts only on the actions it knows.
test('speech uses a Thai voice installed on the kiosk only — never a cloud voice', () => {
  const cloud = { name: 'Google ไทย', lang: 'th-TH', localService: false };
  const local = { name: 'Kanya', lang: 'th-TH', localService: true };
  const english = { name: 'Samantha', lang: 'en-US', localService: true };
  assert.equal(localThaiVoice([cloud, english]), undefined, 'no local Thai voice: captions only');
  assert.equal(localThaiVoice([cloud, english, local]), local);
  assert.equal(localThaiVoice([{ name: 'x', lang: 'th_TH', localService: true }])?.name, 'x');
});

test('room numbers are read digit by digit; separators are not read out', () => {
  assert.equal(spoken('ห้องตรวจ 205 · ชั้น 2'), 'ห้องตรวจ สอง ศูนย์ ห้า ชั้น 2');
});

test('actions the kiosk does not know are dropped (no URLs, no commands)', () => {
  const list = knownActions([{ type: 'show_directory' }, { type: 'open_url', url: 'https://example.com' }, { type: 'run', cmd: 'x' }, null, 'show_menu', { type: 'offer_staff' }]);
  assert.deepEqual(list.map((a) => a.type), ['show_directory', 'offer_staff']);
  assert.deepEqual(knownActions(undefined), []);
});

test('"my queue" reads the token from the QR on the slip (its link) — nothing else', async () => {
  const { ticketToken } = await import('../components/reception/QueueViews');
  assert.equal(ticketToken('https://queue.hospital.go.th/q/AbCdEfGhIjKlMnOpQrStUv'), 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(ticketToken('  AbCdEfGhIjKlMnOpQrStUv\n'), 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(ticketToken('A123'), '', 'a queue number typed in is not enough');
  assert.equal(ticketToken('https://evil.example/x?y=<script>'), '');
});
