import * as fs from 'node:fs/promises';
import { writeCredentials } from '../src/cli/config-io.js';

/**
 * Test fixture: writes `count` credentials entries for `name` into the
 * credentials store next to `configPath`, pausing briefly between writes.
 *
 * Used by the cross-process concurrency test. Each child process performs
 * its own read-modify-write sequence against the shared
 * `credentials.json`, so only a cross-process lock keeps every writer's
 * entries alive. The optional `startFile` argument makes all writers
 * begin at the same moment: the process polls until the file exists.
 *
 * Usage: tsx fixture-credentials-writer.ts <configPath> <name> <count> [startFile]
 */
const [configPath, name, countArg, startFile] = process.argv.slice(2);
if (!configPath || !name || !countArg) {
  throw new Error('Usage: fixture-credentials-writer.ts <configPath> <name> <count> [startFile]');
}

if (startFile) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fs.access(startFile);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for start file: ${startFile}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

const count = Number(countArg);
for (let index = 0; index < count; index += 1) {
  await writeCredentials(configPath, name, {
    tokens: { access_token: `${name}-${index}`, token_type: 'Bearer' },
    authRequirement: 'oauth',
    checkedAt: new Date().toISOString(),
  });
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
}
