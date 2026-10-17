'use client';

// The kiosk's receptionist, drawn in 2D (Reception spec §5–6) until the hospital has a licensed 3D model: a friendly,
// clearly illustrated figure — not the likeness of any real person. A few dependable states rather than many gestures:
//   idle (breathing, blinking) · greeting (wave) · listening · thinking · speaking (mouth moves while text is read)
//   · pointing (towards the content panel) · unsure (neutral, offers a member of staff)
export type AvatarState = 'idle'|'greeting'|'thinking'|'speaking'|'pointing'|'unsure';

export function Avatar({state,label}:{state:AvatarState; label:string}) {
 return <figure className={`rcpAvatar s-${state}`} aria-label={label}>
  <svg viewBox="0 0 220 300" role="img" aria-hidden="true">
   <defs>
    <linearGradient id="rcpUniform" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2f6fd6"/><stop offset="1" stopColor="#1d4fa3"/></linearGradient>
    <linearGradient id="rcpSkin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f6d3b8"/><stop offset="1" stopColor="#ecbf9c"/></linearGradient>
   </defs>
   <ellipse cx="110" cy="292" rx="70" ry="7" className="rcpShadow"/>
   <g className="rcpBody">
    {/* body and uniform */}
    <path d="M40 300 C40 228 66 200 110 200 C154 200 180 228 180 300 Z" fill="url(#rcpUniform)"/>
    <path d="M96 200 L110 226 L124 200 Z" fill="#fff"/>
    <rect x="128" y="236" width="34" height="14" rx="3" fill="#fff" opacity=".92"/>
    <rect x="132" y="241" width="22" height="4" rx="2" fill="#2f6fd6" opacity=".7"/>
    {/* arms: the right one waves / points */}
    <path d="M52 236 C40 258 40 280 46 296" stroke="url(#rcpUniform)" strokeWidth="20" strokeLinecap="round" fill="none"/>
    <g className="rcpArm">
     <path d="M168 236 C182 252 188 268 186 290" stroke="url(#rcpUniform)" strokeWidth="20" strokeLinecap="round" fill="none"/>
     <circle cx="186" cy="292" r="10" fill="url(#rcpSkin)"/>
    </g>
    {/* neck and head */}
    <rect x="98" y="168" width="24" height="34" rx="10" fill="url(#rcpSkin)"/>
    <g className="rcpHead">
     <ellipse cx="110" cy="122" rx="52" ry="58" fill="url(#rcpSkin)"/>
     <path d="M58 118 C56 70 84 52 112 52 C142 52 166 72 162 120 C150 96 128 86 104 86 C84 86 66 98 58 118 Z" fill="#2b2f3a"/>
     <path d="M58 118 C52 150 60 176 70 186 C64 160 64 138 66 120 Z" fill="#2b2f3a"/>
     <path d="M162 118 C168 150 160 176 150 186 C156 160 156 138 154 120 Z" fill="#2b2f3a"/>
     <g className="rcpEyes"><ellipse cx="90" cy="126" rx="6" ry="7" fill="#2b2f3a"/><ellipse cx="130" cy="126" rx="6" ry="7" fill="#2b2f3a"/></g>
     <path d="M80 110 Q90 104 100 110" stroke="#2b2f3a" strokeWidth="3" fill="none" strokeLinecap="round" className="rcpBrow"/>
     <path d="M120 110 Q130 104 140 110" stroke="#2b2f3a" strokeWidth="3" fill="none" strokeLinecap="round" className="rcpBrow"/>
     <ellipse cx="78" cy="146" rx="8" ry="5" fill="#f2a7a0" opacity=".45"/><ellipse cx="142" cy="146" rx="8" ry="5" fill="#f2a7a0" opacity=".45"/>
     <path d="M98 152 Q110 162 122 152" stroke="#b5525a" strokeWidth="3.5" fill="none" strokeLinecap="round" className="rcpSmile"/>
     <ellipse cx="110" cy="156" rx="8" ry="5" fill="#b5525a" className="rcpMouth"/>
     {/* headset (staff), no microphone shown while voice input is off */}
     <path d="M56 116 C56 76 80 58 110 58 C140 58 164 76 164 116" stroke="#e8eef6" strokeWidth="5" fill="none"/>
     <rect x="48" y="110" width="12" height="22" rx="5" fill="#e8eef6"/><rect x="160" y="110" width="12" height="22" rx="5" fill="#e8eef6"/>
    </g>
   </g>
  </svg>
  {state==='thinking' && <span className="rcpDots" aria-hidden="true"><i/><i/><i/></span>}
 </figure>;
}
