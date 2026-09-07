import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchUsage } from '../src/codex.mjs';

async function server(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-monitor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'codex.mjs');
  const pidFile = join(directory, 'pid');
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const input = createInterface({ input: process.stdin });
setInterval(() => {}, 1000);
${body}
`, { mode: 0o700 });
  return {
    codexBin: executable,
    async assertReaped({ mayNotStart = false } = {}) {
      let pid;
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
      } catch (error) {
        if (mayNotStart && error.code === 'ENOENT') return;
        throw error;
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    },
  };
}

const initializedServer = `
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'account/rateLimits/read') respond(message);
});
`;

test('fragmented responses preserve Unicode and reap a child ignoring SIGTERM', async t => {
  const fixture = await server(t, `
process.on('SIGTERM', () => {});
let initialized = false;
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ method: 'notification', params: { ignored: true } });
    send({ id: 999, result: 'unrelated' });
    send({ id: message.id, result: {} });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'account/rateLimits/read') {
    if (!initialized || Object.hasOwn(message, 'params')) process.exit(7);
    send({ id: 'server-request', method: 'some/request' });
  } else if (message.id === 'server-request' && message.error?.code === -32601) {
    const bytes = Buffer.from(JSON.stringify({ id: 2, result: { accountId: '日本', rateLimits: { primary: { usedPercent: 17 } } } }) + '\\n');
    let offset = 0;
    const interval = setInterval(() => {
      process.stdout.write(bytes.subarray(offset, ++offset));
      if (offset === bytes.length) clearInterval(interval);
    }, 1);
  }
});
`);
  const result = await fetchUsage({ codexBin: fixture.codexBin, timeoutMs: 5000 });
  assert.deepEqual(result, { accountId: '日本', rateLimits: { primary: { usedPercent: 17 } } });
  await fixture.assertReaped();
});

test('unsupported methods produce safe actionable errors and reap the child', async t => {
  const fixture = await server(t, `
function respond(message) {
  process.stderr.write('credential=SECRET_FROM_STDERR');
  send({ id: message.id, error: { code: -32601, message: 'SECRET_FROM_ERROR', data: 'SECRET_FROM_DATA' } });
}
${initializedServer}`);
  await assert.rejects(fetchUsage({ codexBin: fixture.codexBin }), error => {
    assert.match(error.message, /Update Codex/);
    assert.doesNotMatch(error.stack, /SECRET/);
    return true;
  });
  await fixture.assertReaped();
});

test('malformed and oversized protocol lines fail without leaking their contents', async t => {
  for (const output of ['SECRET_INVALID_JSON\n', 'x'.repeat(1024 * 1024 + 1)]) {
    const fixture = await server(t, `process.stdout.write(${JSON.stringify(output)});`);
    await assert.rejects(fetchUsage({ codexBin: fixture.codexBin }), error => {
      assert.match(error.message, /invalid JSON|line limit/);
      assert.doesNotMatch(error.stack, /SECRET/);
      return true;
    });
    await fixture.assertReaped();
  }
});

test('timeout and cancellation release the child', async t => {
  for (const options of [{ timeoutMs: 150 }, { signal: AbortSignal.timeout(300) }]) {
    const fixture = await server(t, '');
    await assert.rejects(fetchUsage({ codexBin: fixture.codexBin, ...options }), error => {
      assert.match(error.message, /Timed out|aborted/);
      return true;
    });
    await fixture.assertReaped({ mayNotStart: true });
  }
});

test('a missing executable fails without exposing its path', async () => {
  await assert.rejects(fetchUsage({ codexBin: '/nonexistent/SECRET_CODEX_PATH' }), error => {
    assert.match(error.message, /executable not found/);
    assert.doesNotMatch(error.stack, /SECRET_CODEX_PATH/);
    return true;
  });
});
