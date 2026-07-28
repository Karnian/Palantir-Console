#!/usr/bin/env node
// Diagnose the exact environment gates used by resolveActorTokenPolicy before
// run-bound manager/worker capabilities can be minted.
//
// This command checks configuration, not containment. The runtime deliberately
// treats PALANTIR_AGENT_PROCESS_ISOLATION=verified as an operator attestation;
// no repository code can infer a trustworthy per-agent OS/container boundary
// from the Console process alone.
//
// Exit codes:
//   0 — every capabilitiesEnabled gate passes
//   1 — invalid invocation or diagnostic failure
//   2 — one or more capabilitiesEnabled gates fail
//
// Usage:
//   npm run diagnose:isolation
//   node scripts/diagnose-isolation.mjs [--json]

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const supportedArgs = new Set(['--json', '--help', '-h']);
const unknownArgs = argv.filter((arg) => !supportedArgs.has(arg));
const jsonOut = hasFlag('--json');

function printHelp() {
  process.stdout.write(`\
Usage: diagnose-isolation [options]

Reports whether the current policy inputs enable run-bound agent capabilities.

Options:
  --json                  Emit machine-readable JSON, no colors
  -h, --help              Show this help

Exit codes:
  0  all runtime gates pass
  1  invalid invocation or diagnostic failure
  2  one or more runtime gates fail
`);
}

function writeFatal(message) {
  if (jsonOut) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      error: message,
    }, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 1;
}

if (unknownArgs.length > 0) {
  writeFatal(`unknown option${unknownArgs.length === 1 ? '' : 's'}: ${unknownArgs.join(', ')}`);
} else if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
} else {
  try {
    const { diagnoseIsolation } = require(
      path.join(repoRoot, 'server/services/isolationDiagnostic.js'),
    );
    const result = diagnoseIsolation(process.env);

    if (jsonOut) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const lines = [];
      lines.push(`Agent capability isolation: ${result.capabilitiesEnabled ? 'READY' : 'NOT READY'}`);
      lines.push('');
      lines.push('Runtime gates');
      for (const check of result.checks) {
        lines.push(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
        lines.push(`       required: ${check.required}`);
        lines.push(`       actual:   ${check.actual}`);
        if (check.remediation) lines.push(`       fix:      ${check.remediation}`);
      }
      lines.push('');
      lines.push(`Policy boundary: ${result.boundary}`);
      lines.push('');
      lines.push('Advisories');
      for (const advisory of result.advisories) {
        lines.push(`  ${advisory.level.toUpperCase()} ${advisory.id}: ${advisory.message}`);
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }

    // 3, not 2: "cannot tell from here" is not "not ready". A CI gate that
    // treats the recommended file-based deployment as a failure would push
    // operators away from it.
    if (result.indeterminate) process.exitCode = 3;
    else if (!result.capabilitiesEnabled) process.exitCode = 2;
  } catch (err) {
    writeFatal(err && err.message ? err.message : String(err));
  }
}
