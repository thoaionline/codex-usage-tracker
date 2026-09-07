const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MIN_RATE_SPAN_MS = 90_000;
const MAX_SAMPLES = 1000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(path, expected) {
  return new TypeError(`Invalid Codex rate-limit response: ${path} must be ${expected}. Update Codex or inspect account/rateLimits/read output.`);
}

function optionalString(value, path) {
  if (value == null) return null;
  if (typeof value !== 'string') throw schemaError(path, 'a string or null');
  return value || null;
}

function optionalMilliseconds(value, multiplier, path, positive) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw schemaError(path, positive ? 'a positive finite number or null' : 'a nonnegative finite number or null');
  }
  const milliseconds = value * multiplier;
  if (!Number.isFinite(milliseconds)) throw schemaError(path, 'a number that can be represented in milliseconds');
  return milliseconds;
}

function durationLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function extractWindows(data) {
  if (!isRecord(data)) throw schemaError('result', 'an object containing rateLimits or rateLimitsByLimitId');
  const hasMap = Object.hasOwn(data, 'rateLimitsByLimitId');
  const hasDefault = Object.hasOwn(data, 'rateLimits');
  if (!hasMap && !hasDefault) throw schemaError('result', 'an object containing rateLimits or rateLimitsByLimitId');

  let snapshots = [];
  if (hasMap && data.rateLimitsByLimitId != null) {
    if (!isRecord(data.rateLimitsByLimitId)) throw schemaError('rateLimitsByLimitId', 'an object or null');
    snapshots = Object.entries(data.rateLimitsByLimitId).map(([id, snapshot]) => ({
      id,
      snapshot,
      path: `rateLimitsByLimitId[${JSON.stringify(id)}]`
    }));
  }
  if (snapshots.length === 0 && hasDefault && data.rateLimits != null) {
    snapshots = [{ id: null, snapshot: data.rateLimits, path: 'rateLimits' }];
  }
  // App-server maps are unordered; keep dashboard cards stable between polls.
  const defaultId = data.rateLimits?.limitId ?? 'codex';
  snapshots.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId)
    || String(a.id).localeCompare(String(b.id)));

  const windows = [];
  for (const { id: mapId, snapshot, path } of snapshots) {
    if (!isRecord(snapshot)) throw schemaError(path, 'a rate-limit snapshot object');
    const suppliedId = optionalString(snapshot.limitId, `${path}.limitId`);
    const id = mapId ?? suppliedId ?? 'codex';
    if (!id) throw schemaError(path, 'a snapshot with a nonempty limit identifier');
    const name = optionalString(snapshot.limitName, `${path}.limitName`)
      ?? (id === 'codex' || id === 'default' ? 'Codex' : id);
    for (const slot of ['primary', 'secondary']) {
      const window = snapshot[slot];
      if (window == null) continue;
      const windowPath = `${path}.${slot}`;
      if (!isRecord(window)) throw schemaError(windowPath, 'a window object or null');
      if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) {
        throw schemaError(`${windowPath}.usedPercent`, 'a nonnegative finite number');
      }
      const windowDurationMs = optionalMilliseconds(window.windowDurationMins, MINUTE_MS, `${windowPath}.windowDurationMins`, true);
      const resetsAtMs = optionalMilliseconds(window.resetsAt, 1000, `${windowPath}.resetsAt`, false);
      windows.push({
        key: JSON.stringify([id, slot]),
        label: `${name} · ${windowDurationMs === null ? slot : durationLabel(window.windowDurationMins)}`,
        usedPercent: window.usedPercent,
        windowDurationMs,
        resetsAtMs
      });
    }
  }
  return windows;
}

function validSamples(samples, nowMs) {
  if (!Array.isArray(samples)) return false;
  let previousTime = -Infinity;
  let previousPercent = -Infinity;
  for (const sample of samples) {
    if (!Array.isArray(sample) || sample.length !== 2) return false;
    const [time, percent] = sample;
    if (!Number.isFinite(time) || time < 0 || time > nowMs || time <= previousTime
      || !Number.isFinite(percent) || percent < 0 || percent < previousPercent) return false;
    previousTime = time;
    previousPercent = percent;
  }
  return true;
}

export function recordSamples(history, windows, nowMs) {
  if (!isRecord(history)) throw new TypeError('Usage history must be an object.');
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new TypeError('Sample time must be a nonnegative finite timestamp.');
  const presentKeys = new Set(windows.map(window => window.key));
  for (const key of Object.keys(history)) {
    if (!presentKeys.has(key)) delete history[key];
  }
  for (const window of windows) {
    const { key, resetsAtMs, windowDurationMs, usedPercent } = window;
    if (resetsAtMs !== null && resetsAtMs <= nowMs) {
      delete history[key];
      continue;
    }
    let entry = Object.hasOwn(history, key) ? history[key] : null;
    if (!isRecord(entry) || entry.resetsAtMs !== resetsAtMs || entry.windowDurationMs !== windowDurationMs
      || !validSamples(entry.samples, nowMs)
      || (entry.samples.length > 0 && entry.samples.at(-1)[1] > usedPercent)) {
      entry = { resetsAtMs, windowDurationMs, samples: [] };
      Object.defineProperty(history, key, { value: entry, enumerable: true, configurable: true, writable: true });
    }
    const samples = entry.samples;
    if (samples.length > 0 && samples.at(-1)[0] === nowMs) samples.at(-1)[1] = usedPercent;
    else samples.push([nowMs, usedPercent]);
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }
  return history;
}

export function burnRate(samples, nowMs, windowMinutes = 30) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(windowMinutes) || windowMinutes <= 0
    || !Number.isFinite(windowMinutes * MINUTE_MS) || !validSamples(samples, nowMs)) return null;
  const cutoff = nowMs - windowMinutes * MINUTE_MS;
  let first = null;
  let last = null;
  for (const sample of samples) {
    if (sample[0] < cutoff) continue;
    first ??= sample;
    last = sample;
  }
  if (first === null || last[0] - first[0] < MIN_RATE_SPAN_MS) return null;
  const rate = (last[1] - first[1]) / (last[0] - first[0]) * HOUR_MS;
  return Number.isFinite(rate) ? rate : null;
}
