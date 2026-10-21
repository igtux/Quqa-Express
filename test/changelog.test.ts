import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('CHANGELOG.md', () => {
  it('has notes for the version being released (the release body and the update panel)', () => {
    const notes = execFileSync(process.execPath, ['scripts/changelog.mjs', `v${version}`], {
      encoding: 'utf8',
    });
    expect(notes.trim().length).toBeGreaterThan(20);
    expect(notes).not.toMatch(/^## /m);
    // The update panel cuts the release body at "## Download".
    expect(notes).not.toContain('## Download');
  });

  it('refuses a version without notes', () => {
    const run = spawnSync(process.execPath, ['scripts/changelog.mjs', '99.0.0'], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no section for 99.0.0');
  });
});
