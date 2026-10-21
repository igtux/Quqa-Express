/**
 * One terminal tab: the Jarvis-style header (name, status, controls) and one
 * or two panes. Pane headers show only in split view; keys, bell and scroll
 * follow the active pane. Closing a pane returns to single view.
 *
 * Ported from Jarvis NG (apps/web/src/terminal/TerminalModal.tsx: header
 * controls, split view, pane headers, Live button), same owner.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from 'react';
import type { ConnState, TerminalSession } from '../terminal/connection.js';
import type { Tab, Workspace } from '../terminal/workspace.js';
import { ClipboardDialog } from './ClipboardDialog.js';
import { CredentialDialog } from './CredentialDialog.js';
import { ForwardDialog } from './Forwards.js';
import { HostKeyChangedScreen } from './HostKeyChanged.js';
import { HostKeyDialog } from './HostKeyDialog.js';
import { Icon, type IconName } from './icons.js';
import { PasteDialog } from './PasteDialog.js';

export const STATUS_CLASS: Record<ConnState, string> = {
  connecting: 'connecting',
  'host-key': 'connecting',
  connected: 'connected',
  reconnecting: 'connecting',
  disconnected: 'disconnected',
  denied: 'disconnected',
  ended: 'disconnected',
};

function useSnapshot(session: TerminalSession) {
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

function HeaderButton({
  icon,
  label,
  onClick,
  pressed,
  danger,
  className,
  filled,
  text,
}: {
  icon: IconName;
  label: string;
  onClick(): void;
  pressed?: boolean;
  danger?: boolean;
  className?: string;
  filled?: boolean;
  text?: string;
}) {
  return (
    <button
      type="button"
      className={`terminal-action-btn${danger ? ' danger' : ''}${pressed ? ' on' : ''}${className ? ` ${className}` : ''}`}
      title={label}
      aria-label={label}
      {...(pressed !== undefined && { 'aria-pressed': pressed })}
      onClick={onClick}
    >
      <Icon name={icon} filled={filled ?? false} />
      {text && <span className="btn-text">{text}</span>}
    </button>
  );
}

export function TerminalView({
  tab,
  workspace,
  visible,
}: {
  tab: Tab;
  workspace: Workspace;
  visible: boolean;
}) {
  const [searching, setSearching] = useState(false);
  const activeTag = tab.panes[tab.active] ?? tab.panes[0] ?? '';
  const session = workspace.terms.get(activeTag);
  // Ctrl+Shift+F from the app's shortcut handler.
  useEffect(() => {
    const onSearch = () => {
      if (visible) setSearching(true);
    };
    window.addEventListener('quqa:search', onSearch);
    return () => window.removeEventListener('quqa:search', onSearch);
  }, [visible]);
  if (!session) return null;
  const split = tab.panes.length === 2 && tab.split !== 'none';

  return (
    <div className="terminal-window" hidden={!visible} data-testid="terminal-tab">
      <Header
        session={session}
        workspace={workspace}
        tab={tab}
        onSearch={() => setSearching((open) => !open)}
        searching={searching}
      />
      <div
        className={`terminal-body${split ? ` split-view split-${tab.split}` : ''}`}
        data-testid="terminal-body"
      >
        {tab.panes.map((tag, index) => {
          const pane = workspace.terms.get(tag);
          if (!pane) return null;
          return (
            <Pane
              key={tag}
              session={pane}
              workspace={workspace}
              active={index === tab.active}
              split={split}
              visible={visible}
              searching={searching && index === tab.active}
              onCloseSearch={() => {
                setSearching(false);
                pane.clearSearch();
                pane.focus();
              }}
              onActivate={() => workspace.setActivePane(tab.id, index)}
              onClose={() => workspace.closeTerm(tag)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Header({
  session,
  workspace,
  tab,
  onSearch,
  searching,
}: {
  session: TerminalSession;
  workspace: Workspace;
  tab: Tab;
  onSearch(): void;
  searching: boolean;
}) {
  const snapshot = useSnapshot(session);
  const [, rerender] = useState(0);
  const [forwarding, setForwarding] = useState(false);
  const name = workspace.nameOf(session);
  const hostName = workspace.hostNameOf(session);
  const idle =
    snapshot.state === 'disconnected' || snapshot.state === 'denied' || snapshot.state === 'ended';
  const favorite = workspace.activeIsFavorite();
  const split = tab.panes.length === 2;

  return (
    <div className="terminal-header">
      <div className="terminal-title">
        <Icon name="terminal" className="terminal-icon" />
        <span
          className="terminal-host-name"
          title={name === hostName ? name : `${name} — ${hostName}`}
        >
          {name}
        </span>
        <span
          className={`terminal-status ${STATUS_CLASS[snapshot.state]}`}
          title={snapshot.reason || undefined}
          data-testid="terminal-status"
        >
          {snapshot.statusText}
        </span>
        {snapshot.tmux && (
          <span
            className="terminal-badge"
            title="Resumable session (tmux): closing keeps it running"
          >
            tmux
          </span>
        )}
        {snapshot.busy && <span className="terminal-badge busy">working…</span>}
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
          <HeaderButton
            icon="refresh"
            label="Reconnect"
            text="Reconnect"
            onClick={() => session.reconnectNow()}
          />
        )}
        <HeaderButton
          icon="star"
          label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          pressed={favorite}
          filled={favorite}
          className="fav"
          onClick={() => workspace.toggleActiveFavorite()}
        />
        <HeaderButton
          icon={session.bellOn ? 'bell' : 'bellOff'}
          label={
            session.bellOn
              ? 'Bell and notifications on (click to mute)'
              : 'Muted (click for bell and notifications)'
          }
          pressed={session.bellOn}
          className="optional-2"
          onClick={() => {
            session.setBell(!session.bellOn);
            rerender((n) => n + 1);
          }}
        />
        {snapshot.tmux && (
          <HeaderButton
            icon="history"
            label={
              snapshot.historyMode
                ? 'Scroll mode: terminal history (tmux); click for auto'
                : 'Scroll mode: auto; click to scroll the tmux history'
            }
            pressed={snapshot.historyMode}
            className="optional-2"
            onClick={() => session.setHistoryMode(!snapshot.historyMode)}
          />
        )}
        <HeaderButton
          icon="folder"
          label="Files on this host (SFTP)"
          onClick={() => workspace.openFilesForTerminal(session.tag)}
        />
        <HeaderButton
          icon="tunnel"
          label="Port forwarding over this connection"
          className="optional-1"
          onClick={() => setForwarding(true)}
        />
        <HeaderButton
          icon="search"
          label="Search the scrollback (Ctrl+Shift+F)"
          pressed={searching}
          onClick={onSearch}
        />
        <HeaderButton
          icon="splitH"
          label={split ? 'Side by side' : 'Split side by side (Ctrl+Shift+D)'}
          pressed={split && tab.split === 'h'}
          className="optional-1"
          onClick={() => (split ? workspace.setSplit(tab.id, 'h') : workspace.duplicateActive('h'))}
        />
        <HeaderButton
          icon="splitV"
          label={split ? 'One above the other' : 'Split one above the other (Ctrl+Shift+E)'}
          pressed={split && tab.split === 'v'}
          className="optional-1"
          onClick={() => (split ? workspace.setSplit(tab.id, 'v') : workspace.duplicateActive('v'))}
        />
        <HeaderButton
          icon="plus"
          label="New terminal to the same host (Ctrl+Shift+T)"
          onClick={() => workspace.duplicateActive()}
        />
        <HeaderButton
          icon="minus"
          label="Smaller text (Ctrl+-)"
          className="optional-3 zoom"
          text="A"
          onClick={() => workspace.zoom(-1)}
        />
        <HeaderButton
          icon="plus"
          label="Larger text (Ctrl+=)"
          className="optional-3 zoom"
          text="A"
          onClick={() => workspace.zoom(1)}
        />
        <HeaderButton
          icon="maximize"
          label="Full screen (F11)"
          className="optional-3"
          onClick={() => window.quqa.toggleFullScreen()}
        />
        <HeaderButton
          icon="close"
          label={split ? 'Close the tab (both panes)' : idle ? 'Close' : 'Disconnect and close'}
          danger
          text={idle ? 'Close' : 'Disconnect'}
          onClick={() => workspace.closeTab(tab.id)}
        />
      </div>
      {forwarding && (
        <ForwardDialog
          workspace={workspace}
          target={{ kind: 'terminal', tag: session.tag }}
          title={name}
          onClose={() => setForwarding(false)}
        />
      )}
    </div>
  );
}

function Pane({
  session,
  workspace,
  active,
  split,
  visible,
  searching,
  onCloseSearch,
  onActivate,
  onClose,
}: {
  session: TerminalSession;
  workspace: Workspace;
  active: boolean;
  split: boolean;
  visible: boolean;
  searching: boolean;
  onCloseSearch(): void;
  onActivate(): void;
  onClose(): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const snapshot = useSnapshot(session);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const filesDragged = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;
    session.mount(parent);
    // Connects once, after the terminal has its size.
    void session.connect();
  }, [session]);

  useEffect(() => {
    if (visible) session.scheduleFit(30);
    if (visible && active) {
      const timer = setTimeout(() => session.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [session, visible, active, split]);

  const idle =
    snapshot.state === 'disconnected' || snapshot.state === 'denied' || snapshot.state === 'ended';
  const dot = STATUS_CLASS[snapshot.state];

  return (
    <div
      className={`terminal-pane${active ? ' active-pane' : ''}`}
      data-state={snapshot.state}
      data-renderer={snapshot.renderer}
      data-testid="terminal-pane"
      onMouseDown={onActivate}
      onFocusCapture={onActivate}
      // Files dropped on a terminal upload to its folder (Jarvis 01b §8.3).
      onDragEnter={(event) => {
        if (!filesDragged(event)) return;
        event.preventDefault();
        dragDepth.current++;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!filesDragged(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(event) => {
        if (!filesDragged(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        onActivate();
        void workspace.uploadDropped(session, [...event.dataTransfer.files]);
      }}
    >
      <div className="terminal-pane-header">
        <span className="terminal-pane-title">
          <span className={`status-dot ${dot}`} />
          {workspace.nameOf(session)}
          {snapshot.tmux && <span className="terminal-badge small">tmux</span>}
        </span>
        <button
          type="button"
          className="terminal-pane-close"
          title="Close this pane"
          aria-label="Close this pane"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="terminal-container">
        <div ref={container} style={{ display: 'contents' }} />
        {searching && <SearchBar session={session} onClose={onCloseSearch} />}
        {snapshot.scrolledBack && !idle && (
          <button
            type="button"
            className={`terminal-live-btn${snapshot.historyUnread ? ' unread' : ''}`}
            onClick={() => session.goLive()}
            title="Back to the newest output"
          >
            <Icon name="arrowDown" /> Live{snapshot.historyUnread ? ' · new output' : ''}
          </button>
        )}
        {dropping && (
          <div className="terminal-drop-overlay" data-testid="drop-overlay">
            <Icon name="upload" />
            <span>
              Drop to upload to {workspace.folderOf(session) ?? 'the host’s upload folder'}
            </span>
          </div>
        )}
        {snapshot.notice && (
          <div className="terminal-notice" role="status">
            <span>{snapshot.notice}</span>
          </div>
        )}
        {idle && snapshot.reason && (
          <div
            className={`terminal-notice ${snapshot.state === 'ended' ? '' : 'error'}`}
            role="status"
          >
            <span>{snapshot.reason}</span>
            <button
              type="button"
              className="system-btn small"
              onClick={() => session.reconnectNow()}
            >
              {snapshot.state === 'ended' ? 'Start again' : 'Reconnect'}
            </button>
          </div>
        )}
        {visible && snapshot.hostKeyChanged && (
          <HostKeyChangedScreen
            key={snapshot.hostKeyChanged.requestId}
            change={snapshot.hostKeyChanged}
            onReplace={() => session.replaceHostKey()}
            onClose={onClose}
          />
        )}
      </div>
      {visible && snapshot.prompt && (
        <CredentialDialog
          key={snapshot.prompt.requestId}
          prompt={snapshot.prompt}
          onAnswer={(answers, remember) => session.answerPrompt(answers, remember)}
        />
      )}
      {visible && snapshot.pasteRequest && (
        <PasteDialog
          request={snapshot.pasteRequest}
          onAnswer={(allow) => session.answerPaste(allow)}
        />
      )}
      {visible && snapshot.hostKey && (
        <HostKeyDialog
          key={snapshot.hostKey.requestId}
          prompt={snapshot.hostKey}
          onAnswer={(accept) => session.answerHostKey(accept)}
        />
      )}
      {visible && snapshot.clipboardRequest !== null && (
        <ClipboardDialog
          text={snapshot.clipboardRequest}
          canRemember={session.hostId !== null}
          onAnswer={(allow, remember) => session.answerClipboard(allow, remember)}
        />
      )}
    </div>
  );
}

/** Scrollback search (xterm search addon): Enter next, Shift+Enter previous, Esc closes. */
function SearchBar({ session, onClose }: { session: TerminalSession; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [missing, setMissing] = useState(false);
  return (
    <div className="terminal-search" role="search">
      <input
        autoFocus
        value={query}
        aria-label="Search the scrollback"
        placeholder="Search the scrollback"
        className={missing ? 'missing' : ''}
        onChange={(event) => {
          setQuery(event.target.value);
          setMissing(event.target.value !== '' && !session.find(event.target.value));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            setMissing(query !== '' && !session.find(query, event.shiftKey));
          }
        }}
      />
      <button
        type="button"
        className="icon-btn"
        title="Previous (Shift+Enter)"
        aria-label="Previous match"
        onClick={() => setMissing(query !== '' && !session.find(query, true))}
      >
        <Icon name="chevronDown" className="flip" />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Next (Enter)"
        aria-label="Next match"
        onClick={() => setMissing(query !== '' && !session.find(query))}
      >
        <Icon name="chevronDown" />
      </button>
      <button
        type="button"
        className="icon-btn"
        title="Close (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
