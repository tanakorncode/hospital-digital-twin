// One competing booking from its own thread and its own database connection (see booking.test.ts).
import { Logger } from '@nestjs/common';
import { parentPort, workerData } from 'node:worker_threads';
import { BookingService } from '../../src/booking.service';
import { DbService } from '../../src/db.service';

Logger.overrideLogger(false);
const { file, slotId, hn, now, go } = workerData as { file: string; slotId: string; hn: string; now: string; go: Int32Array };
process.env.DB_PATH = file;
const db = new DbService(), booking = new BookingService(db);
booking.now = () => new Date(now);
const profile = booking.profileForHN(hn);
Atomics.wait(go, 0, 0); // every thread starts together
try { booking.book(profile, slotId, 'STAFF', 'worker'); parentPort!.postMessage('ok'); }
catch (e) { parentPort!.postMessage((e as { code?: string; message: string }).code ?? (e as Error).message); }
db.db.close();
