/**
 * Port forwarding: the fields of one forward (local -L, remote -R, dynamic
 * SOCKS5 -D), the dialog that starts one on a terminal's connection, and the
 * Tunnels screen with every running forward (bytes, connections, Stop) and
 * the hosts' saved forwards (Start).
 *
 * Listening on anything but loopback lets other computers use the tunnel, so
 * it needs an explicit, warned opt-in (`allowPublic`); the engine refuses it
 * otherwise.
 */
import { useState, useSyncExternalStore } from 'react';
import type { ForwardInfo, ForwardSpec, HostInfo, SavedForward } from '../../../shared/ipc.js';
import { HOST_PATTERN } from '../../../shared/ipc.js';
import { errorText, messageOf } from '../api.js';
import { formatBytes } from '../terminal/notices.js';
import type { FilesTarget, Workspace } from '../terminal/workspace.js';
import { Dialog } from './Dialog.js';
import { Icon } from './icons.js';

const HOST_RE = new RegExp(HOST_PATTERN);

export const EMPTY_FORWARD: ForwardSpec = {
  kind: 'local',
  bindAddress: '127.0.0.1',
  bindPort: 8080,
  destHost: 'localhost',
  destPort: 80,
  allowPublic: false,
};

export function isLoopback(address: string): boolean {
  const plain = address.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return plain === 'localhost' || plain === '::1' || /^127(\.\d{1,3}){3}$/.test(plain);
}

/** `L 127.0.0.1:8080 → db:5432`, `D 127.0.0.1:1080 (SOCKS)`, `R server:9000 → localhost:3000`. */
export function describeForward(
  f: Pick<ForwardSpec, 'kind' | 'bindAddress' | 'bindPort' | 'destHost' | 'destPort'>,
): string {
  const bind = `${f.bindAddress}:${f.bindPort}`;
  if (f.kind === 'dynamic') return `SOCKS ${bind}`;
  const dest = `${f.destHost}:${f.destPort}`;
  return f.kind === 'local' ? `${bind} → ${dest}` : `server ${bind} → ${dest}`;
}

const KIND_LETTER = { local: 'L', remote: 'R', dynamic: 'D' } as const;

/** Problems with a forward the user typed, or null. */
export function validateForward(spec: ForwardSpec): string | null {
  if (!spec.bindAddress || !HOST_RE.test(spec.bindAddress)) return 'Enter the address to listen on';
  if (!(spec.bindPort >= 1 && spec.bindPort <= 65535)) return 'The listening port must be 1–65535';
  if (spec.kind !== 'dynamic') {
    if (!spec.destHost || !HOST_RE.test(spec.destHost)) return 'Enter the destination address';
    if (!(spec.destPort >= 1 && spec.destPort <= 65535))
      return 'The destination port must be 1–65535';
  }
  if (!isLoopback(spec.bindAddress) && !spec.allowPublic) {
    return 'Confirm that other computers may use this tunnel, or listen on 127.0.0.1';
  }
  return null;
}

/** Normalises what the fields hold into a spec the engine accepts. */
export function cleanForward(spec: ForwardSpec): ForwardSpec {
  const dynamic = spec.kind === 'dynamic';
  return {
    ...spec,
    bindAddress: spec.bindAddress.trim(),
    destHost: dynamic ? '' : spec.destHost.trim(),
    destPort: dynamic ? 0 : spec.destPort,
    allowPublic: !isLoopback(spec.bindAddress.trim()) && spec.allowPublic,
  };
}

