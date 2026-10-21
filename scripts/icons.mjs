// Renders build/icon.svg into build/icon.png (512 px) and build/icon.ico
// (16–256 px, PNG-compressed entries). Needs rsvg-convert (librsvg).
//   node scripts/icons.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const build = join(import.meta.dirname, '..', 'build');
const svg = join(build, 'icon.svg');
const render = (size) => execFileSync('rsvg-convert', ['-w', `${size}`, '-h', `${size}`, svg]);

writeFileSync(join(build, 'icon.png'), render(512));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(render);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, i) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // no palette
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(images[i].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return entry;
});
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
console.log('build/icon.png, build/icon.ico from', readFileSync(svg).length, 'bytes of SVG');
