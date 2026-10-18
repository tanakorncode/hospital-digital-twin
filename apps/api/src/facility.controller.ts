import { Controller, Get, Header } from '@nestjs/common';
import { FacilityService } from './facility.service';

// Public (no sign-in): the facility for screens that do not keep a socket open — QR wayfinding, the LINE pages, the
// reception kiosk. Places only (buildings, floors, departments, rooms and counters), nothing retired, nothing about people.
//   GET /api/v1/facility
@Controller('api/v1/facility')
export class FacilityController {
  constructor(private readonly facility: FacilityService) {}
  @Get()
  @Header('Cache-Control', 'no-cache')
  get() {
    return { ok: true, facility: this.facility.publicView() };
  }
}
