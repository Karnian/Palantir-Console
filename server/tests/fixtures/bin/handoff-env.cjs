#!/usr/bin/env node
'use strict';
require('node:fs').writeFileSync(process.env.HANDOFF_OUTPUT, JSON.stringify({
  cwd: process.cwd(), argv: process.argv.slice(2), env: process.env
}));
