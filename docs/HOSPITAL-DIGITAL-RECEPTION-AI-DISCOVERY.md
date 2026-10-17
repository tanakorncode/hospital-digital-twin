# Hospital Digital Reception AI — รายงานสำรวจ repository (Discovery)

ตามเอกสาร `docs/Hospital-Digital-Reception-AI-Implementation-Ready.md` (v1.1) §20 · สำรวจเมื่อ 18 ต.ค. 2026 · commit ฐาน `adc2195` (main)

> ขอบเขตของรอบนี้: อ่านโค้ดและรายงานเท่านั้น — ไม่แก้โค้ด, dependency, migration, env หรือ deployment · ไม่ส่งข้อมูลไปบริการ AI ภายนอก · หยุดรอการตรวจทานก่อนลงมือ Release A

**สรุปสั้น:** Release A (ไม่มี LLM) ทำได้บนระบบเดิมทั้งหมด — ไม่ต้องเพิ่ม dependency, ไม่ต้องมี GPU, ไม่ต้องมีเซิร์ฟเวอร์ใหม่ ของที่ใช้ต่อได้ทันทีคือ จุดหมายนำทาง (destinations) + หน้าแผนผังชั้น, ตัวจับเจตนาแบบกฎของแชตบอท LINE, ระบบ feature flag / audit / rate limit / ตัวนับ, และ three.js + React Three Fiber + Drei ที่ติดตั้งอยู่แล้ว ช่องว่างหลัก 4 ข้อคือ (1) ยังไม่มีข้อมูลทางเดินแบบกราฟ — นำทางได้แค่ระดับอาคาร/ชั้น/โซน, (2) ยังไม่มีตัวตนของตู้ (device credential), (3) ยังไม่มีโมเดลอวตารที่มีลิขสิทธิ์, (4) ชื่อหน้า `/kiosk` ที่เอกสารเสนอซ้ำกับตู้เช็กอินที่มีอยู่

---

## 1. สถาปัตยกรรมที่ตรวจแล้ว (อ้างอิงไฟล์จริง)

### 1.1 โครงสร้าง
pnpm monorepo (`package.json`, `pnpm-workspace.yaml`) · Node v24.21.0 (CI ใช้ Node 24 เพราะ `node:sqlite` ต้องการ 22.13+)

| ส่วน | ที่อยู่ | เทคโนโลยี |
|---|---|---|
| เว็บ | `apps/web` | Next.js ^15.1.4, React ^19, three ^0.172, @react-three/fiber ^9.8.2, @react-three/drei ^10.7.9, socket.io-client, lucide-react, qrcode, 3d-tiles-renderer |
| API | `apps/api` | NestJS ^10.4 (express + socket.io), ฐานข้อมูล `node:sqlite` ไฟล์เดียว, ไม่มี ORM |
| สัญญาร่วม | `packages/contracts/src/index.ts` (30 บรรทัด) | type ของ queue event / live snapshot เท่านั้น — ไม่มี runtime validator (ไม่มี zod ฯลฯ) |

### 1.2 หน้าเว็บที่มีอยู่ (`apps/web/app/`)
| เส้นทาง | ไฟล์ | หน้าที่ | เกี่ยวกับ Reception |
|---|---|---|---|
| `/` | `page.tsx` → `components/HospitalDashboard.tsx` | คอนโซลเจ้าหน้าที่, แผนที่ 2D/3D, คิว, ตั้งค่า | ที่วางหน้าตั้งค่า FAQ/ตู้ |
| `/kiosk` | `app/kiosk/page.tsx` | **ตู้เช็กอิน BK/AP** — ล็อกอินด้วยบัญชีเจ้าหน้าที่ ออกเลขคิว · กลับหน้าแรกใน 45 วินาที | ⚠ ชื่อซ้ำกับที่เอกสาร §6 เสนอ และทำสิ่งที่ Reception ห้ามทำ (เช็กอิน) → Reception ต้องใช้หน้าใหม่ |
| `/wayfinding` | `app/wayfinding/page.tsx` | QR นำทาง `?at=` / `?to=`, ค้นหาจุดหมาย, แผนผังชั้น `components/FloorPlanSvg.tsx`, เส้นทางเป็นข้อความ | ใช้ต่อเป็นแผงนำทางของ Reception |
| `/tv`, `/q/[token]`, `/liff`, `/real-map`, `/real-map-3d` | | จอคิว, หน้าคิวผู้ป่วย, LINE, แผนที่จริง | — |
| `/sio` | `app/sio/route.ts` | ส่งต่อ socket.io ผ่าน origin เดียวกัน | — |

