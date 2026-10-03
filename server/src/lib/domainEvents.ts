import { EventEmitter } from 'node:events';
import type { MessageDto } from '../modules/messages/dto.js';

/**
 * In-process domain events. Lets modules announce facts ("session revoked")
 * without importing the realtime layer. Cross-instance delivery is the
 * realtime bus's job (Redis pub/sub), not this emitter's.
 */
export interface DomainEvents {
  'session.revoked': { sessionId: string; userId: string };
  'user.blocked': { blockerId: string; blockedId: string };
  'user.profileUpdated': { userId: string };
  'message.created': { message: MessageDto; recipientIds: string[] };
  'call.incoming': { callId: string; callerId: string; calleeId: string; type: string };
  'call.missed': { callId: string; callerId: string; calleeId: string };
}

class TypedEmitter {
  private ee = new EventEmitter();
  on<K extends keyof DomainEvents>(event: K, fn: (payload: DomainEvents[K]) => void | Promise<void>) {
    this.ee.on(event, (p) => {
      Promise.resolve(fn(p)).catch((err) => this.ee.emit('error', err));
    });
  }
  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]) {
    this.ee.emit(event, payload);
  }
  onError(fn: (err: unknown) => void) {
    this.ee.on('error', fn);
  }
}

export const domainEvents = new TypedEmitter();
