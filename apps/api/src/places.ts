// Names patients read on the hospital signs, from station ids (the web app has the full labels; these are enough for a message).
export function placeOf(station: string): string {
  let m: RegExpMatchArray | null;
  if ((m = station.match(/^room:[a-z]+-(\d+)$/))) return `ห้องตรวจ ${m[1]}`;
  if ((m = station.match(/^counter:([a-z]+):(\d+)$/))) {
    const name: Record<string, string> = { registration: 'ช่องลงทะเบียน', pharmacy: 'ช่องจ่ายยา', finance: 'ช่องการเงิน', lab: 'จุดเจาะเลือด', xray: 'ห้องเอกซเรย์', triage: 'จุดคัดแยก ER' };
    return `${name[m[1]] ?? 'ช่องบริการ'} ${m[2]}`;
  }
  if ((m = station.match(/^screen:opd-(\d)-\d+(?::(\d+))?$/))) return `จุดซักประวัติ ชั้น ${m[1]}${m[2] ? ` ช่อง ${m[2]}` : ''}`;
  return 'จุดบริการ';
}