### 1.3 โมดูล API (`apps/api/src/`, ไฟล์แบน ไม่มีโฟลเดอร์ย่อย — โมดูลเดียว `app.module.ts`)
- **Socket.IO gateway** `flow.gateway.ts` (namespace `/hospital`): คำสั่งเจ้าหน้าที่ทั้งหมด, ห้อง `staff` (ได้ข้อมูลเต็ม) vs สาธารณะ (ตัดชื่อเจ้าหน้าที่ออก), rate limit ต่อ connection (`overLimit`), ตรวจสิทธิ์ 3 ระดับ + ขอบเขตแผนก (`covers`)
- **REST**: `health.controller.ts` (`GET /health` เดียว — ไม่มี live/ready แยก), `patient.controller.ts` (`/api/v1/patient/*`, Bearer session ของผู้ป่วย), `wayfinding.controller.ts` (`GET /api/v1/wayfinding/destinations[/:code]`, สาธารณะ, rate limit 60/นาที/IP, ปิดได้ด้วย flag), `line.controller.ts` (webhook), `ingest.controller.ts` (HIS)
- **ข้อผิดพลาด**: `errors.ts` — `{ok:false, code, reason}` + `AppErrorFilter` (ไม่ใช่รูปแบบ `{error:{code,message,retryable,requestId}}` ของเอกสาร §9) · request id ทุกคำขอใน `main.ts`
- **Feature flag**: `features.service.ts` — ชุดตายตัว `PHASE2_FLAGS` (accountLinking, generalBooking, appointments, notifications, wayfinding, staffOverrides) เก็บใน kv, ค่าตั้งต้นปิด, เปลี่ยนจากหน้าตั้งค่าและบันทึก audit
- **Audit**: `audit.service.ts` (กรองคีย์ลับ, actor เป็นรหัสอ้างอิง) · **ตัวนับ**: `metrics.ts` (ในหน่วยความจำ ไม่มี label ผู้ใช้) · **retention**: `retention.service.ts` (รายหมวด + housekeeping ทุก 6 ชม.)
- **Migrations**: `migrations.ts` เวอร์ชัน 1–10 แบบเพิ่มอย่างเดียว
- **Session/ตัวตน**: เจ้าหน้าที่ `auth.service.ts` (token สุ่ม เก็บ SHA-256, 12 ชม.) · ผู้ป่วย `patient-identity.service.ts` (LINE ID token → session) · **ไม่มีตัวตนของอุปกรณ์/ตู้**

### 1.4 แผนที่และการนำทาง (ตรวจแล้ว)
- ผังอาคาร: `apps/web/lib/scene-data.ts` — อาคาร 5 หลังเป็นกล่องสี่เหลี่ยม (`buildings`), ชั้น, แถบแผนกต่อชั้น, ห้องเรียงเท่ากัน (`floorRooms`, id เช่น `opd-205`) · **ไม่มีโหนด/ทางเดิน/ลิฟต์/บันได/ทางลาด** เป็นข้อมูล
- จุดหมายสาธารณะ: ตาราง `destinations` (migration 8) + `wayfinding.service.ts` — รหัสคงที่, อาคาร/ชั้น/โซน/ห้อง, จุดสังเกต, เลิกใช้พร้อมชี้ที่ใหม่ · ผู้ดูแลจัดการที่ ตั้งค่า → QR นำทาง (`components/pages/WayfindingAdmin.tsx`), นำเข้าจากผังแผนกได้ (`directoryPlaces`)
- เส้นทาง: `directions()` ใน `apps/web/lib/wayfinding.ts` — **อยู่ฝั่งเว็บเท่านั้น** เป็นกฎ อาคาร→ชั้น→ลิฟต์/บันได→จุดสังเกต ไม่ใช่การหาเส้นทางบนกราฟ · ฝั่ง API มีข้อความ "…อยู่ที่อาคาร X ชั้น Y" แยกอยู่ใน `line-bot.ts`
- เวลาให้บริการ: `getServiceHours()` (`scene-data.ts`) จาก queue settings ที่ผู้ดูแลตั้ง

### 1.5 ระบบคิว (Queue Engine)
- `queue.service.ts` (บันทึกการกระทำรายวัน) + `visits.service.ts` (ผู้ป่วยจริง ไม่มีชื่อ/HN) — อยู่ในโปรเซสเดียวกับ API
- ข้อมูลรวมที่เผยแพร่อยู่แล้ว: `live:snapshot` / `live:update` (จำนวนต่อชั้น, คิวและเวลารอต่อจุดบริการ — `packages/contracts`) ส่งให้ทุก socket รวมจอทีวี · **ไม่มี API แบบอ่านอย่างเดียวที่มีการกดกลุ่มเล็ก (small-group suppression)** ตามที่เอกสาร §9 ต้องการ

### 1.6 เสียงและ 3D ที่มีอยู่
- TTS: `announce()` ใน `apps/web/lib/queue.ts` ใช้ `window.speechSynthesis` (th-TH) เรียกคิวที่คอนโซล — ไม่มีเซิร์ฟเวอร์เสียง
- STT / ไมโครโฟน: **ไม่มี** และ `next.config.ts` ตั้ง `Permissions-Policy: microphone=()` **ปิดไมโครโฟนทั้งเว็บ** (กล้องเปิดเฉพาะ self สำหรับสแกน QR)
- 3D: `components/HospitalScene.tsx` (R3F `<Canvas>` orthographic), คนในฉากเป็นหุ่นเรขาคณิตแบบ InstancedMesh (`Figures`) — **ไม่มีไฟล์ GLB/GLTF, ไม่มีโครงกระดูก/visemes, ไม่มีไฟล์เสียง** ใน repo (`apps/web/public` ไม่มี asset ดังกล่าว)
- 2D fallback ที่ใช้ได้: `components/FloorPlanSvg.tsx` (SVG)

