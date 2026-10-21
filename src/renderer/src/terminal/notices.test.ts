import { describe, expect, it, vi } from 'vitest';
import type { TransferEvent } from '../../../shared/protocol.js';
import { formatBytes, Notices, transferNotice } from './notices.js';

const transfer = (change: Partial<TransferEvent>): TransferEvent => ({
  id: 'x1',
  sessionId: 's1',
  direction: 'upload',
  name: 'big.iso',
  remotePath: '/home/me/uploads/big.iso',
  bytes: 512 * 1024 * 1024,
  total: 1024 * 1024 * 1024,
  state: 'running',
  error: '',
  ...change,
});

describe('the notice island', () => {
  it('shows transfers with progress and the right buttons', () => {
    const controls = { cancel: vi.fn(), resume: vi.fn() };
    const running = transferNotice(transfer({}), controls);
    expect(running).toMatchObject({
      kind: 'progress',
      text: 'Uploading big.iso',
      progress: 0.5,
      detail: '512 MB of 1.0 GB · to /home/me/uploads',
    });
    running.actions?.[0]?.run();
    expect(controls.cancel).toHaveBeenCalled();
    const paused = transferNotice(
      transfer({ state: 'interrupted', error: 'Connection lost' }),
      controls,
    );
    expect(paused.actions?.map((a) => a.label)).toEqual(['Resume', 'Cancel']);
    expect(transferNotice(transfer({ state: 'done' }), controls)).toMatchObject({
      kind: 'success',
      text: 'Uploaded big.iso',
    });
    expect(transferNotice(transfer({ state: 'failed', error: 'denied' }), controls)).toMatchObject({
      kind: 'error',
      detail: 'denied',
    });
  });

  it('updates one card per transfer and keeps at most four', () => {
    vi.useFakeTimers();
    const notices = new Notices({ cancel: vi.fn(), resume: vi.fn() });
    notices.onTransfer(transfer({}));
    notices.onTransfer(transfer({ bytes: 1024 * 1024 * 1024 - 1 }));
    expect(notices.notices).toHaveLength(1);
    notices.onTransfer(transfer({ state: 'done' }));
    expect(notices.notices[0]?.kind).toBe('success');
    for (let i = 0; i < 6; i++) notices.notice(`n${i}`);
    expect(notices.notices.length).toBeLessThanOrEqual(4);
    vi.advanceTimersByTime(10_000);
    expect(notices.notices.filter((n) => !n.leaving)).toHaveLength(0);
    vi.useRealTimers();
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
  });
});
