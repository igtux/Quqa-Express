// Prints one version's section of CHANGELOG.md (without its heading), for
// the GitHub release body. Fails when the version has no section, so every
// release has notes.
//   node scripts/changelog.mjs 0.1.0-beta.4
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The body of `## [version]` up to the next `## ` heading, or null. */
function changelogSection(text, version) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const heading = (line) => /^## /.test(line);
  const start = lines.findIndex(
    (line) => heading(line) && (line.startsWith(`## [${version}]`) || line === `## ${version}`),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(heading);
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

{
  const version = (process.argv[2] ?? '').replace(/^v/, '');
  const text = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  const section = version ? changelogSection(text, version) : null;
  if (!section) {
    console.error(`CHANGELOG.md has no section for ${version || '(no version given)'}`);
    process.exit(1);
  }
  console.log(section);
}
