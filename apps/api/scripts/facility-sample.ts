// Writes the sample hospital (src/facility-template.ts) as the web app's starting facility, used until the API's
// facility arrives and when the screen runs without the API: apps/web/lib/facility-sample.json.
//   pnpm --filter api facility:sample        (apps/web/test/facility-sample.test.ts fails when it is out of date)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleFacility } from '../src/facility-template';

const out = join(__dirname, '..', '..', 'web', 'lib', 'facility-sample.json');
writeFileSync(out, `${JSON.stringify({ ...sampleFacility(), version: 0, publishedAt: '' })}\n`);
console.log(`wrote ${out}`);
