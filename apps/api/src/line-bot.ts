import { normalize, placeIn, whereTh } from './intent-rules';
import type { Destination } from './wayfinding.service';

// What the hospital's LINE OA says back, and its rich menu (stage 2.x follow-up to the Phase 2 plan, items 9.1–9.2).
// The bot never looks a person up: anything personal (my queue, my bookings, my appointments) is a button that opens
// the patient's own pages (LIFF), where the patient is signed in. So no reply ever carries patient data.
// Settings (apps/api/.env): LINE_LIFF_ID (buttons open the LIFF app), PUBLIC_URL (e.g. https://queue.hospital.go.th —
// used for map links and when there is no LIFF id), HOSPITAL_CONTACT (what "ติดต่อเจ้าหน้าที่" answers).
export type View = 'queue' | 'book' | 'appts' | 'map' | 'link';
export type Quick = { label: string; uri?: string; text?: string };
export type Answer = { text: string; quick: Quick[] };
const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
// A button target: inside LINE (LIFF) when set up, else the same page on the hospital's site.
export const viewUrl = (v: View) => process.env.LINE_LIFF_ID ? `https://liff.line.me/${process.env.LINE_LIFF_ID}?view=${v}` : base() ? `${base()}/liff?view=${v}` : '';
export const contactText = () => process.env.HOSPITAL_CONTACT?.trim() || 'ติดต่อจุดประชาสัมพันธ์ของโรงพยาบาล หรือโทรเบอร์กลางของโรงพยาบาล';

const menu = (): Quick[] => [...([['คิวของฉัน', 'queue'], ['จองคิว', 'book'], ['นัดหมาย', 'appts'], ['แผนที่', 'map']] as [string, View][])
  .map(([label, v]): Quick => ({ label, uri: viewUrl(v) })).filter((q) => q.uri), { label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' }];
const go = (v: View, text: string): Answer => ({ text: viewUrl(v) ? text : `${text}\n(โรงพยาบาลยังไม่ได้เปิดหน้านี้ใน LINE · สอบถามเคาน์เตอร์)`, quick: menu() });

export const WELCOME = 'ยินดีต้อนรับสู่บริการผู้ป่วยผ่าน LINE 🙏\nกดเมนูด้านล่างเพื่อดูคิว จองคิว ดูนัดหมาย หรือหาทางในโรงพยาบาล\nครั้งแรก: กด "เชื่อมบัญชี" แล้วแสดงหน้าจอที่เคาน์เตอร์พร้อมบัตรประชาชน';
const HELP = 'พิมพ์ได้เช่น "คิว" "จองคิว" "นัด" "ห้องยาอยู่ไหน" หรือกดเมนูด้านล่าง';

// One message in → one answer. `places`: the hospital's public wayfinding places.
export function answer(raw: string, places: Destination[]): Answer {
  const text = normalize(raw);
  // "Where is …": the longest place name found in the message (rules shared with the reception kiosks).
  const place = placeIn(text, places);
  if (place) {
    const link = base() ? `\nดูเส้นทาง: ${base()}/wayfinding?to=${encodeURIComponent(place.code)}` : '';
    const where = `${place.nameTh} อยู่ที่${whereTh(place)}`;
    return { text: `📍 ${where}${place.landmarkTh ? `\n${place.landmarkTh}` : ''}${link}`, quick: menu() };
  }
  if (/(อยู่ไหน|อยู่ตรงไหน|ไปยังไง|ไปทางไหน|ทางไป|แผนที่|หาไม่เจอ)/.test(text)) return go('map', '🗺️ ค้นหาจุดบริการและเส้นทางได้ในเมนู "แผนที่" · ในโรงพยาบาลสแกนป้าย QR ตามจุดต่าง ๆ ได้');
  if (/(ติดต่อ|เจ้าหน้าที่|โทร|สอบถาม|ช่วยด้วย)/.test(text)) return { text: `☎️ ${contactText()}`, quick: menu() };
  if (/(เชื่อม|ผูกบัญชี|ลงทะเบียน line|สมัคร)/i.test(text)) return go('link', '🔗 เชื่อมบัญชีผู้ป่วย: กดเมนู "เชื่อมบัญชี" แล้วนำหน้าจอไปแสดงที่เคาน์เตอร์พร้อมบัตรประชาชน (ทำครั้งเดียว)');
  if (/(นัด|เลื่อน|หมอ|แพทย์)/.test(text)) return go('appts', '📅 ดูนัด ขอเลื่อน หรือยกเลิกนัด ได้ในเมนู "นัดหมาย"');
  if (/(จอง)/.test(text)) return go('book', '🗓️ จองคิวล่วงหน้าได้ในเมนู "จองคิว"');
  if (/(คิว|ถึงไหน|รอนาน|เลขที่)/.test(text)) return go('queue', '🔢 ดูหมายเลขคิว ลำดับ และเวลารอของคุณได้ในเมนู "คิวของฉัน"');
  return { text: HELP, quick: menu() };
}

// LINE message objects (quick reply buttons: max 13, label ≤ 20 characters).
export function toMessage(a: Answer) {
  const items = a.quick.slice(0, 13).map((q) => ({ type: 'action', action: q.uri ? { type: 'uri', label: q.label.slice(0, 20), uri: q.uri } : { type: 'message', label: q.label.slice(0, 20), text: q.text! } }));
  return { type: 'text', text: a.text, ...(items.length ? { quickReply: { items } } : {}) };
}

// The rich menu: 2500 × 1686, three columns × two rows (the web draws the matching image).
export const RICH_MENU = { width: 2500, height: 1686 };
export const RICH_MENU_TILES: { label: string; sub: string; view?: View; text?: string }[] = [
  { label: 'คิวของฉัน', sub: 'ลำดับและเวลารอ', view: 'queue' }, { label: 'จองคิว', sub: 'จองล่วงหน้า', view: 'book' }, { label: 'นัดหมาย', sub: 'ดู · เลื่อน · ยกเลิก', view: 'appts' },
  { label: 'แผนที่', sub: 'ทางไปจุดบริการ', view: 'map' }, { label: 'เชื่อมบัญชี', sub: 'ทำครั้งเดียวที่เคาน์เตอร์', view: 'link' }, { label: 'ติดต่อเจ้าหน้าที่', sub: 'สอบถาม', text: 'ติดต่อเจ้าหน้าที่' },
];
export function richMenuBody() {
  const w = Math.floor(RICH_MENU.width / 3), h = Math.floor(RICH_MENU.height / 2);
  return { size: RICH_MENU, selected: true, name: 'HDT เมนูผู้ป่วย', chatBarText: 'เมนู',
    areas: RICH_MENU_TILES.map((t, i) => ({ bounds: { x: (i % 3) * w, y: Math.floor(i / 3) * h, width: i % 3 === 2 ? RICH_MENU.width - 2 * w : w, height: h },
      action: t.view ? { type: 'uri', label: t.label, uri: viewUrl(t.view) } : { type: 'message', label: t.label, text: t.text! } })) };
}
