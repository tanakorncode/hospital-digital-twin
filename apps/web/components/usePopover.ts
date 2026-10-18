'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// A popup anchored to a trigger button and drawn on the page body (Select, DatePicker): placed under the trigger, or
// above it when there is more room there; follows the page when it scrolls or resizes; closes on a click outside.
export type PopoverPos = {left:number; top:number; width:number; up:boolean; maxH:number};

export function usePopover({width,needs}:{width:number; needs:number}) {
 const [open,setOpen] = useState(false);
 const [pos,setPos] = useState<PopoverPos|null>(null);
 const anchor = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
 const place = useCallback(()=>{
  const r = anchor.current?.getBoundingClientRect(); if (!r) return;
  const below = window.innerHeight-r.bottom, above = r.top, up = below<needs && above>below, w = Math.max(r.width,width);
  setPos({left:Math.max(8,Math.min(r.left,window.innerWidth-w-8)),top:up ? r.top-6 : r.bottom+6,width:w,up,maxH:Math.max(160,(up?above:below)-16)});
 },[width,needs]);
 const show = useCallback(()=>{ place(); setOpen(true); },[place]);
 const close = useCallback((focus=true)=>{ setOpen(false); if (focus) anchor.current?.focus(); },[]);
 useEffect(()=>{ if (!open) return;
  // Any press outside — mouse, pen or finger — caught on the way down (capture), so an element that stops the event
  // (a plan, a card's own handler) cannot keep the popup open.
  const outside = (e:PointerEvent) => { const t = e.target as Node; if (!pop.current?.contains(t) && !anchor.current?.contains(t)) setOpen(false); };
  window.addEventListener('scroll',place,true); window.addEventListener('resize',place); document.addEventListener('pointerdown',outside,true);
  return ()=>{ window.removeEventListener('scroll',place,true); window.removeEventListener('resize',place); document.removeEventListener('pointerdown',outside,true); };
 },[open,place]);
 return {open,pos,anchor,pop,show,close};
}