### 1.7 Deployment และ CI
- `docker-compose.yml`: api + web + Caddy 2.8 · `deploy/Caddyfile`: `/api/*`, `/socket.io/*`, `/health`, `/line/*`, `/ingest/*` → API; ที่เหลือ → web · HSTS · TZ=Asia/Bangkok
- `apps/api/Dockerfile`, `apps/web/Dockerfile` (web image ยังไม่เคย build ทดสอบ)
- สำรองข้อมูล: `apps/api/scripts/backup.mjs` / `restore.mjs`
- CI: `.github/workflows/ci.yml` — `pnpm typecheck` + `pnpm test` (Node 24, ubuntu-latest, เวลา UTC)
- เฝ้าระวัง: `GET /health` (schema, ข้อความค้าง/ล้มเหลว) + ตัวนับใน สถิติและรายงาน → การทำงานของระบบ · ไม่มี Prometheus

---

## 2. ของที่ใช้ต่อได้

| ต้องการ (เอกสาร) | ใช้ของเดิม | หมายเหตุ |
|---|---|---|
| ค้นหาจุดบริการ / service directory | `destinations` + `GET /api/v1/wayfinding/destinations`, `WayfindingService.list/lookup` | ข้อมูลสาธารณะอยู่แล้ว ผู้ดูแลแก้ได้ มี audit |
| แผนที่ชี้ปลายทาง | `FloorPlanSvg.tsx`, `app/wayfinding/page.tsx` | ไฮไลต์โซน/ห้องได้แล้ว |
| คำอธิบายเส้นทาง | `directions()` (`lib/wayfinding.ts`) | ระดับอาคาร/ชั้น — ดูข้อ 3.1 |
| ตัวจับเจตนาแบบกฎ (ไม่มี LLM) | `answer()` ใน `apps/api/src/line-bot.ts` | จับ "…อยู่ไหน" จากชื่อจุดหมาย, คำถามติดต่อ ฯลฯ — ต้องแยกส่วนที่ผูกกับ LINE (ลิงก์ LIFF) ออกก่อนใช้ร่วม |
| ข้อความติดต่อเจ้าหน้าที่ | `HOSPITAL_CONTACT` (`line-bot.ts` `contactText`) | |
| เวลาทำการ | `getServiceHours()` / queue settings | ตั้งในหน้าตั้งค่าอยู่แล้ว |
| ปิด/เปิดความสามารถ | `features.service.ts` | ต้องเพิ่มชื่อ flag (ดู 3.6) |
| audit, rate limit, ตัวนับ, retention | `audit.service.ts`, `overLimit` / guard ใน `wayfinding.controller.ts`, `metrics.ts`, `retention.service.ts` | |
| ส่งเรื่องถึงเจ้าหน้าที่แบบเรียลไทม์ | ห้อง `staff` + รูปแบบ "ขอความช่วยเหลือ" (`queue:command` action `report`) | Handoff ส่งเข้าคอนโซลได้ด้วยรูปแบบเดียวกัน |
| 3D | three + R3F + Drei (ติดตั้งแล้ว, Drei มี `useGLTF`/`useAnimations`) | ไม่ต้องเพิ่ม dependency สำหรับอวตาร |
| TTS เบื้องต้น | `speechSynthesis` แบบ `announce()` | ดูข้อกังวลข้อ 4.4 |
| รีเซ็ตเมื่อไม่มีคนใช้ | รูปแบบนับถอยหลังใน `app/kiosk/page.tsx` | |
| ป้องกันข้อมูลรั่วบนจอสาธารณะ | `publicEvent`/`publicSettings`, `test/privacy.test.ts` | ใช้เป็นแบบทดสอบ "ไม่มีข้อมูลผู้ป่วย" |

---

## 3. ช่องว่างเมื่อเทียบกับเอกสาร

### 3.1 นำทางแบบกราฟ (เอกสาร §2 ข้อ 3, §9 wayfinding/route) — **ช่องว่างใหญ่ที่สุด**
ไม่มีโหนด ทางเดิน ลิฟต์ บันได ทางลาด หรือคุณสมบัติการเข้าถึง (avoidStairs) ในข้อมูลใด ๆ ผังใน `scene-data.ts` เป็นภาพประกอบ ไม่ใช่ผังจริงของโรงพยาบาล
→ Release A ทำได้ในระดับ "อาคาร → ชั้น → ลิฟต์ → โซน + จุดสังเกต" (ของเดิม) แต่ **ยังไม่มีคำสั่งเลี้ยวซ้าย/ขวาและเส้นทางเลี่ยงบันได** จนกว่าจะได้ผังจริงที่มีเจ้าของรับรอง (เอกสาร §19 ข้อ 1) — ต้องตัดสินใจว่ายอมรับระดับนี้สำหรับนำร่องหรือรอผัง

### 3.2 ตัวตนของตู้ (§9 kiosk session, §12)
ไม่มี device credential, การหมุนเวียน/เพิกถอน, หรือ session สั้นของตู้ · ตู้เช็กอินปัจจุบันใช้บัญชีเจ้าหน้าที่ ซึ่ง **ไม่เหมาะ** กับตู้ Reception (ตู้ที่ล็อกอินบัญชีเจ้าหน้าที่จะได้สิทธิ์เจ้าหน้าที่ทั้งหมด)

### 3.3 อวตาร (§6)
ไม่มีโมเดล GLB/GLTF ที่มีโครงกระดูก, blend shape, animation หรือใบอนุญาต · ต้องจัดหา (ซื้อ/จ้าง/ใช้โมเดลที่อนุญาตเชิงพาณิชย์) — ห้ามใช้หน้าบุคลากรจริงโดยไม่มีหนังสือยินยอม

