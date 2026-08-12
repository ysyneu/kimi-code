import type { Event } from '../events';
import type { WsEventFrame } from './protocol';

/**
 * Translate a WS event frame into the SDK Event shape. kap-server's payloads
 * are manually aligned with the v1 Event type (no type-system guarantee), so
 * this is the assertion layer: anything structurally wrong is dropped (null),
 * anything well-formed passes through with its payload fields intact.
 */
export function translateWireEvent(frame: WsEventFrame): Event | null {
  const payload = frame.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate['type'] !== 'string') return null;
  const sessionId =
    typeof candidate['sessionId'] === 'string'
      ? (candidate['sessionId'] as string)
      : frame.session_id;
  if (sessionId === undefined && !isGlobalEventType(candidate['type'])) return null;
  const agentId = typeof candidate['agentId'] === 'string' ? (candidate['agentId'] as string) : 'main';
  return { ...candidate, sessionId, agentId } as unknown as Event;
}

export function isGlobalEventType(type: string): boolean {
  return (
    type === 'session.meta.updated' ||
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.')
  );
}
