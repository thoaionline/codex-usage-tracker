import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyAuthJson, copyToClipboard } from '../src/clipboard.mjs';
import { render } from '../src/render.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('copies exact auth JSON from the selected home and rereads refreshed credentials', async t => {
  const codexHome = await directory(t);
  for (const json of ['{ "tokens": { "access_token": "SECRET" } }\n', '{"tokens":{"access_token":"NEW"}}']) {
    await writeFile(join(codexHome, 'auth.json'), json);
    let copied;
    await copyAuthJson({ codexHome, writeClipboard: async value => { copied = value; } });
    assert.equal(copied, json);
  }
});

test('missing or invalid auth fails without copying or exposing contents', async t => {
  const codexHome = await directory(t);
  const options = { codexHome, writeClipboard: () => assert.fail('must not copy') };
  await assert.rejects(copyAuthJson(options), /Cannot read auth.json/);
  for (const value of ['SECRET_INVALID_JSON', 'null', '[]']) {
    await writeFile(join(codexHome, 'auth.json'), value);
    await assert.rejects(copyAuthJson(options), error => {
      assert.match(error.message, /valid JSON object/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    });
  }
});

test('clipboard uses stdin and falls back when a desktop utility fails', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'wl-copy'), `#!${process.execPath}\nprocess.stderr.write('SECRET'); process.exit(1);\n`, { mode: 0o700 });
  await writeFile(join(dir, 'xclip'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nlet input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => writeFileSync(process.env.COPY_RESULT, JSON.stringify({ input, args: process.argv.slice(2) })));\n`, { mode: 0o700 });
  const result = join(dir, 'result');
  const env = { ...process.env, WSL_DISTRO_NAME: '', WSL_INTEROP: '', PATH: dir, WAYLAND_DISPLAY: 'test', DISPLAY: ':0', COPY_RESULT: result };
  await copyToClipboard('{"secret":"日本"}', { platform: 'linux', release: '', env });
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), {
    input: '{"secret":"日本"}', args: ['-selection', 'clipboard'],
  });
  await assert.rejects(copyToClipboard('SECRET', { platform: 'linux', release: '', env: { ...env, DISPLAY: '' } }), error => {
    assert.match(error.message, /Clipboard unavailable/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
});

test('WSL copies Unicode to Windows without a Linux display server', async t => {
  const dir = await directory(t);
  const result = join(dir, 'result');
  await writeFile(join(dir, 'clip.exe'), `#!${process.execPath}\nconst { writeFileSync } = require('node:fs');\nconst chunks = []; process.stdin.on('data', chunk => chunks.push(chunk)); process.stdin.on('end', () => writeFileSync(process.env.COPY_RESULT, Buffer.concat(chunks)));\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: dir, WSL_DISTRO_NAME: '', WSL_INTEROP: '', WAYLAND_DISPLAY: '', DISPLAY: '', COPY_RESULT: result };
  const json = '{"token":"日本🔑"}';
  for (const detection of [
    { env: { ...env, WSL_DISTRO_NAME: 'Ubuntu' }, release: '' },
    { env: { ...env, WSL_INTEROP: '/run/WSL/1_interop' }, release: '' },
    { env, release: '5.15.0-microsoft-standard-WSL2' },
  ]) {
    await copyToClipboard(json, { platform: 'linux', ...detection });
    assert.deepEqual(await readFile(result), Buffer.from(`\ufeff${json}`, 'utf16le'));
  }
});

test('compact dashboard preserves copy feedback and shortcut', () => {
  const output = render({ windows: null, clipboard: 'CODEX_AUTH_JSON copied to clipboard.' }, {
    live: true, columns: 80, rows: 5, interval: 60,
  });
  assert.match(output, /CODEX_AUTH_JSON copied/);
  assert.match(output, /c copy auth/);
});