### 3.4 ชื่อเส้นทาง
เอกสารเสนอ `app/kiosk/page.tsx` แต่ `/kiosk` คือตู้เช็กอินที่ใช้งานอยู่ → เสนอ **`/reception`** และไม่แตะ `/kiosk`

### 3.5 รูปแบบ API และสัญญา
- เอกสารเสนอ `/api/reception/v1/...` — Caddy ส่ง `/api/*` เข้า API อยู่แล้ว จึงใช้ได้โดยไม่แก้ deployment
- รูปแบบ error ต่างกัน (เอกสาร `{error:{…, retryable, requestId}}` vs ระบบ `{ok:false, code, reason}`) → เสนอใช้ของเดิมเพื่อไม่ให้มีสองแบบ เพิ่ม `requestId` จาก header ได้
- ไม่มี runtime validator กลาง — ระบบตรวจ input ด้วยมือในแต่ละ service · เอกสารต้องการ discriminated union ของ `actions` ที่ปฏิเสธชนิดที่ไม่รู้จัก → ทำได้ด้วย type + ตัวตรวจในไฟล์เดียว ไม่จำเป็นต้องเพิ่ม library
- ไม่มี `/health/live`, `/health/ready` แยก (มี `/health` เดียว)

### 3.6 Feature flag
`PHASE2_FLAGS` เป็นชุดตายตัว ต้องเพิ่ม `reception` (และตามเอกสาร §18 ข้อ 2: voice, AI, queue summary แยกกัน ค่าตั้งต้นปิด) · เอกสารเสนอ env (`RECEPTION_AI_ENABLED` ฯลฯ) — เสนอให้ voice/AI เป็น env (ผู้ดูแลเครื่องเปิด ต้องรีสตาร์ต) และ `reception` เป็นสวิตช์ในหน้าตั้งค่า

### 3.7 FAQ ที่อนุมัติแล้ว
ไม่มีที่เก็บเนื้อหา FAQ/ขั้นตอนรับบริการ/ข้อความฉุกเฉินที่มีเจ้าของ เวอร์ชัน และสถานะอนุมัติ · บอท LINE ตอบด้วยข้อความที่เขียนไว้ในโค้ด

### 3.8 Handoff
ยังไม่มีปลายทาง "เรียกเจ้าหน้าที่" สำหรับตู้ (ใคร เห็นที่ไหน ตอบสนองอย่างไร — เอกสาร §19 ข้อ 7)

### 3.9 ตัวชี้วัดการใช้งาน (§11, §15)
ไม่มีตาราง usage event ของ Reception · `metrics.ts` นับในหน่วยความจำ (หายเมื่อรีสตาร์ต) · รายงานเฟส 2 ใช้ข้อมูลจากตารางจริง

### 3.10 ข้อมูลคิวรวม (ปิดไว้ตามเอกสาร)
มีตัวเลขรวมใน live snapshot อยู่แล้วแต่ไม่มีการกดกลุ่มเล็กและไม่มีคำนิยามที่โรงพยาบาลอนุมัติ → คงปิดไว้ (เมนู "ข้อมูลคิวทั่วไป" แสดงเป็นปิด)

---

## 4. ข้อกังวลด้านความเป็นส่วนตัวและความปลอดภัย

1. **ตู้ = เครื่องสาธารณะ** — ห้ามใช้บัญชีเจ้าหน้าที่บนตู้ Reception (ต่างจาก `/kiosk`) · ต้องมี device credential ที่หมุนเวียน/เพิกถอนได้ และ session สั้น (ข้อ 3.2) ก่อนนำร่องตู้จริง
2. **ห้ามข้อมูลผู้ป่วย** — Reception ต้องไม่เรียก `patient.controller`, `visits`, booking/appointment หรือ socket ห้อง `staff` เลย · ควรมี test ยืนยันว่า response ไม่มีรูปแบบ HN/ชื่อ/เลขคิวรายคน (ต่อยอด `test/privacy.test.ts`)
3. **socket สาธารณะส่งข้อมูลมากกว่าที่ Reception ต้องใช้** — ทุก socket ที่ไม่ล็อกอินได้ queue log (ไม่มีชื่อเจ้าหน้าที่) และรายการ visit (ไม่มีชื่อ/HN) อยู่แล้วเพื่อจอทีวี · หน้า Reception **ไม่ควรเปิด socket** ใช้ REST อย่างเดียว เพื่อไม่ให้ตู้ในล็อบบี้ถือข้อมูลคิวรายคน
4. **TTS ของเบราว์เซอร์อาจส่งข้อความออกนอก** — บน Chrome เสียง "Google ไทย" สังเคราะห์บนเซิร์ฟเวอร์ Google (`SpeechSynthesisVoice.localService === false`) ขัดกับ "No external AI endpoint" (§3, §12) แม้ข้อความจะเป็น FAQ สาธารณะ → ใช้เฉพาะเสียงในเครื่อง (`localService`) หรือไฟล์เสียงที่บันทึกไว้ และต้องเลือกเบราว์เซอร์/ระบบปฏิบัติการของตู้ให้มีเสียงไทยในเครื่อง
5. **STT ของเบราว์เซอร์ (Web Speech API) ส่งเสียงไปคลาวด์** — ใช้ไม่ได้ตามเอกสาร · Release B ต้องเป็น STT ในเครื่อง/ในโรงพยาบาล
6. **ไมโครโฟนถูกปิดทั้งเว็บ** (`Permissions-Policy: microphone=()` ใน `next.config.ts`) — ดีสำหรับ Release A · Release B ต้องเปิดเฉพาะเส้นทาง `/reception` ไม่ใช่ทั้งเว็บ
7. **ข้อความฉุกเฉินและคำถามทางการแพทย์** — ต้องเป็นข้อความที่โรงพยาบาลอนุมัติ ตอบแบบตายตัว (ไม่สร้างใหม่) · ตัวจับเจตนาต้องมีหมวด "คำถามทางคลินิก" ที่ตอบด้วยการส่งต่อเจ้าหน้าที่เสมอ
8. **ไม่เก็บข้อความที่พิมพ์/พูด** — log ของ API ไม่บันทึก body อยู่แล้ว (`main.ts` ตั้งแค่ request id) · usage event ต้องเก็บแค่หมวดเจตนาและผลลัพธ์ ไม่เก็บข้อความ ไม่เก็บ session id ดิบ
9. **Rate limit ต่อ IP** — ตู้หลายเครื่องหลัง NAT เดียวกันจะใช้โควตาร่วมกัน (`wayfinding.controller.ts` 60/นาที/IP) → Reception ควรนับต่อ kiosk id หลังมี device credential
10. **3D บนเครื่องตู้** — WebGL ล้ม/ช้า ต้องมี 2D fallback (เอกสาร §5) · ต้องทดสอบหน่วยความจำ GPU ระยะยาว 4–8 ชม.
11. **เอกสารสเปกถูก commit เข้า repo แล้ว** (`8be5b6b`) — ไม่มีข้อมูลลับ แต่ควรยืนยันว่าเผยแพร่ใน repo ได้

