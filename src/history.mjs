import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function historyPath(directory, accountId) {
  if (typeof accountId !== 'string' || !accountId) return null;
  const key = createHash('sha256').update(accountId).digest('hex');
  return path.join(directory, `history-${key}.json`);
}

export async function loadHistory(file) {
  if (!file) return Object.create(null);
  let text;
  try {
    if ((await stat(file)).size > 1024 * 1024) throw new Error('history exceeds 1 MiB');
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw error;
  }
  const data = JSON.parse(text);
  if (data?.version !== 1 || !data.windows || typeof data.windows !== 'object' || Array.isArray(data.windows)) {
    throw new Error('unsupported history format');
  }
  const history = Object.create(null);
  const entries = Object.entries(data.windows);
  if (entries.length > 128) throw new Error('too many history windows');
  for (const [key, value] of entries) {
    const validTime = (n) => n === null || (Number.isFinite(n) && n >= 0);
    if (!value || !validTime(value.resetsAtMs) || !validTime(value.windowDurationMs) ||
        !Array.isArray(value.samples) || value.samples.length > 1000 ||
        !value.samples.every((sample, index, samples) => Array.isArray(sample) && sample.length === 2 &&
          Number.isFinite(sample[0]) && sample[0] >= 0 && Number.isFinite(sample[1]) && sample[1] >= 0 &&
          (index === 0 || sample[0] > samples[index - 1][0]))) {
      throw new Error('invalid history samples');
    }
    history[key] = value;
  }
  return history;
}

export async function writeState(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
