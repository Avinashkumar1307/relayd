#!/usr/bin/env node
/**
 * Fails if any integration test was skipped instead of run.
 *
 * packages/testing/src/containers.ts already throws when Docker is missing
 * under CI, but that is the suite policing itself: if the guard regressed, or
 * a file stopped matching the naming convention, or someone added .skip, the
 * run would go green with nothing having been tested. A skipped integration
 * suite in CI is indistinguishable from a passing one in every signal CI
 * produces, which is precisely why this is checked from outside.
 *
 * Reads the JSON reporter output from vitest.
 */
import { readFileSync } from 'node:fs';

const INTEGRATION_PATTERN = '.integration.test.';
const SKIPPED = new Set(['pending', 'skipped', 'todo']);

const [, , resultsPath] = process.argv;
if (!resultsPath) {
  console.error('usage: assert-integration-ran.mjs <vitest-results.json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(resultsPath, 'utf8'));
} catch (error) {
  console.error(`Could not read vitest results at ${resultsPath}: ${error.message}`);
  process.exit(2);
}

const files = (report.testResults ?? []).filter((file) =>
  (file.name ?? '').includes(INTEGRATION_PATTERN),
);

if (files.length === 0) {
  console.error(
    `No integration test files found in the run (looked for "${INTEGRATION_PATTERN}").`,
  );
  console.error('Either the suite vanished or the naming convention changed.');
  process.exit(1);
}

let ran = 0;
const skipped = [];

for (const file of files) {
  for (const test of file.assertionResults ?? []) {
    if (SKIPPED.has(test.status)) {
      skipped.push(`${file.name.split(/[/\\]/).pop()} > ${test.fullName ?? test.title}`);
    } else {
      ran += 1;
    }
  }
}

console.log(`Integration files: ${files.length}`);
console.log(`Integration tests run: ${ran}`);
console.log(`Integration tests skipped: ${skipped.length}`);

if (skipped.length > 0) {
  console.error('\nIntegration tests were SKIPPED in CI. They must run:');
  for (const name of skipped) console.error(`  - ${name}`);
  console.error('\nIs the Docker daemon available on this runner?');
  process.exit(1);
}

if (ran === 0) {
  console.error('\nIntegration files were collected but contained no tests.');
  process.exit(1);
}

console.log('\nOK: every integration test ran.');
