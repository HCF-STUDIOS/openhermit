#!/usr/bin/env node
// postpack: restore package.json from the backup written by prepack.
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');
const backupPath = `${pkgPath}.bak`;

if (existsSync(backupPath)) {
  renameSync(backupPath, pkgPath);
  console.log('[channel-whatsapp] restored package.json after publish');
}
