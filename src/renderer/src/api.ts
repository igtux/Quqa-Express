/** Typed access to `window.quqa.call`: resolves with the value or throws an AppError. */
import type { AppMethod, CallParams, CallValue } from '../../shared/ipc.js';
import type { CallErrorCode } from '../../shared/protocol.js';

export class AppError extends Error {
  constructor(
    readonly code: CallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export async function call<M extends AppMethod>(
  method: M,
  params: CallParams<M>,
): Promise<CallValue<M>> {
  const result = await window.quqa.call(method, params);
  if (!result.ok) throw new AppError(result.code, result.message);
  return result.value;
}

/** A message safe to show for any failure of `call`. */
export function messageOf(error: unknown): string {
  return error instanceof AppError ? error.message : 'Something went wrong';
}

/** Like `messageOf`, but also shows the app's own errors (link and session messages). */
export function errorText(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (
    error instanceof Error &&
    error.name === 'Error' &&
    !error.message.startsWith('Error invoking')
  ) {
    return error.message;
  }
  return 'Something went wrong';
}
