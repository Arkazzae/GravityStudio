import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const sharp = require('sharp');
const app = new URL('../apps/studio/src/app/', import.meta.url);
const output = new URL('../apps/studio/public/favicons/', import.meta.url);
const source = await readFile(new URL('icon.svg', app));
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map(size => sharp(source, { density: 384 }).resize(size, size).png().toBuffer()));

// ICO directory entries point to PNG images, retaining alpha at each native size.
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = size;
  directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(images[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}

await mkdir(output, { recursive: true });
await writeFile(new URL('favicon.ico', app), Buffer.concat([directory, ...images]));
for (const [index, size] of sizes.entries()) {
  if (size <= 32) await writeFile(new URL(`favicon-${size}.png`, output), images[index]);
}
console.log('Generated favicon.ico (16, 32, 48 px) and PNG fallbacks from app/icon.svg.');
