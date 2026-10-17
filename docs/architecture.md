# Architecture and data flow

```text
HIS / Queue / Appointment systems
            |
            v
  Integration Adapter (per source)
  - auth, schema mapping, validation
  - idempotency + timestamp checks
            |
            v
  Canonical Queue/Flow Event
            |
            v
 NestJS Domain Service ---> PostgreSQL (current state + event history)
            |                         |
            +---- transactional outbox+
            |
            v
 WebSocket Gateway (/hospital)
            |
            v
 Next.js dashboard + React Three Fiber
 - campus/building geometry
 - service point status
 - aggregate patient-flow animation
```

## Important modeling rules
- Keep physical geometry separate from live operational data.
- Give every building, floor, room, corridor node, and service point a stable ID.
- Use an explicit navigation graph for routing; do not infer walkable paths from arbitrary 3D meshes.
- Queue-based data indicates workflow state, not exact physical location.
- For real location tracking, use an approved RTLS/BLE system and privacy assessment.
- Render an aggregate or sampled number of actors. Never imply actor count equals the real patient count unless explicitly calibrated.
- Treat late and duplicate events as normal integration conditions.
