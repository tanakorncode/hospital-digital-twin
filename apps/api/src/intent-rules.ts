import type { Destination } from './wayfinding.service';

// Deterministic understanding of a short Thai question — shared by the LINE chatbot (line-bot.ts) and the Digital
// Reception kiosks (reception.service.ts). Rules only, no model: a message is matched against the hospital's public
// places and a few fixed categories. Anything else is "unknown" and the caller offers a menu or a member of staff.
export type Category = 'emergency' | 'clinical' | 'personal' | 'hours' | 'staff' | 'where';

export const normalize = (raw: string) => raw.trim().replace(/\s+/g, ' ').slice(0, 200);

export const BUILDING_TH: Record<string, string> = { opd: 'อาคารผู้ป่วยนอก (OPD)', er: 'อาคารฉุกเฉิน', diagnostics: 'อาคารศูนย์การแพทย์', inpatient: 'อาคารผู้ป่วยใน', support: 'อาคารสนับสนุน' };
export const buildingTh = (id: string) => BUILDING_TH[id] ?? `อาคาร ${id}`;
export const whereTh = (p: { buildingId: string; level: number }) => `${buildingTh(p.buildingId)} ชั้น ${p.level}`;

// "Where is …": the public place with the longest name found in the message (so "ห้องยา" beats "ยา").
export function placeIn(text: string, places: Destination[]): Destination | undefined {
  return [...places].sort((a, b) => b.nameTh.length - a.nameTh.length).find((p) => text.includes(p.nameTh));
}

// Fixed categories, checked in this order by the callers that need them. Emergency and clinical wording always goes to
// a person; a kiosk never answers a medical question or looks anyone up.
const RULES: [Category, RegExp][] = [
  ['emergency', /(ฉุกเฉิน|หายใจไม่ออก|หมดสติ|ไม่รู้สึกตัว|เลือดออกมาก|เจ็บหน้าอก|แน่นหน้าอก|ชัก|อุบัติเหตุ|ช่วยด้วย)/],
  ['clinical', /(ปวด|เจ็บ|อาการ|เป็นโรค|โรคอะไร|รักษา|วินิจฉัย|มีไข้|ตัวร้อน|กินยา|ทานยา|ยาตัว|ขนาดยา|ผลตรวจ|ผลเลือด|ผลแล็บ|ท้องเสีย|อาเจียน|ไอมาก|ไอเป็นเลือด|แพ้ยา|ตั้งครรภ์ได้ไหม)/],
  ['personal', /(\bHN\b|เลขบัตร|บัตรประชาชน|เลขประจำตัว|ประวัติ(การรักษา)?ของ|คิวของ(ฉัน|ผม|หนู|เรา)|นัดของ(ฉัน|ผม|หนู|เรา)|ชื่อผู้ป่วย|ญาติ.*(อยู่|ห้อง)|เบอร์โทรของ)/i],
  ['hours', /(กี่โมง|เปิดกี่|ปิดกี่|เวลาทำการ|เวลาเปิด|เวลาปิด|เปิดวัน|เปิดไหม|เปิดอยู่ไหม)/],
  ['staff', /(ติดต่อ|เจ้าหน้าที่|พยาบาล|โทร|สอบถาม|คุยกับคน)/],
  ['where', /(อยู่ไหน|อยู่ตรงไหน|ไปยังไง|ไปทางไหน|ทางไป|แผนที่|หาไม่เจอ|ห้องน้ำ|ลิฟต์)/],
];
export function categoryOf(text: string, only?: Category[]): Category | undefined {
  return RULES.find(([c, re]) => (!only || only.includes(c)) && re.test(text))?.[0];
}

// Keyword match against approved answers: the answer whose keywords appear most in the message (at least one).
// Ties are returned together, so the caller can let the person choose rather than guess.
export function bestAnswers<T extends { keywords: string[] }>(text: string, answers: T[]): T[] {
  const lower = text.toLowerCase();
  const scored = answers.map((a) => ({ a, score: a.keywords.filter((k) => k && lower.includes(k.toLowerCase())).length })).filter((x) => x.score > 0);
  const top = Math.max(0, ...scored.map((x) => x.score));
  return scored.filter((x) => x.score === top).map((x) => x.a);
}
