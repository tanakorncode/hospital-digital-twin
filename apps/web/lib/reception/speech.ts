'use client';

// Speaking approved text at the kiosk, with a Thai voice installed on the kiosk itself. Browser voices marked
// localService:false (e.g. Chrome's "Google ไทย") are synthesised on the vendor's servers — that would send text out
// of the hospital (Reception spec §3, §12), so they are never used. No local Thai voice = captions only.
type VoiceLike = {lang:string; localService:boolean; name:string};
export function localThaiVoice<V extends VoiceLike>(voices:V[]):V|undefined {
 return voices.find(v=>v.localService && /^th(-|_|$)/i.test(v.lang));
}
// Numbers in room / floor names read digit by digit, as Thai hospitals announce them (205 → สอง ศูนย์ ห้า).
const digitTh = ['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
export const spoken = (text:string) => text.replace(/\d{3,}/g,n=>` ${n.split('').map(d=>digitTh[Number(d)]).join(' ')} `).replace(/[·•]/g,' ').replace(/\s+/g,' ').trim();

export function speechAvailable() {
 return typeof window!=='undefined' && 'speechSynthesis' in window && !!localThaiVoice(window.speechSynthesis.getVoices());
}
// Speak (stopping anything still being said). Returns false when there is no local Thai voice — the caller shows text only.
export function speak(text:string, onEnd?:()=>void):boolean {
 if (typeof window==='undefined' || !('speechSynthesis' in window)) return false;
 const voice = localThaiVoice(window.speechSynthesis.getVoices());
 if (!voice) return false;
 const u = new SpeechSynthesisUtterance(spoken(text));
 u.voice = voice; u.lang = voice.lang; u.rate = 0.95;
 if (onEnd) { u.onend = onEnd; u.onerror = onEnd; }
 window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
 return true;
}
export function stopSpeaking() { if (typeof window!=='undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel(); }
