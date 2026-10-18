'use client';

// "น้องใจดี", the kiosk's receptionist — a cartoon (chibi) character after the hospital's concept sheet: big head,
// big glossy eyes, brown hair with a high ponytail and a blue scrunchie, a blue headset, a white wrap tunic with
// light-blue piping, the hospital cross and a name badge, a blue belt and skirt with a white apron, white sneakers.
// Drawn here (no image files) until the 3D model (GLB with rig and visemes) is ready. Clearly a cartoon helper — not
// a nurse or any real person. A few dependable states rather than many gestures (Reception spec §5):
//   idle (breathing, blinking, gentle smile) · greeting (waves, open smile) · speaking (mouth moves while text is read)
//   · pointing (towards the content panel) · thinking (looks up, head tilted) · unsure (concerned brows, offers staff)
//   · thanks (a small bow, happy eyes — once someone is helped)
export type AvatarState = 'idle'|'greeting'|'thinking'|'speaking'|'pointing'|'unsure'|'thanks';
export const AVATAR_NAME = 'น้องใจดี';

const EYES = [118,182];

export function Avatar({state,label=AVATAR_NAME}:{state:AvatarState; label?:string}) {
 return <figure className={`rcpAvatar s-${state}`} aria-label={label}>
  <svg viewBox="0 0 300 412" role="img" aria-hidden="true">
   <defs>
    <radialGradient id="njSkin" cx=".45" cy=".38" r=".75"><stop offset="0" stopColor="#fff3ea"/><stop offset=".6" stopColor="#ffe0cc"/><stop offset="1" stopColor="#f5c3a6"/></radialGradient>
    <linearGradient id="njLimb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#f7cdb2"/><stop offset=".5" stopColor="#ffe3d2"/><stop offset="1" stopColor="#f3c4a8"/></linearGradient>
    <linearGradient id="njHair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8c5a3b"/><stop offset=".55" stopColor="#6e4329"/><stop offset="1" stopColor="#53311f"/></linearGradient>
    <linearGradient id="njHairBack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5e3925"/><stop offset="1" stopColor="#3f2416"/></linearGradient>
    <linearGradient id="njIris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2e180e"/><stop offset=".45" stopColor="#6b3f24"/><stop offset="1" stopColor="#c08454"/></linearGradient>
    <linearGradient id="njWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff"/><stop offset="1" stopColor="#e4ecf8"/></linearGradient>
    <linearGradient id="njBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#93b8f2"/><stop offset="1" stopColor="#6a95de"/></linearGradient>
    <linearGradient id="njBand" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#4f83d6"/><stop offset=".5" stopColor="#7aa5ec"/><stop offset="1" stopColor="#4f83d6"/></linearGradient>
   </defs>
   <ellipse cx="150" cy="404" rx="70" ry="7" className="rcpShadow"/>
   <g className="rcpBody">
    {/* ---- legs and sneakers ---- */}
    <rect x="124" y="346" width="17" height="46" rx="8" fill="url(#njLimb)"/><rect x="159" y="346" width="17" height="46" rx="8" fill="url(#njLimb)"/>
    {[0,1].map(i=><g key={i} transform={i ? 'translate(300 0) scale(-1 1)' : undefined}>
     <path d="M108 398 C108 385 121 381 138 384 C146 386 149 393 146 400 L113 402 C109 402 108 400 108 398 Z" fill="url(#njWhite)" stroke="#cfdbea" strokeWidth="1.5"/>
     <path d="M110 399 L146 398" stroke="#dbe5f1" strokeWidth="3" strokeLinecap="round"/>
     <path d="M126 387 L134 386 M124 391 L134 390" stroke="#c3d2e6" strokeWidth="1.5" strokeLinecap="round"/>
    </g>)}
    {/* ---- skirt and apron ---- */}
    <path d="M104 300 L196 300 L210 352 C182 362 118 362 90 352 Z" fill="url(#njBlue)"/>
    <path d="M122 306 L114 352 M150 306 L150 358 M178 306 L186 352" stroke="#5f8bd6" strokeWidth="1.2" opacity=".45"/>
    <path d="M150 300 L194 300 L190 342 C178 349 162 349 152 342 Z" fill="url(#njWhite)" stroke="#d3deee" strokeWidth="1.2"/>
    <path d="M158 318 L186 318 L184 336 C176 340 166 340 160 336 Z" fill="none" stroke="#c4d3e8" strokeWidth="1.4"/>
    {/* ---- left arm (still, hand by the side) ---- */}
    <path d="M100 246 C86 250 80 262 80 274 L100 280 L106 258 Z" fill="url(#njWhite)"/>
    <path d="M80 273 L100 279" stroke="#5b8ee0" strokeWidth="4" strokeLinecap="round"/>
    <path d="M90 279 C86 292 86 302 88 310" stroke="url(#njLimb)" strokeWidth="15" strokeLinecap="round" fill="none"/>
    <ellipse cx="88" cy="314" rx="9" ry="8" fill="url(#njSkin)"/>
    {/* ---- tunic: mandarin collar, wrap closure with piping and buttons, cross, badge, belt ---- */}
    <path d="M108 232 C120 220 180 220 192 232 L200 256 L196 302 L104 302 L100 256 Z" fill="url(#njWhite)"/>
    <path d="M150 238 C142 254 130 264 108 270" stroke="#5b8ee0" strokeWidth="4" fill="none" strokeLinecap="round"/>
    <circle cx="128" cy="266" r="2.6" fill="#5b8ee0"/><circle cx="116" cy="276" r="2.6" fill="#5b8ee0"/>
    <path d="M128 224 C138 233 162 233 172 224 L174 233 C162 242 138 242 126 233 Z" fill="#fff" stroke="#5b8ee0" strokeWidth="2.6" strokeLinejoin="round"/>
    <g transform="translate(176 254)"><rect x="-3.2" y="-10" width="6.4" height="20" rx="3.2" fill="#2f74d0"/><rect x="-10" y="-3.2" width="20" height="6.4" rx="3.2" fill="#2f74d0"/>
     <rect x="-1.8" y="-8.5" width="3.6" height="7" rx="1.8" fill="#41c8a0"/></g>
    <rect x="164" y="268" width="24" height="9" rx="2.5" fill="#fff" stroke="#8fb4ea" strokeWidth="1.4"/><rect x="167" y="271" width="13" height="3" rx="1.5" fill="#2f74d0"/>
    <rect x="102" y="292" width="96" height="12" rx="4" fill="url(#njBand)"/>
    <rect x="162" y="290" width="16" height="16" rx="3" fill="none" stroke="#e9f1fd" strokeWidth="2"/>
    {/* ---- right arm: waves / points (the whole sleeve turns at the shoulder) ---- */}
    <g className="rcpArm">
     <path d="M200 246 C214 250 220 262 220 274 L200 280 L194 258 Z" fill="url(#njWhite)"/>
     <path d="M220 273 L200 279" stroke="#5b8ee0" strokeWidth="4" strokeLinecap="round"/>
     <path d="M210 279 C214 292 214 302 212 310" stroke="url(#njLimb)" strokeWidth="15" strokeLinecap="round" fill="none"/>
     <ellipse cx="212" cy="314" rx="9" ry="8" fill="url(#njSkin)"/><ellipse cx="204" cy="310" rx="3.5" ry="5" fill="#f7cdb2"/>
    </g>
    <rect x="141" y="200" width="18" height="28" rx="8" fill="url(#njLimb)"/>
    <path d="M141 214 C147 220 153 220 159 214 L159 224 L141 224 Z" fill="#e9b394" opacity=".5"/>
    {/* ---- head ---- */}
    <g className="rcpHead">
     {/* ponytail and scrunchie (behind) */}
     <path d="M150 46 C138 22 158 2 186 8 C214 14 222 44 208 64 C198 78 178 76 168 66 Z" fill="url(#njHair)"/>
     <path d="M168 18 C182 12 200 18 206 34" stroke="#a7755a" strokeWidth="3" fill="none" strokeLinecap="round" opacity=".55"/>
     <ellipse cx="170" cy="50" rx="18" ry="8" transform="rotate(-28 170 50)" fill="url(#njBand)"/>
     {/* back hair */}
     <path d="M64 136 C58 72 100 36 150 36 C200 36 242 72 236 136 C240 176 232 206 220 226 C212 206 210 192 208 180 L92 180 C90 192 88 206 80 226 C68 206 60 176 64 136 Z" fill="url(#njHairBack)"/>
     {/* face */}
     <path d="M76 132 C76 86 110 64 150 64 C190 64 224 86 224 132 C224 180 192 212 150 212 C108 212 76 180 76 132 Z" fill="url(#njSkin)"/>
     {/* bangs (side part, swept) and the locks that frame the face */}
     <path d="M72 130 C68 84 100 50 150 48 C200 50 232 84 228 130 C222 110 212 98 198 90 C200 106 194 118 186 124 C182 106 172 94 156 86 C152 102 142 114 126 120 C130 106 128 94 122 86 C108 98 90 112 72 130 Z" fill="url(#njHair)"/>
     <path d="M78 122 C70 152 72 186 86 210 C86 190 84 164 90 138 Z" fill="url(#njHair)"/>
     <path d="M222 122 C230 152 228 186 214 210 C214 190 216 164 210 138 Z" fill="url(#njHair)"/>
     <path d="M96 76 C116 60 152 56 180 64" stroke="#b07c5c" strokeWidth="4" fill="none" strokeLinecap="round" opacity=".5"/>
     <path d="M156 88 C168 96 176 106 180 118" stroke="#4a2b1a" strokeWidth="1.6" fill="none" opacity=".5"/>
     <path d="M122 88 C126 98 126 108 122 116" stroke="#4a2b1a" strokeWidth="1.6" fill="none" opacity=".5"/>
     {/* headset: band over the hair, ear cups */}
     <path d="M70 144 C68 76 106 40 150 40 C194 40 232 76 230 144" stroke="url(#njBand)" strokeWidth="9" fill="none" strokeLinecap="round"/>
     <path d="M82 104 C94 64 124 48 150 48" stroke="#b9d1f6" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".8"/>
     {[72,228].map(x=><g key={x}><ellipse cx={x} cy="150" rx="15" ry="20" fill="#f4f8fd" stroke="#cddbee" strokeWidth="1.5"/>
      <ellipse cx={x} cy="150" rx="9" ry="13" fill="#4f86dc"/><ellipse cx={x+(x<150?-2:2)} cy="145" rx="3" ry="4.5" fill="#a9c6f5"/></g>)}
     {/* brows */}
     <path className="rcpBrow bL" d="M103 124 Q118 116 132 122" stroke="#7a4e35" strokeWidth="3.2" fill="none" strokeLinecap="round"/>
     <path className="rcpBrow bR" d="M168 122 Q182 116 197 124" stroke="#7a4e35" strokeWidth="3.2" fill="none" strokeLinecap="round"/>
     {/* eyes: big and glossy (open), or happy arcs */}
     <g className="rcpEyes eOpen">
      {EYES.map(x=><g key={x}>
       <ellipse cx={x} cy="152" rx="17" ry="19.5" fill="#fff"/>
       <g className="rcpLook">
        <ellipse cx={x} cy="154" rx="14.5" ry="17.5" fill="url(#njIris)"/>
        <ellipse cx={x} cy="152" rx="7.5" ry="9.5" fill="#1f0f07"/>
        <ellipse cx={x} cy="163" rx="9" ry="4" fill="#d9a06c" opacity=".55"/>
        <circle cx={x+6} cy="145" r="6.2" fill="#fff"/><circle cx={x-6} cy="161" r="2.8" fill="#fff"/><circle cx={x+8} cy="163" r="1.6" fill="#fff" opacity=".9"/>
       </g>
       <path d={`M${x-19} 146 C${x-12} 130 ${x+12} 130 ${x+19} 144`} stroke="#2b1810" strokeWidth="4.5" fill="none" strokeLinecap="round"/>
       <path d={x<150 ? `M${x-18} 143 l-6 -4 M${x-16} 139 l-4 -6` : `M${x+18} 141 l6 -4 M${x+16} 137 l4 -6`} stroke="#2b1810" strokeWidth="2.4" strokeLinecap="round"/>
       <path d={`M${x-11} 171 Q${x} 175 ${x+11} 171`} stroke="#d39a83" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
      </g>)}
     </g>
     <g className="eHappy">{EYES.map(x=><path key={x} d={`M${x-15} 156 C${x-8} 142 ${x+8} 142 ${x+15} 156`} stroke="#2b1810" strokeWidth="4.5" fill="none" strokeLinecap="round"/>)}</g>
     {/* blush, nose */}
     <ellipse cx="100" cy="180" rx="14" ry="8" fill="#ff9aa2" opacity=".42"/><ellipse cx="200" cy="180" rx="14" ry="8" fill="#ff9aa2" opacity=".42"/>
     <path d="M147 172 Q150 175 153 172" stroke="#d99a7f" strokeWidth="2" fill="none" strokeLinecap="round"/>
     {/* mouths: one shows at a time (see the s-* rules in globals.css) */}
     <path className="mIdle" d="M138 184 Q150 195 162 184" stroke="#c4475a" strokeWidth="3.4" fill="none" strokeLinecap="round"/>
     <g className="mOpen">
      <path d="M134 182 Q150 206 166 182 Q150 188 134 182 Z" fill="#b8384d"/>
      <path d="M137 183 Q150 188 163 183 L161.5 187.5 Q150 191 138.5 187.5 Z" fill="#fff"/>
      <ellipse cx="150" cy="196" rx="8" ry="4" fill="#f28d9b"/>
     </g>
     <ellipse className="mTalk" cx="150" cy="190" rx="9" ry="8" fill="#b8384d"/>
     <path className="mFlat" d="M140 190 Q150 185 160 190" stroke="#c4475a" strokeWidth="3.4" fill="none" strokeLinecap="round"/>
    </g>
   </g>
  </svg>
  {state==='thinking' && <span className="rcpDots" aria-hidden="true"><i/><i/><i/></span>}
 </figure>;
}
