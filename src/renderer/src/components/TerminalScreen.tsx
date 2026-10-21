/** The terminal filling the window, with a slim Jarvis-style header. */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ConnState, TerminalSession } from '../terminal/connection.js';
import { ClipboardDialog } from './ClipboardDialog.js';
import { CredentialDialog } from './CredentialDialog.js';
import { HostKeyChangedScreen } from './HostKeyChanged.js';
import { HostKeyDialog } from './HostKeyDialog.js';
import { Icon } from './icons.js';
import { PasteDialog } from './PasteDialog.js';

const STATUS_CLASS: Record<ConnState, string> = {
  connecting: 'connecting',
  'host-key': 'connecting',
  connected: 'connected',
  reconnecting: 'connecting',
  disconnected: 'disconnected',
  denied: 'disconnected',
  ended: 'disconnected',
};

export function TerminalScreen({
  session,
  onClose,
}: {
  session: TerminalSession;
  onClose(): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;
    session.mount(parent);
    // Connects once, after the terminal has its size.
    void session.connect();
  }, [session]);

  useEffect(() => {
    const onResize = () => session.scheduleFit(50);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [session]);

  const { host, port, username } = session.target;
  const title = `${username}@${host}${port === 22 ? '' : `:${port}`}`;
  const idle =
    snapshot.state === 'disconnected' || snapshot.state === 'denied' || snapshot.state === 'ended';

  return (
    <div className="terminal-window" data-state={snapshot.state} data-renderer={snapshot.renderer}>
      <div className="terminal-header">
        <div className="terminal-title">
          <Icon name="terminal" className="terminal-icon" />
          <span className="terminal-host-name" title={title}>
            {title}
          </span>
          <span
            className={`terminal-status ${STATUS_CLASS[snapshot.state]}`}
            title={snapshot.reason || undefined}
            data-testid="terminal-status"
          >
            {snapshot.statusText}
          </span>
          {snapshot.pendingInput > 0 && (
            <button
              type="button"
              className="terminal-action-btn"
              onClick={() => session.cancelPendingInput()}
            >
              Cancel paste ({snapshot.pendingInput.toLocaleString()})
            </button>
          )}
        </div>
        <div className="terminal-actions">
          {(idle || snapshot.state === 'reconnecting') && (
            <button
              type="button"
              className="terminal-action-btn"
              onClick={() => session.reconnectNow()}
            >
              <Icon name="refresh" /> Reconnect
            </button>
          )}
          <button
            type="button"
            className="terminal-action-btn danger"
            onClick={onClose}
            title="Disconnect and close"
          >
            <Icon name="close" /> {idle ? 'Close' : 'Disconnect'}
          </button>
        </div>
      </div>
      <div className="terminal-body">
        <div ref={container} style={{ display: 'contents' }} />
        {idle && snapshot.reason && (
          <div
            className={`terminal-notice ${snapshot.state === 'ended' ? '' : 'error'}`}
            role="status"
          >
            <span>{snapshot.reason}</span>
          </div>
        )}
      </div>
      {snapshot.hostKeyChanged && (
        <HostKeyChangedScreen
          key={snapshot.hostKeyChanged.requestId}
          change={snapshot.hostKeyChanged}
          onReplace={() => session.replaceHostKey()}
          onClose={onClose}
        />
      )}
      {snapshot.prompt && (
        <CredentialDialog
          key={snapshot.prompt.requestId}
          prompt={snapshot.prompt}
          onAnswer={(answers, remember) => session.answerPrompt(answers, remember)}
        />
      )}
      {snapshot.pasteRequest && (
        <PasteDialog
          request={snapshot.pasteRequest}
          onAnswer={(allow) => session.answerPaste(allow)}
        />
      )}
      {snapshot.hostKey && (
        <HostKeyDialog
          key={snapshot.hostKey.requestId}
          prompt={snapshot.hostKey}
          onAnswer={(accept) => session.answerHostKey(accept)}
        />
      )}
      {snapshot.clipboardRequest !== null && (
        <ClipboardDialog
          text={snapshot.clipboardRequest}
          onAnswer={(allow) => session.answerClipboard(allow)}
        />
      )}
    </div>
  );
}
