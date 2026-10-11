#!/usr/bin/env node
'use strict';
// Process inspection is injected by snapshot refresh tests; this binary must never inspect the host.
process.exitCode = 1;
