#!/usr/bin/env node
'use strict';
process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env }));
