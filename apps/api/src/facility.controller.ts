import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { AppError } from './errors';
import { FacilityService } from './facility.service';

// Public (no sign-in): the facility for screens that do not keep a socket open — QR wayfinding, the LINE pages, the
// reception kiosk. Places only (buildings, floors, departments, rooms and counters), nothing retired, nothing about people.
//   GET /api/v1/facility
//   GET /api/v1/facility/images/:id   a floor-plan picture (ids are never reused, so it is cached for good)
@Controller('api/v1/facility')
export class FacilityController {
  constructor(private readonly facility: FacilityService) {}
  @Get()
  @Header('Cache-Control', 'no-cache')
  get() {
    return { ok: true, facility: this.facility.publicView() };
  }
  @Get('images/:id')
  image(@Param('id') id: string, @Res() res: { setHeader: (k: string, v: string) => void; end: (b: Uint8Array) => void }) {
    const img = this.facility.image(id);
    if (!img) throw new AppError('RESOURCE_NOT_FOUND', 'ไม่พบภาพ');
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(img.bytes);
  }
}
