import type { CallErrorCode } from '../shared/protocol.js';

/** A failure of an engine call; `message` is safe to show to the user. */
export class CallError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CallError';
  }
}
