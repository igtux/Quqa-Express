// CI helper: turns Vitest's JSON report into one GitHub error annotation that
// lists every failed test (GitHub shows only the first ten per step).
//   node scripts/ci-failures.mjs test-results/vitest.json
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const file = process.argv[2] ?? 'test-results/vitest.json';
if (!existsSync(file)) process.exit(0);
const report = JSON.parse(readFileSync(file, 'utf8'));
const failed = [];
for (const suite of report.testResults ?? []) {
  const where = relative(process.cwd(), suite.name ?? '').replaceAll('\\', '/');
  if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) {
    failed.push(`${where}: ${String(suite.message ?? 'failed to load').split('\n')[0]}`);
  }
  for (const test of suite.assertionResults ?? []) {
    if (test.status !== 'failed') continue;
    const message = String(test.failureMessages?.[0] ?? '')
      .split('\n')[0]
      .slice(0, 300);
    failed.push(`${where} > ${test.fullName}: ${message}`);
  }
}
if (failed.length > 0) {
  const text = `${failed.length} failed test(s):\n${failed.join('\n')}`.slice(0, 60_000);
  const escaped = text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error title=Failed tests::${escaped}`);
}
