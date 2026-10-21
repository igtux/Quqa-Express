// Writes SHA256SUMS.txt (sha256sum format) for the installers in
// release/<version>/, or in the folder given as the first argument.
//   node scripts/checksums.mjs [folder]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const folder = process.argv[2] ?? join(root, 'release', version);
const files = readdirSync(folder)
  .filter((name) => name.endsWith('.exe'))
  .sort();
if (files.length === 0) {
  console.error(`No .exe files in ${folder}`);
  process.exit(1);
}
const lines = files.map((name) => {
  const hash = createHash('sha256')
    .update(readFileSync(join(folder, name)))
    .digest('hex');
  return `${hash}  ${name}`;
});
writeFileSync(join(folder, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
