export type ServicePointStatus = 'normal' | 'busy' | 'critical';
export interface QueueAggregate {
  servicePointId: string;
  queueCount: number;
  averageWaitMinutes: number;
  status: ServicePointStatus;
  observedAt: string;
}
export interface FlowEvent {
  eventId: string;
  sourceId: string;
  occurredAt: string;
  schemaVersion: 1;
  aggregate: QueueAggregate;
}

// Pushed on the /hospital namespace as 'live:snapshot' (on connect) and 'live:update'. Aggregates only.
export interface LiveSnapshot {
  at: string;
  source: 'demo' | 'his-adapter';
  floors: Record<string, number>; // "buildingId:level" → people on that floor
  servicePoints: Record<string, { queue: number; waitMinutes: number; status: ServicePointStatus }>;
  // Optional, from the duty-roster system: roomId (e.g. "opd-201") → doctor on duty now.
  duty?: Record<string, { status: 'active' | 'break' | 'vacant'; doctor?: { title: 'นพ.' | 'พญ.'; first: string; last: string }; from?: number; to?: number }>;
}

// Queue staff actions, broadcast on /hospital as 'queue:event' ('queue:events' = today's full log on connect).
// Clients send 'queue:command' (an event without id). `at` = minutes since midnight.
export type QueueAction = 'open' | 'close' | 'call' | 'recall' | 'start' | 'hold' | 'return' | 'done' | 'transfer' | 'lock' | 'unlock' | 'pause' | 'resume' | 'config' | 'report' | 'resolve';
export interface QueueEvent { id: string; at: number; station: string; action: QueueAction; patientId?: string; step?: number; reason?: string; returnAfter?: number; target?: string; position?: 'keep' | 'end'; by?: string; key?: string }