---

## 5. แผน Release A ที่เล็กที่สุด (ไม่มี LLM, ไม่มี vector DB, ไม่มี GPU, ไม่มี AI ภายนอก)

หลักการ: ใช้ของเดิมให้มากที่สุด, สไตล์ไฟล์แบนเหมือน `apps/api/src/*`, ไม่เพิ่ม dependency, ทุกอย่างปิดไว้จนผู้ดูแลเปิด

### ขั้น A1 — สัญญาและสวิตช์
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/api/src/features.service.ts` | เพิ่ม flag `reception` (ปิดเป็นค่าตั้งต้น) |
| `apps/api/src/reception-types.ts` (ใหม่) | type ของ turn/response/`actions` (union: `show_wayfinding`, `show_faq`, `show_menu`, `handoff`) + ตัวตรวจที่ปฏิเสธชนิดที่ไม่รู้จัก |
| env (`apps/api/.env.example`) | `RECEPTION_VOICE_ENABLED=false`, `RECEPTION_AI_ENABLED=false`, `RECEPTION_QUEUE_SUMMARY_ENABLED=false` (เอกสาร §18 ข้อ 2) |

### ขั้น A2 — ตัวตนของตู้และ session (ก่อนตั้งตู้จริง)
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/api/src/migrations.ts` | migration 11: `kiosk_devices` (id, ชื่อ/ตำแหน่ง, ปลายทางเริ่มต้น `at` code, hash ของ credential, สถานะ, หมุนเวียนล่าสุด) · `reception_usage` (วัน, kiosk, ชนิดเหตุการณ์, หมวดเจตนา, จำนวน — ไม่มีข้อความ ไม่มี session id) · `reception_faq` (ดู A3) |
| `apps/api/src/kiosk-device.service.ts` (ใหม่) | ลงทะเบียนตู้ → credential แสดงครั้งเดียว (เก็บเฉพาะ hash), หมุนเวียน, เพิกถอน, แลกเป็น session 5 นาที (ในหน่วยความจำ) |
| `apps/api/src/flow.gateway.ts` | คำสั่งผู้ดูแล `reception:kiosks`, `reception:kiosk:save/rotate/revoke` + audit |

### ขั้น A3 — FAQ และตัวจับเจตนาแบบกฎ
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/api/src/reception-faq.service.ts` (ใหม่) | เนื้อหา FAQ/ขั้นตอนรับบริการ/เวลาทำการ/ข้อความฉุกเฉิน: เจ้าของแผนก, เวอร์ชัน, อนุมัติแล้วหรือไม่, ช่วงวันที่มีผล — ตอบได้เฉพาะที่อนุมัติและยังมีผล |
| `apps/api/src/intent-rules.ts` (ใหม่, แยกจาก `line-bot.ts`) | กฎร่วม: จับชื่อจุดหมายยาวที่สุด, คำค้น FAQ, หมวดคลินิก/ฉุกเฉิน/ส่วนตัว → ส่งต่อ · `line-bot.ts` เรียกใช้ตัวเดียวกัน (พฤติกรรม LINE เดิมต้องไม่เปลี่ยน — `test/linebot.test.ts` เป็นตัวยืนยัน) |
| `apps/api/src/reception.service.ts` (ใหม่) | ลำดับตามเอกสาร §10: ตรวจ session → ตรวจขนาด/อัตรา → จับเจตนาด้วยกฎ → ตอบจาก FAQ/destinations → ไม่แน่ใจ = เมนูหรือส่งต่อ (ไม่เดา) → นับ usage |
| `apps/api/src/reception.controller.ts` (ใหม่) | `POST /api/reception/v1/kiosk/session`, `POST /api/reception/v1/sessions`, `POST …/sessions/:id/turns` (ข้อความ/ปุ่ม), `GET …/wayfinding/destinations?q=`, `GET …/capabilities` · ไม่มี voice-turn ใน Release A |
| `apps/api/src/app.module.ts` | ลงทะเบียน controller/service ใหม่ |

### ขั้น A4 — นำทาง (ระดับที่มีข้อมูลรองรับ)
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/api/src/wayfinding.service.ts` | ย้าย/คัดลอกตรรกะ `directions()` ให้ฝั่ง API สร้างข้อความเส้นทางได้ (ข้อความตอบต้องมาจากเซิร์ฟเวอร์ ไม่ใช่ประกอบในตู้) · ต้นทาง = จุดหมายประจำตู้ (`kiosk_devices.at`) |
| — | กราฟทางเดิน/เลี่ยงบันได **รอผังจริง** (ข้อ 3.1) — ออกแบบตาราง nodes/edges เมื่อได้ข้อมูล |

