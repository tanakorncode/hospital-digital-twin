'use client';
import { useEffect, useState } from 'react';
import { apiBase } from './api-url';
import { facilityRevision, loadStoredFacility, onFacility, storeFacility } from './facility';

// Re-render when a new facility arrives. Screens with the queue socket get it from there (useQueueEvents); a screen
// without one (QR wayfinding, the LINE pages, the reception kiosk) passes `fetch` to load it from GET /api/v1/facility.
// Returns the facility revision, to key memoised work on.
export function useFacility(fetchIt=false):number {
  const [rev,setRev] = useState(facilityRevision());
  useEffect(()=>{
    const off = onFacility(()=>setRev(facilityRevision()));
    loadStoredFacility();
    if (fetchIt) fetch(`${apiBase()}/api/v1/facility`).then(r=>r.json()).then((j:{ok?:boolean; facility?:unknown})=>{ if (j?.ok) storeFacility(j.facility); }).catch(()=>{ /* offline: keep what we have */ });
    setRev(facilityRevision());
    return off;
  },[fetchIt]);
  return rev;
}
