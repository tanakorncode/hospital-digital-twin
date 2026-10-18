import type { AvatarState } from './Avatar';

// Which animation in a character model plays for each kiosk state — by name, as the generators and Mixamo call them.
// Shared by the kiosk (Avatar3D) and Settings (to say which states the uploaded model covers).
export const CLIP_NAMES:Record<AvatarState,RegExp> = {idle:/idle|stand|breath/i, greeting:/wave|hello|greet|\bhi\b/i, speaking:/talk|speak|explain|conversation/i,
 pointing:/point|show|direct|present/i, thinking:/think|ponder|wonder/i, unsure:/sad|sorry|shrug|unsure|worr|concern/i, thanks:/bow|thank|polite/i};
export const STATE_TEXT:Record<AvatarState,string> = {idle:'รอ',greeting:'ทักทาย',speaking:'พูด',pointing:'ชี้ทาง',thinking:'คิด',unsure:'ไม่แน่ใจ',thanks:'ขอบคุณ'};
export const clipFor = (state:AvatarState, names:string[]) => names.find(n=>CLIP_NAMES[state].test(n));
