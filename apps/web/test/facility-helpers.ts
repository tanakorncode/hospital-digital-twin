// Tests change the hospital the way the API does: the old Settings layout folded into the sample hospital
// (apps/api/src/facility-template.ts), published as a new facility version.
import { sampleFacility as template } from '../../api/src/facility-template';
import { setFacility } from '../lib/facility';
import { setLayout, type Layout } from '../lib/scene-data';

let version = 1000;
export function useLayout(layout?:Layout) {
  setLayout(layout);
  setFacility({...template(layout ?? {}),version:++version,publishedAt:`test-${version}`});
}
