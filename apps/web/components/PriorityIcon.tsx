// Priority-queue icons drawn in the same line style as lucide (24×24, 2px round strokes), since lucide has no
// monk, elderly-with-cane, wheelchair-user or pregnancy glyph. Shown with the label so meaning never rests on the
// picture alone.
import type { Priority } from '../lib/queue';

type Key = Priority['key'];
const paths:Record<Key,React.ReactNode> = {
 // Shaved head, robe over one shoulder (diagonal fold), holding the alms bowl.
 monk:<><circle cx="12" cy="4.6" r="2.5"/><path d="M6.5 21c.4-6.6 2.2-10.4 5.5-10.4s5.1 3.8 5.5 10.4"/><path d="M8.3 12.6l5 4.4"/><path d="M8.8 16.2h6.4a3.2 3.2 0 0 1-6.4 0z" fill="currentColor"/></>,
 // Bent figure walking with a cane.
 elderly:<><circle cx="10" cy="4.2" r="2.2"/><path d="M10.5 7.5c-1.6 1.3-2 3.5-1.2 5.5"/><path d="M9.3 13L7.5 21"/><path d="M9.3 13l3.2 3 .5 5"/><path d="M10.2 9.6l3.8 2"/><path d="M16 12v9"/><path d="M14 12.3a1.6 1.6 0 0 1 3.1-.6"/></>,
 // Wheelchair user (side view): person seated, big wheel.
 wheelchair:<><circle cx="11" cy="3.8" r="2"/><path d="M11 6.8v6h5l2.2 6.2"/><path d="M11 9.6h4"/><path d="M8.4 10.5a5.3 5.3 0 1 0 7.4 7"/></>,
 // International symbol of access: figure with arms out inside a circle.
 disabled:<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="6.6" r="1.5"/><path d="M7.5 9.6l4.5 1 4.5-1"/><path d="M12 10.6v3.4l-2.4 4.4"/><path d="M12 14l2.4 4.4"/></>,
 // Profile with a rounded belly.
 pregnant:<><circle cx="11" cy="3.8" r="2.1"/><path d="M10.4 6.8c-1.2 1.5-1.4 3.6-.8 5.4"/><path d="M10.6 9.4c3.6.2 5.7 2.6 5 5.4-.4 1.7-1.8 2.6-3.8 2.7"/><path d="M10 12.4L9.5 21"/><path d="M11.8 17.5l.7 3.5"/></>,
};
export const priorityTone:Record<Key,{fg:string;bg:string}> = {
 monk:{fg:'#b45309',bg:'#fff1dc'}, elderly:{fg:'#6d28d9',bg:'#f1eafe'}, wheelchair:{fg:'#1d4ed8',bg:'#e6efff'},
 disabled:{fg:'#0369a1',bg:'#e0f2fe'}, pregnant:{fg:'#be185d',bg:'#fde7f1'},
};
export function PriorityIcon({k,size=16}:{k:Key;size?:number}) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[k]}</svg>;
}
// Icon + label chip; `iconOnly` keeps just the icon (label in the tooltip / for screen readers).
export function PriorityTag({p,iconOnly}:{p:Priority;iconOnly?:boolean}) {
 const t = priorityTone[p.key];
 return <span className={'prioChip'+(iconOnly?' iconOnly':'')} style={{color:t.fg,background:t.bg}} title={p.label}>
  <PriorityIcon k={p.key} size={iconOnly?14:15}/>{iconOnly ? <span className="srOnly">{p.label}</span> : p.label}</span>;
}
