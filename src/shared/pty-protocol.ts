/**
 * Main ↔ local terminal process (the PTY utilityProcess, ADR 0007). Main
 * turns the renderer's "open shell `pwsh`" intent into a program, its
 * arguments, a folder and an environment; the PTY process checks every
 * command against this schema again before acting on it. Its answers are
 * session events (`ready`, `data`, `error`, `closed`), like the SSH engine's.
 */
import Type, { type Static, type TSchema } from 'typebox';
import { AckMessage, InputMessage, ResizeMessage, SessionId, Cols, Rows } from './ipc.js';

const obj = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });

const FilePath = Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000]+$' });

export const MAX_SHELL_ARGS = 16;

export const PtySpawn = obj({
  type: Type.Literal('spawn'),
  sessionId: SessionId,
  /** Absolute path of the shell program (from main's detected list). */
  file: FilePath,
  args: Type.Array(Type.String({ maxLength: 4096, pattern: '^[^\\u0000]*$' }), {
    maxItems: MAX_SHELL_ARGS,
  }),
  cwd: FilePath,
  env: Type.Record(
    Type.String({ minLength: 1, maxLength: 1024 }),
    Type.String({ maxLength: 32_768 }),
  ),
  cols: Cols,
  rows: Rows,
});
export type PtySpawn = Static<typeof PtySpawn>;

export const PtyCommand = Type.Union([
  PtySpawn,
  obj({ type: Type.Literal('input'), ...InputMessage.properties }),
  obj({ type: Type.Literal('resize'), ...ResizeMessage.properties }),
  obj({ type: Type.Literal('ack'), ...AckMessage.properties }),
  obj({ type: Type.Literal('kill'), sessionId: SessionId }),
  obj({ type: Type.Literal('shutdown') }),
]);
export type PtyCommand = Static<typeof PtyCommand>;
