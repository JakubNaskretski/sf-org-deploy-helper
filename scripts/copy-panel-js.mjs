import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'panel.js');
const dest = join(here, '..', 'out', 'panel.js');
await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied ${src} -> ${dest}`);
