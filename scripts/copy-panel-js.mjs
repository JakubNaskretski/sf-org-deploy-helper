import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The webview's plain-JS scripts are not compiled by tsc; they ship as-is.
const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['runView.js', 'panel.js']) {
  const src = join(here, '..', 'src', name);
  const dest = join(here, '..', 'out', name);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`copied ${src} -> ${dest}`);
}
