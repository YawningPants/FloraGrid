import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? modules(path) : entry.name.endsWith('.mjs') ? [path] : [];
    }),
  );
  return groups.flat();
}
const files = (await Promise.all(['src', 'tests', 'tools'].map((name) => modules(join(root, name))))).flat();
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(result.status || 1);
  }
}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
