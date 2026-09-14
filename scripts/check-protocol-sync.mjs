// Fails when the vendored packages/protocol differs from the FourPoints
// package it copies. FOURPOINTS_REPO defaults to the sibling ../FourPoints.
import console from 'node:console';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fourPoints =
  process.env.FOURPOINTS_REPO ?? join(root, '..', 'FourPoints');
const ours = join(root, 'packages', 'protocol');
const theirs = join(fourPoints, 'packages', 'protocol');

if (!existsSync(theirs)) {
  console.error(
    `FourPoints protocol package not found at ${theirs} (set FOURPOINTS_REPO)`,
  );
  process.exit(2);
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      return [];
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(path, base);
    }
    return entry.name.endsWith('.tsbuildinfo') ? [] : [relative(base, path)];
  });
}

// Line endings are normalised so a CRLF checkout is not reported as drift.
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const names = [...new Set([...listFiles(ours), ...listFiles(theirs)])].sort();
const problems = names.flatMap((name) => {
  const a = join(ours, name);
  const b = join(theirs, name);
  if (!existsSync(a)) return [`missing here: ${name}`];
  if (!existsSync(b)) return [`not in FourPoints: ${name}`];
  return read(a) === read(b) ? [] : [`differs: ${name}`];
});

if (problems.length > 0) {
  console.error(
    `packages/protocol is out of sync with ${theirs}:\n  ${problems.join('\n  ')}`,
  );
  process.exit(1);
}
console.log(`packages/protocol matches FourPoints (${names.length} files)`);