export function ForwardFields({
  spec,
  onChange,
  idPrefix,
}: {
  spec: ForwardSpec;
  onChange(spec: ForwardSpec): void;
  idPrefix: string;
}) {
  const set = (change: Partial<ForwardSpec>) => onChange({ ...spec, ...change });
  const port = (text: string) => Number(text.replace(/\D/g, '').slice(0, 5) || '0');
  const local = spec.kind !== 'remote';
  const publicBind = !isLoopback(spec.bindAddress);
  return (
    <div className="forward-fields">
      <div className="segmented" role="group" aria-label="Forward type">
        {(['local', 'remote', 'dynamic'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={spec.kind === kind}
            onClick={() =>
              set({
                kind,
                ...(kind === 'dynamic' && {
                  destHost: '',
                  destPort: 0,
                  bindPort: spec.bindPort || 1080,
                }),
                ...(kind !== 'dynamic' &&
                  spec.kind === 'dynamic' && { destHost: 'localhost', destPort: 80 }),
              })
            }
          >
            {kind === 'local' ? 'Local (-L)' : kind === 'remote' ? 'Remote (-R)' : 'SOCKS (-D)'}
          </button>
        ))}
      </div>
      <p className="system-hint">
        {spec.kind === 'local'
          ? 'A port on this computer reaches an address as the server sees it.'
          : spec.kind === 'remote'
            ? 'A port on the server reaches an address as this computer sees it.'
            : 'A SOCKS5 proxy on this computer; connections leave from the server.'}
      </p>
      <div className="forward-row">
        <div className="system-form-group">
          <label htmlFor={`${idPrefix}-bind`}>
            {local ? 'Listen on (here)' : 'Listen on (server)'}
          </label>
          <input
            id={`${idPrefix}-bind`}
            className="system-input"
            value={spec.bindAddress}
            spellCheck={false}
            onChange={(e) => set({ bindAddress: e.target.value, allowPublic: false })}
          />
        </div>
        <div className="system-form-group port">
          <label htmlFor={`${idPrefix}-bind-port`}>Port</label>
          <input
            id={`${idPrefix}-bind-port`}
            className="system-input"
            inputMode="numeric"
            value={spec.bindPort || ''}
            onChange={(e) => set({ bindPort: port(e.target.value) })}
          />
        </div>
        {spec.kind !== 'dynamic' && (
          <>
            <span className="forward-arrow" aria-hidden>
              →
            </span>
            <div className="system-form-group">
              <label htmlFor={`${idPrefix}-dest`}>
                {local ? 'Destination (from the server)' : 'Destination (from here)'}
              </label>
              <input
                id={`${idPrefix}-dest`}
                className="system-input"
                value={spec.destHost}
                spellCheck={false}
                onChange={(e) => set({ destHost: e.target.value })}
              />
            </div>
            <div className="system-form-group port">
              <label htmlFor={`${idPrefix}-dest-port`}>Port</label>
              <input
                id={`${idPrefix}-dest-port`}
                className="system-input"
                inputMode="numeric"
                value={spec.destPort || ''}
                onChange={(e) => set({ destPort: port(e.target.value) })}
              />
            </div>
          </>
        )}
      </div>
      {publicBind && (
        <label className="system-check warning-check">
          <input
            type="checkbox"
            checked={spec.allowPublic}
            onChange={(e) => set({ allowPublic: e.target.checked })}
          />
          <span>
            <Icon name="warning" /> {spec.bindAddress} is not loopback: other computers that can
            reach it can use this tunnel
            {spec.kind === 'remote' ? ' (and the server must allow it, GatewayPorts)' : ''}. I
            understand.
          </span>
        </label>
      )}
    </div>
  );
}

/** Starts an ad-hoc forward over a terminal's (or link's) connection. */
export function ForwardDialog({
  workspace,
  target,
  title,
  onClose,
}: {
  workspace: Workspace;
  target: FilesTarget;
  title: string;
  onClose(): void;
}) {
  const [spec, setSpec] = useState<ForwardSpec>(EMPTY_FORWARD);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`Port forward — ${title}`}
      onClose={onClose}
      submitLabel="Start"
      busy={busy}
      wide
      onSubmit={() => {
        const clean = cleanForward(spec);
        const invalid = validateForward(clean);
        if (invalid) return setProblem(invalid);
        setBusy(true);
        workspace.startForward(target, clean).then(
          (started) => {
            workspace.notices.notice('Tunnel started', 'success', {
              detail: describeForward(started),
            });
            onClose();
          },
          (error: unknown) => {
            setBusy(false);
            setProblem(errorText(error));
          },
        );
      }}
    >
      <ForwardFields spec={spec} onChange={setSpec} idPrefix="fd" />
      <p className="system-hint">
        It runs while this connection is open and reopens when it reconnects. Save forwards you use
        often in the host&apos;s settings.
      </p>
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

