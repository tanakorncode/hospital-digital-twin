import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setDuty } from '../lib/doctor-duty';
import { demoShifts, doctorName, findDoctors, floorRooms, roomDutyAt, roomOpenIntervals, roomShifts } from '../lib/scene-data';

// Once doctors are on file, the map's duty roster (and what follows it: the duty panel, the doctor search, the queue
// screens' doctor names, the simulated day) comes from today's appointment schedules, not the demo roster.
const at = (h:string) => new Date(`2026-11-03T${h}:00`).toISOString(); // local time, as the screens read it
afterEach(() => setDuty({known:false,day:'',today:true,sessions:[]}));

test('no doctors on file: the demo roster, as before', () => {
  setDuty({known:false,day:'2026-11-03',sessions:[]});
  const room = floorRooms('opd',2)[0];
  assert.deepEqual(roomShifts(room),demoShifts(room));
});

test("doctors on file: a room's doctors are today's sessions — set rooms first, the rest into a free room of the clinic", () => {
  const rooms = floorRooms('opd',2).filter(r=>r.deptId==='opd-2-0'), [r1,r2] = rooms;
  setDuty({known:true,day:'2026-11-03',sessions:[
    {providerCode:'D1',providerName:'นพ.สมชาย ใจดี',clinicCode:'opd-2-0',roomId:r2.id,startsAt:at('09:00'),endsAt:at('12:00'),status:'OPEN'},
    {providerCode:'D2',providerName:'พญ.สมศรี รักษา',clinicCode:'opd-2-0',startsAt:at('09:00'),endsAt:at('12:00'),status:'OPEN'},
    {providerCode:'D3',providerName:'นพ.บ่าย สาย',clinicCode:'opd-2-0',startsAt:at('13:30'),endsAt:at('16:00'),status:'CLOSED'},
  ]});
  assert.deepEqual(roomShifts(r2).map(s=>[doctorName(s.doctor,true),s.from,s.to]),[['นพ.สมชาย ใจดี',9,12]]);
  assert.deepEqual(roomShifts(r1).map(s=>[doctorName(s.doctor,true),s.from,s.to,!!s.closed]),[['พญ.สมศรี รักษา',9,12,false],['นพ.บ่าย สาย',13.5,16,true]], 'the free room, morning and afternoon');
  // Duty at 10:00: both rooms active, no simulated break; at 12:30 nobody.
  assert.equal(roomDutyAt(r2.id,10)?.status,'active'); assert.equal(doctorName(roomDutyAt(r2.id,10)!.current!.doctor),'นพ.สมชาย');
  assert.equal(roomDutyAt(r1.id,12.5)?.status,'vacant');
  // A clinic with no session today: its rooms have no doctor (not the demo roster).
  const eye = floorRooms('opd',4).find(r=>r.deptId==='opd-4-1')!;
  assert.deepEqual(roomShifts(eye),[]);
  // The search finds the real doctor; the simulator's open hours follow the sessions.
  assert.ok(findDoctors('สมศรี',10).some(h=>h.name==='พญ.สมศรี รักษา'));
  assert.deepEqual(roomOpenIntervals(r2),[[540,600],[600,660],[660,720]].reduce<[number,number][]>((a,[x,y])=>{ const l = a[a.length-1]; if (l && l[1]===x) l[1] = y; else a.push([x,y]); return a; },[]));
});

test('a day without sessions: the simulated day uses the next one; live data shows no doctors today', async () => {
  const { setRealCounts } = await import('../lib/scene-data');
  const room = floorRooms('opd',2).filter(r=>r.deptId==='opd-2-0')[0];
  setDuty({known:true,day:'2026-11-03',today:false,sessions:[{providerCode:'D1',providerName:'นพ.สมชาย ใจดี',clinicCode:'opd-2-0',startsAt:at('09:00'),endsAt:at('12:00'),status:'OPEN'}]});
  assert.equal(roomShifts(room).length,1,'demo data: the next working day');
  setRealCounts({floor:()=>0,waiting:()=>({n:0,avgWait:0}),rooms:()=>[0,0]});
  try { assert.deepEqual(roomShifts(room),[],'live data: nobody today'); } finally { setRealCounts(null); }
});
