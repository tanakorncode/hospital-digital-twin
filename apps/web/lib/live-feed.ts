'use client';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { apiSocket } from './api-url';
import { setLiveData, type DensityLevel, type LiveDuty } from './scene-data';

// Mirrors LiveSnapshot in apps/api/src/live-feed.service.ts (and @hospital/contracts).
export type LiveSnapshot = {
  at: string;
  source: 'demo' | 'his-adapter';
  floors: Record<string, number>;
  servicePoints: Record<string, { queue: number; waitMinutes: number; status: DensityLevel }>;
  duty?: Record<string, LiveDuty>; // roomId → who is on duty; overrides the demo roster when present
};
export type LiveStatus = 'connecting' | 'live' | 'offline';


// Subscribes to the API's /hospital namespace. Each snapshot is pushed into scene-data so every
// count for the current hour reflects it; the returned snapshot is what triggers a re-render.
export function useLiveFeed() {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  useEffect(() => {
    const api = apiSocket(), socket = io(`${api.url}/hospital`, { ...api.opts, reconnectionDelay: 3000 });
    const onData = (s: LiveSnapshot) => {
      const at = new Date(s.at);
      setLiveData({ hour: at.getHours() + at.getMinutes() / 60, floors: s.floors, servicePoints: s.servicePoints, duty: s.duty, source: s.source });
      setSnapshot(s);
      setStatus('live');
    };
    // Without a connection the dashboard falls back to the demo profile.
    const onLost = () => { setLiveData(null); setStatus('offline'); };
    socket.on('live:snapshot', onData);
    socket.on('live:update', onData);
    socket.on('connect_error', onLost);
    socket.on('disconnect', onLost);
    return () => { socket.close(); setLiveData(null); };
  }, []);
  return { status, snapshot };
}