/** The Tunnels screen: running forwards and the hosts' saved ones. */
export function ForwardsPanel({ workspace, hosts }: { workspace: Workspace; hosts: HostInfo[] }) {
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const [problem, setProblem] = useState<string | null>(null);
  const running = workspace.allForwards();
  const saved = hosts.flatMap((host) => host.forwards.map((forward) => ({ host, forward })));
  const isRunning = (host: HostInfo, forward: SavedForward) =>
    running.some((r) => r.hostId === host.id && r.savedId === forward.id && r.state !== 'failed');

  const stop = (forward: ForwardInfo) =>
    void workspace.stopForward(forward).catch((error: unknown) => setProblem(messageOf(error)));
  const start = (host: HostInfo, forward: SavedForward) => {
    setProblem(null);
    workspace
      .startSavedForward(host.id, forward)
      .catch((error: unknown) =>
        setProblem(`${forward.label || describeForward(forward)}: ${errorText(error)}`),
      );
  };

  return (
    <section className="panel forwards-panel" aria-label="Tunnels">
      <h3 className="panel-title">Running tunnels</h3>
      {running.length === 0 ? (
        <p className="panel-empty">
          No tunnels are running. Start one from a terminal&apos;s <Icon name="tunnel" /> button, or
          below from a host&apos;s saved forwards.
        </p>
      ) : (
        <ul className="item-list" aria-label="Running tunnels">
          {running.map((forward) => (
            <li key={forward.id} className="item forward-item" data-testid="forward-row">
              <span className={`forward-kind ${forward.kind}`}>{KIND_LETTER[forward.kind]}</span>
              <div className="item-main">
                <span className="item-title">{describeForward(forward)}</span>
                <span className="item-mono">
                  via {workspace.forwardOwner(forward)} ·{' '}
                  <span className={`forward-state ${forward.state}`}>{forward.state}</span>
                  {forward.error && ` · ${forward.error}`} · {forward.connections} open · ↓{' '}
                  {formatBytes(forward.bytesIn)} ↑ {formatBytes(forward.bytesOut)}
                </span>
              </div>
              <button
                type="button"
                className="system-btn ghost small"
                aria-label={`Stop ${describeForward(forward)}`}
                onClick={() => stop(forward)}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="panel-title">Saved with hosts</h3>
      {saved.length === 0 ? (
        <p className="panel-empty">
          No saved forwards. Add them in a host&apos;s settings (Edit → Port forwarding); those
          marked “start automatically” open with the first connection to the host.
        </p>
      ) : (
        <ul className="item-list" aria-label="Saved forwards">
          {saved.map(({ host, forward }) => (
            <li key={`${host.id}/${forward.id}`} className="item forward-item">
              <span className={`forward-kind ${forward.kind}`}>{KIND_LETTER[forward.kind]}</span>
              <div className="item-main">
                <span className="item-title">
                  {forward.label || describeForward(forward)}
                  {forward.auto && <span className="item-badge">auto</span>}
                </span>
                <span className="item-mono">
                  {host.name} · {describeForward(forward)}
                </span>
              </div>
              {isRunning(host, forward) ? (
                <span className="system-hint">running</span>
              ) : (
                <button
                  type="button"
                  className="system-btn small"
                  aria-label={`Start ${forward.label || describeForward(forward)} on ${host.name}`}
                  onClick={() => start(host, forward)}
                >
                  Start
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="system-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
