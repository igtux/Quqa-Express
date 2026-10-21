/**
 * Main ↔ SSH engine (utilityProcess) messages. Main validates renderer input
 * first; the engine checks every command again before acting on it.
 */
import Type, { type Static } from 'typebox';
import {
  AckMessage,
  ConnectRequest,
  HostKeyAnswer,
  InputMessage,
  ResizeMessage,
  SessionId,
} from './ipc.js';

export const EngineCommand = Type.Union([
  Type.Object(
    { type: Type.Literal('connect'), sessionId: SessionId, request: ConnectRequest },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('input'), ...InputMessage.properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('resize'), ...ResizeMessage.properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('ack'), ...AckMessage.properties },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('disconnect'), sessionId: SessionId },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('reconnect'), sessionId: SessionId },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('host-key-answer'), ...HostKeyAnswer.properties },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal('shutdown') }, { additionalProperties: false }),
]);
export type EngineCommand = Static<typeof EngineCommand>;
