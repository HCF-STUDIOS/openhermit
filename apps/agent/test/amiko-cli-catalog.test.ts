import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AMIKO_CLI_CATALOG,
  getCatalogEntry,
  runAmikoTool,
  searchCatalog,
  toFunctionDeclaration,
} from '../src/tools/amiko-cli-catalog.js';

test('catalog entries have unique names and valid parameter schemas', () => {
  const names = new Set<string>();
  for (const entry of AMIKO_CLI_CATALOG) {
    assert.ok(!names.has(entry.name), `duplicate catalog name: ${entry.name}`);
    names.add(entry.name);
    assert.match(entry.name, /^amiko_[a-z0-9_]+$/);
    assert.equal(entry.parameters.type, 'object');
    assert.ok(entry.description.length > 0);
  }
  // Readonly-leaning: the vast majority of the catalog must be readonly.
  const mutating = AMIKO_CLI_CATALOG.filter((e) => !e.readonly);
  assert.ok(mutating.length <= 2, `too many mutating entries: ${mutating.map((e) => e.name).join(', ')}`);
});

test('searchCatalog finds credits balance for a balance query', () => {
  const results = searchCatalog('what is my credits balance');
  assert.ok(results.length > 0);
  assert.equal(results[0]!.name, 'amiko_credits_balance');
});

test('searchCatalog finds the version tool', () => {
  const results = searchCatalog('cli version');
  assert.ok(results.some((r) => r.name === 'amiko_version'));
});

test('searchCatalog is bounded by limit and returns nothing meaningless for gibberish', () => {
  assert.ok(searchCatalog('wallet chat drive friends', 3).length <= 3);
  assert.equal(searchCatalog('zzqqxx').length, 0);
});

test('argv mapping: required and optional args', () => {
  assert.deepEqual(getCatalogEntry('amiko_credits_balance')!.argv({}), ['credits', 'balance']);
  assert.deepEqual(getCatalogEntry('amiko_version')!.argv({}), ['--version']);
  assert.deepEqual(
    getCatalogEntry('amiko_chat_read')!.argv({ target: '@mars', limit: 5 }),
    ['chat', 'read', '@mars', '--limit', '5'],
  );
  assert.deepEqual(
    getCatalogEntry('amiko_drive_search')!.argv({ query: 'tax report' }),
    ['drive', 'search', 'tax report'],
  );
  assert.deepEqual(
    getCatalogEntry('amiko_wallets_balance')!.argv({ address: 'Gu2b...' }),
    ['wallets', 'balance', 'Gu2b...'],
  );
});

test('toFunctionDeclaration produces the Interactions function shape', () => {
  const decl = toFunctionDeclaration(getCatalogEntry('amiko_users_search')!);
  assert.equal(decl.type, 'function');
  assert.equal(decl.name, 'amiko_users_search');
  assert.deepEqual(decl.parameters.required, ['query']);
});

test('runAmikoTool rejects unknown tools and reports failures without throwing', async () => {
  await assert.rejects(runAmikoTool('amiko_nope', {}), /Unknown Amiko catalog tool/);
  const result = await runAmikoTool('amiko_version', {}, {
    bin: '/nonexistent/amiko-binary',
    timeoutMs: 5_000,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.command, 'amiko --version');
  assert.ok(result.stderr.length > 0);
});
