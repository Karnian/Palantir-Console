const fs = require('node:fs');
const path = require('node:path');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const command = process.argv.slice(2).join(' ');
  const writeMatch = command.match(/\bwrite:([^\s]+)/);
  if (writeMatch) {
    const fileName = writeMatch[1].replace(/^\/+/, '');
    fs.writeFileSync(path.join(process.cwd(), fileName), 'fake test artifact\n');
    console.log(`wrote ${fileName}`);
  }

  const sleepMatch = command.match(/\bsleep:(\d+)/);
  if (sleepMatch) {
    await sleep(Number(sleepMatch[1]));
  }

  if (command.includes('dirty-output')) {
    process.stdout.write('\x1b[31mred\x1b[0m\x00 clean\n');
  } else {
    console.log(`fake-test-runner ${command || 'pass'}`);
  }

  if (command.includes('fail')) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
