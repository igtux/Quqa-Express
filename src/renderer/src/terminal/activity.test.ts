import { describe, expect, it } from 'vitest';
import { ActivityTracker, BUSY_QUIET_MS, MIN_WORK_MS } from './activity.js';

function tracker() {
  let now = 1_000_000;
  const log: string[] = [];
  const t = new ActivityTracker(
    {
      busy: (busy) => log.push(busy ? 'busy' : 'idle'),
      finished: () => log.push('finished'),
      choice: () => log.push('choice'),
    },
    () => now,
  );
  return { t, log, advance: (ms: number) => (now += ms) };
}

describe('ActivityTracker (agent finished heuristics)', () => {
  it('reports finished after real work and a quiet spell', () => {
    const { t, log, advance } = tracker();
    t.output('✻ Thinking… (esc to interrupt)');
    for (let i = 0; i < 4; i++) {
      advance(1000);
      t.output('✶ Working…');
    }
    advance(BUSY_QUIET_MS - 1);
    t.tick();
    expect(log).toEqual(['busy']);
    advance(2);
    t.tick();
    expect(log).toEqual(['busy', 'idle', 'finished']);
  });

  it('does not count a redraw burst as work', () => {
    const { t, log, advance } = tracker();
    t.output('old ✻ line redrawn');
    advance(MIN_WORK_MS - 1000);
    advance(BUSY_QUIET_MS);
    t.tick();
    expect(log).toEqual(['busy', 'idle']);
  });

  it('sees markers split across chunks and choice prompts', () => {
    const { t, log } = tracker();
    t.output('press esc to inter');
    t.output('rupt');
    expect(log).toEqual(['busy']);
    t.output('Do you want to proceed?\n❯ 1. Yes');
    expect(log).toEqual(['busy', 'choice']);
  });

  it('a dropped connection is not a finish', () => {
    const { t, log, advance } = tracker();
    t.output('✻');
    advance(MIN_WORK_MS + 1);
    t.output('✻');
    t.reset();
    expect(log).toEqual(['busy', 'idle']);
  });
});
