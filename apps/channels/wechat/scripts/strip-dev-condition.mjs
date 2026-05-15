#!/usr/bin/env node
// prepack: back up package.json and remove the `development` export
// condition so the published tarball only exposes built artifacts.
// Restored by scripts/restore-package-json.mjs in postpack.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');
const backupPath = `${pkgPath}.bak`;

copyFileSync(pkgPath, backupPath);

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const dot = pkg.exports?.['.'];
if (dot && typeof dot === 'object' && 'development' in dot) {
  delete dot.development;
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[channel-wechat] stripped development export condition for publish');
