import { sampleFacility } from './facility-template';

// Names of places for messages and directions (LINE replies, the reception kiosk, wayfinding steps), from the facility
// model: FacilityService registers them whenever a version is loaded. Before that (a bare function in a test) the
// sample hospital's names are used.
type Names = { building: (id: string) => string | undefined; floor: (buildingId: string, level: number) => string | undefined;
  entrance: () => { buildingId: string; level: number; nameTh: string } | undefined };
const sample = sampleFacility();
let names: Names = { building: (id) => sample.buildings.find((b) => b.id === id)?.name, floor: (b, l) => sample.floors.find((f) => f.buildingId === b && f.level === l)?.name,
  entrance: () => ({ buildingId: 'opd', level: 1, nameTh: `ทางเข้าหลัก ${sample.buildings[0].name}` }) };
export const setFacilityNames = (n: Names) => { names = n; };
export const buildingName = (id: string) => names.building(id) ?? `อาคาร ${id}`;
export const floorName = (buildingId: string, level: number) => names.floor(buildingId, level) ?? `ชั้น ${level}`;
// The main entrance: the ground floor of the building with registration.
export const mainEntrance = () => names.entrance();