### ขั้น A5 — หน้า Reception
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/web/app/reception/page.tsx` (ใหม่) | ตู้ล็อกอินด้วย credential ของอุปกรณ์ (ครั้งแรก) ไม่ใช่บัญชีเจ้าหน้าที่ · REST อย่างเดียว ไม่เปิด socket · รีเซ็ตเมื่อว่าง 5 นาที (และเคลียร์ทันทีหลังจบเรื่อง) |
| `apps/web/components/reception/ReceptionShell.tsx` | state machine เอกสาร §5 (IDLE/WELCOME/MENU/RESPONDING/HANDOFF/ERROR_RECOVERY/SESSION_RESET) |
| `…/TouchMenu.tsx` | 6 ปุ่มตามเอกสาร §5 (ข้อมูลคิวทั่วไป = ปิด, พูดคุย = ปิดใน Release A) + ช่องค้นหาข้อความ |
| `…/WayfindingPanel.tsx` | ใช้ `FloorPlanSvg` + ข้อความเส้นทางจาก API + QR "ถือเส้นทางไปด้วย" (`signUrl(code,'to')`) |
| `…/FaqPanel.tsx`, `…/HandoffPanel.tsx`, `…/Captions.tsx` | คำตอบ + แหล่งที่มา, เรียกเจ้าหน้าที่, คำบรรยายเสมอเมื่อพูด |
| `…/AvatarCanvas.tsx` + `…/Avatar2D.tsx` | R3F + Drei `useGLTF`/`useAnimations` โหลดแบบ lazy · สถานะ idle/greeting/pointing/fallback · WebGL ใช้ไม่ได้ → ภาพ 2D · **ก่อนได้โมเดลที่มีลิขสิทธิ์ ใช้ภาพ 2D/ตัวละครเรียบ ๆ ไม่ปลอมเป็นคนจริง** |
| `apps/web/lib/reception/client.ts`, `…/speech.ts` | เรียก API · พูดด้วย `speechSynthesis` **เฉพาะเสียงที่ `localService`** หรือไฟล์เสียงที่บันทึกไว้ · ไม่มีเสียงในเครื่อง = แสดงข้อความอย่างเดียว |

### ขั้น A6 — หน้าตั้งค่าและการส่งต่อ
| ไฟล์ | สิ่งที่ทำ |
|---|---|
| `apps/web/components/pages/ReceptionAdmin.tsx` + `SettingsPage.tsx` | ตั้งค่า → Reception: สวิตช์, ตู้ (ลงทะเบียน/หมุนเวียน/เพิกถอน), FAQ (ร่าง → อนุมัติ, เจ้าของ, วันมีผล), ข้อความฉุกเฉิน, ยอดใช้งานรวม |
| `apps/api/src/flow.gateway.ts` + `components/pages/QueuePage.tsx` | "เรียกเจ้าหน้าที่" จากตู้ → แจ้งในคอนโซลห้อง `staff` พร้อมตำแหน่งตู้ (รูปแบบเดียวกับคำขอช่วยเหลือของผู้ป่วย) — ปลายทางรอโรงพยาบาลกำหนด |
| `apps/api/src/retention.service.ts` | เพิ่มหมวด `reception_usage` (ค่าตั้งต้นเก็บตลอดเหมือนหมวดอื่น) |

### ขั้น A7 — ทดสอบ
| ไฟล์ | ทดสอบ |
|---|---|
| `apps/api/test/reception.test.ts` | ตอบเฉพาะ FAQ ที่อนุมัติ/ยังมีผล · คำถามคลินิก/HN/ชื่อ/นัด → ส่งต่อ 100% · action ที่ไม่รู้จักถูกปฏิเสธ · session หมดอายุ/ตู้ถูกเพิกถอน · rate limit · response ไม่มีข้อมูลผู้ป่วย · ไม่มีข้อความผู้ใช้ใน DB/usage · ปิด flag แล้วตอบ FEATURE_DISABLED |
| `apps/api/test/linebot.test.ts` (ของเดิม) | ต้องผ่านเหมือนเดิมหลังแยกกฎร่วม |
| `apps/web/test/reception.test.ts` | state machine, รีเซ็ตเมื่อว่าง, เลือกเฉพาะเสียง localService |
| ตรวจด้วยเบราว์เซอร์ | หน้าจอแนวตั้ง/แนวนอนของตู้จริง, WebGL fallback, เปิด 8 ชม. |

**ไม่ต้องเพิ่ม dependency ใด ๆ** สำหรับ Release A · **ไม่ต้องแก้ Caddy/Docker** (`/api/*` และหน้าเว็บผ่าน route เดิม)

---

## 6. ส่วนเสริม (แยกจาก Release A) และคำถามที่ยังเปิด

### B — เสียงพูด
| งาน | ต้องการ | คำถามค้าง |
|---|---|---|
| TTS ในเครื่อง | เสียงไทยใน OS ของตู้ (`localService`) หรือเครื่องยนต์ TTS ในโรงพยาบาล หรือไฟล์เสียงที่บันทึกล่วงหน้า | ระบบปฏิบัติการ/เบราว์เซอร์ของตู้มีเสียงไทยในเครื่องหรือไม่ · ใบอนุญาตเสียง · คุณภาพการอ่านชื่อแผนก |
| STT ในเครื่อง | adapter ฝั่ง API + `POST …/voice-turns` (multipart, 12 วินาที, 8 MB, ทิ้งเสียงทันที) · เปิดไมโครโฟนเฉพาะ `/reception` | เลือกเครื่องยนต์ STT ภาษาไทยที่รันในโรงพยาบาลได้ + ใบอนุญาต · วัดความแม่นยำในเสียงรบกวนล็อบบี้ · CPU พอหรือไม่ (วัดก่อนซื้อ) |
| ลิปซิงก์ | visemes จาก TTS (ถ้ามี) หรือขยับปากตามความดัง | ขึ้นกับโมเดลอวตารและ TTS ที่เลือก |
| multipart upload | NestJS มี `@nestjs/platform-express` (multer) อยู่แล้ว | ตรวจขนาด/ชนิดไฟล์ก่อนเขียนลงดิสก์ — ต้องตั้งให้อยู่ในหน่วยความจำ |

### C/D — LLM (ทำเมื่อมีหลักฐานเท่านั้น)
- เก็บสถิติหมวดเจตนาที่ "ตอบไม่ได้" จาก `reception_usage` ระหว่างนำร่อง (ไม่เก็บข้อความ) → สร้างชุดทดสอบสังเคราะห์ → เทียบ "เพิ่ม FAQ/กฎ" กับ "LLM ในเครื่อง"
- **ไม่แนะนำให้ซื้อ GPU หรือเครื่อง inference ก่อนผลวัด** (ตามเอกสาร §14)
- โครงที่เตรียมไว้: `RECEPTION_AI_ENABLED=false` + จุดเสียบ adapter ใน `reception.service.ts` ที่ตอนนี้ตอบ "ไม่รองรับ" เสมอ

### ฮาร์ดแวร์และใบอนุญาตที่ต้องได้คำตอบ
1. รุ่นตู้: จอ (ขนาด/แนวตั้ง?), touch, ลำโพง, ไมโครโฟน, GPU ในตัว, เบราว์เซอร์/OS
2. โมเดลอวตาร: แหล่ง, ใบอนุญาตเชิงพาณิชย์/สาธารณะ, ขนาดไฟล์ที่ตู้รับได้
3. ผังทางเดินจริงและเจ้าของข้อมูล (เพื่อทำกราฟ)
4. เสียง TTS/STT ไทยที่รันในโรงพยาบาลได้ และใบอนุญาต

---

## 7. ทดสอบที่รันจริงในรอบนี้

| คำสั่ง | ผล |
|---|---|
| `node -v` | v24.21.0 |
| `pnpm typecheck` | ผ่าน (web + api) |
| `pnpm test` | **web 28/28 ผ่าน** (3.1 วินาที) · **api 139/139 ผ่าน** (10.1 วินาที) |
| CI บน GitHub ของ `adc2195` | ผ่าน (`completed success`) |

ไม่ได้รัน: `next build` / Docker build (ไม่เกี่ยวกับการสำรวจ และ web image ยังไม่เคย build ทดสอบ), การทดสอบบนเครื่องตู้จริง, การทดสอบเสียง

---

## 8. ต้องการการตัดสินใจก่อนเริ่ม Release A

1. **ชื่อหน้า**: ใช้ `/reception` (ไม่แตะตู้เช็กอิน `/kiosk`) — เห็นด้วยหรือไม่
2. **ระดับการนำทางสำหรับนำร่อง**: ยอมรับ "อาคาร/ชั้น/ลิฟต์/โซน + จุดสังเกต + แผนผัง" ไปก่อน แล้วทำกราฟเมื่อได้ผังจริง — หรือรอผัง
3. **อวตาร**: ระหว่างรอโมเดลที่มีลิขสิทธิ์ ใช้ภาพ 2D/ตัวละครเรียบ ๆ ได้หรือไม่
4. **เนื้อหา**: ใครเป็นเจ้าของ FAQ, ขั้นตอนรับบริการ, ข้อความฉุกเฉิน — และใครอนุมัติ
5. **Handoff**: "เรียกเจ้าหน้าที่" ไปที่ใคร (คอนโซลประชาสัมพันธ์? เบอร์โทร?) ช่วงเวลาไหน
6. **เสียงใน Release A**: ใช้เสียงในเครื่องของตู้/ไฟล์เสียงที่บันทึกไว้ หรือยังไม่เปิดเสียง
7. **ตัวตนของตู้**: ทำ device credential ใน Release A เลย (แนะนำ ก่อนตั้งตู้จริงในพื้นที่สาธารณะ)

> หยุดที่รายงานนี้ตามเอกสาร §20 — รอตรวจทานก่อนลงมือ

---

## 9. ความคืบหน้า — Release A รอบแรก (18 ต.ค. 2026)

**การตัดสินใจที่ใช้** (ตามข้อแนะนำในหัวข้อ 8 · เปลี่ยนได้ภายหลัง): หน้า `/reception` (ไม่แตะ `/kiosk`) · นำทางระดับอาคาร/ชั้น/ลิฟต์/โซน + แผนผัง (กราฟรอผังจริง) · อวตาร 2D ไปก่อน · ผู้ดูแลระบบเขียนและอนุมัติคำตอบ · "เรียกเจ้าหน้าที่" แจ้งคอนโซลทุกจอ + แสดงเบอร์ติดต่อ · เสียงพูดเฉพาะเสียงไทยในเครื่องตู้ · ตัวตนของตู้ทำในรอบนี้

| ส่วน | ไฟล์ | สถานะ |
|---|---|---|
| สวิตช์ | `features.service.ts` (`reception`) | ✅ ค่าตั้งต้นปิด |
| ตาราง | migration 11: `kiosk_devices`, `reception_answers`, `reception_usage` | ✅ |
| ตัวตนของตู้ | `kiosk-device.service.ts` | ✅ รหัสแสดงครั้งเดียว (เก็บ hash), token 15 นาที, หมุนเวียน/เพิกถอนมีผลทันที, จำกัดการเดารหัสต่อ IP |
| กฎจับเจตนาร่วม | `intent-rules.ts` (ใช้ทั้ง `line-bot.ts` และตู้) | ✅ ฉุกเฉิน → จุดหมาย → คลินิก → ข้อมูลส่วนตัว → คำตอบที่อนุมัติ → เวลา → เจ้าหน้าที่ → ไม่แน่ใจ = เมนู |
| บริการตู้ | `reception.service.ts` | ✅ คำตอบร่าง/อนุมัติ/ช่วงวันมีผล (แก้ = ร่างใหม่), session 5 นาที คนเดียวต่อตู้, จำกัด 30 ครั้ง/นาที/ตู้, เรียกเจ้าหน้าที่, นับยอดรายวัน (ไม่เก็บข้อความ) |
| เส้นทางฝั่งเซิร์ฟเวอร์ | `routeSteps()` ใน `wayfinding.service.ts` | ✅ เริ่มจากจุดที่ตั้งตู้ |
| REST | `reception.controller.ts` — `/api/reception/v1/{kiosk/session, kiosk/session/refresh, capabilities, sessions, sessions/:id/turns, sessions/:id/help, sessions/:id/end, places}` | ✅ ผ่าน Caddy `/api/*` เดิม |
| คำสั่งผู้ดูแล | `flow.gateway.ts` `reception:*` + audit | ✅ |
| หน้าตู้ | `app/reception/page.tsx`, `components/reception/{ReceptionShell,Avatar}.tsx`, `lib/reception/{client,speech}.ts` | ✅ ไม่เปิด socket · ไม่รับ action ที่ไม่รู้จัก · กลับหน้าแรกเมื่อว่าง 90 วินาที · QR เส้นทางไปมือถือ |
| หน้าตั้งค่า | `components/pages/ReceptionAdmin.tsx` (ตั้งค่า → ตู้ต้อนรับ) | ✅ ตู้, คำตอบ, ยอดใช้งาน 30 วัน |
| แจ้งเจ้าหน้าที่ | `QueuePage.tsx` (`KioskHelpBar`), `lib/queue.ts` (`kioskHelp`) | ✅ ฉุกเฉินเป็นแถบแดง |
| เก็บข้อมูล | `retention.service.ts` หมวด `reception` | ✅ ค่าตั้งต้นเก็บตลอด |
| ทดสอบ | `apps/api/test/reception.test.ts` (8), `apps/web/test/reception.test.ts` (3), `linebot.test.ts` เดิมผ่าน | ✅ api 147/147 · web 31/31 · typecheck ผ่าน · API ผ่านทั้งเวลา UTC |
| ทดสอบในเบราว์เซอร์ | ตั้งค่าตู้ → เมนู → ค้นหาจุดบริการ → ถามทาง (เส้นทาง+แผนผัง+QR) → ขั้นตอน → คำถามคลินิก/ส่วนตัว (ส่งต่อ) → ไม่เข้าใจ (เมนู) → เรียกเจ้าหน้าที่ → แถบในคอนโซลเจ้าหน้าที่ → รับเรื่อง | ✅ ไม่มี error ในหน้า |

**ยังไม่ได้ทำ / รอโรงพยาบาล**
- กราฟทางเดินและเส้นทางเลี่ยงบันได — รอผังจริงและเจ้าของข้อมูล
- อวตาร 3D — รอโมเดลที่มีลิขสิทธิ์ (ตอนนี้ 2D ไม่เหมือนบุคคลจริง)
- เนื้อหาคำตอบจริง, ข้อความฉุกเฉินที่อนุมัติ, ปลายทางของ "เรียกเจ้าหน้าที่" นอกเวลา
- ทดสอบบนเครื่องตู้จริง (จอ, เสียงไทยในเครื่อง, เปิด 8 ชม.) และแป้นพิมพ์บนจอของตู้
- Release B (พูดสั่งด้วยเสียง) และ LLM — ยังไม่เริ่ม ตามเอกสาร
