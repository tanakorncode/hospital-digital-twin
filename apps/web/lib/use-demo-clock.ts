'use client';
import { useEffect, useState } from 'react';

// Demo time shift for a target time of day. It is a whole number of minutes anchored to the current real hour,
// so every screen opened with the same target in the same hour (console, wall TV, patient page) shows the
// same clock and sees each other's queue calls at once.
export function demoOffset(targetHour:number) {
  const d = new Date();
  return Math.round(targetHour*60) - d.getHours()*60;
}
// Minutes since midnight, ticking with real time. `?hour=9.5` runs the clock from about 09:30 instead (demo links);
// otherwise `sharedOffset` (minutes, the test time set in Settings for every screen) shifts it.
export function useDemoClock(tickMs=5000, sharedOffset=0) {
  const [minute,setMinute] = useState<number|null>(null);
  useEffect(()=>{
    const q = new URLSearchParams(window.location.search), h = Number(q.get('hour') ?? q.get('demoStart'));
    const offset = (q.get('hour') ?? q.get('demoStart'))!==null && Number.isFinite(h) ? demoOffset(h) : sharedOffset;
    const tick = () => setMinute(minutesNow()+offset);
    tick();
    const t = setInterval(tick,tickMs);
    return ()=>clearInterval(t);
  },[tickMs,sharedOffset]);
  return minute;
}
const minutesNow = () => { const d = new Date(); return d.getHours()*60+d.getMinutes()+d.getSeconds()/60; };
