import test from 'node:test';
import assert from 'node:assert/strict';
import { burnRate, extractWindows, recordSamples } from '../src/usage.mjs';

const minute = 60_000;

function quota(usedPercent, changes = {}) {
  return { key: '["codex","primary"]', label: 'Codex · 5h', usedPercent, resetsAtMs: null, windowDurationMs: 300 * minute, ...changes };
}

test('map pools replace the duplicate default and durations, not slots, label quotas', () => {
  const weekly = { limitId: 'codex', primary: { usedPercent: 116, windowDurationMins: 10080 }, secondary: null };
  const windows = extractWindows({
    rateLimits: weekly,
    rateLimitsByLimitId: {
      codex: weekly,
      spark: {
        limitName: 'Spark',
        primary: { usedPercent: 4, windowDurationMins: 300 },
        secondary: { usedPercent: 7, windowDurationMins: 10080 }
      }
    }
  });
  assert.deepEqual(windows.map(window => [window.key, window.label]), [
    ['["codex","primary"]', 'Codex · 7d'],
    ['["spark","primary"]', 'Spark · 5h'],
    ['["spark","secondary"]', 'Spark · 7d']
  ]);
  assert.equal(windows[0].usedPercent, 116);
  assert.equal(windows[0].windowDurationMs, 7 * 24 * 60 * minute);
});

test('quota card order is independent of backend map insertion order', () => {
  const snapshot = { primary: { usedPercent: 10 } };
  const forward = { rateLimitsByLimitId: { codex: snapshot, spark: snapshot } };
  const reverse = { rateLimitsByLimitId: { spark: snapshot, codex: snapshot } };
  assert.deepEqual(extractWindows(forward), extractWindows(reverse));
});

test('legacy and empty-map fallback preserve unknown metadata and absent quotas', () => {
  const data = { rateLimits: { primary: { usedPercent: 0 } } };
  const [window] = extractWindows(data);
  assert.equal(window.label, 'Codex · primary');
  assert.equal(window.windowDurationMs, null);
  assert.equal(window.resetsAtMs, null);
  assert.deepEqual(extractWindows({ ...data, rateLimitsByLimitId: {} }), [window]);
  assert.deepEqual(extractWindows({ rateLimits: { primary: null, secondary: null } }), []);
});

test('malformed supplied quota fields fail instead of fabricating zero usage', () => {
  for (const result of [
    {},
    { rateLimits: [] },
    { rateLimitsByLimitId: [] },
    { rateLimitsByLimitId: { codex: null } },
    { rateLimits: { primary: {} } },
    { rateLimits: { primary: { usedPercent: '10' } } },
    { rateLimits: { primary: { usedPercent: -1 } } },
    { rateLimits: { primary: { usedPercent: NaN } } },
    { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 0 } } },
    { rateLimits: { primary: { usedPercent: 10, resetsAt: -1 } } },
    { rateLimits: { primary: { usedPercent: 10, resetsAt: Infinity } } }
  ]) assert.throws(() => extractWindows(result), TypeError);
});

test('rollover, duration changes, manual resets and backwards clocks start new measurement series', () => {
  const history = {};
  const key = quota(0).key;
  recordSamples(history, [quota(10, { resetsAtMs: 20 * minute })], minute);
  recordSamples(history, [quota(12, { resetsAtMs: 20 * minute })], 3 * minute);
  assert.equal(burnRate(history[key].samples, 3 * minute), 60);
  recordSamples(history, [quota(12, { resetsAtMs: 40 * minute })], 4 * minute);
  assert.equal(burnRate(history[key].samples, 4 * minute), null);
  recordSamples(history, [quota(14, { resetsAtMs: 40 * minute })], 6 * minute);
  recordSamples(history, [quota(5, { resetsAtMs: 40 * minute })], 7 * minute);
  assert.deepEqual(history[key].samples, [[7 * minute, 5]]);
  recordSamples(history, [quota(8, { resetsAtMs: 40 * minute })], 9 * minute);
  recordSamples(history, [quota(9, { resetsAtMs: 40 * minute })], 8 * minute);
  assert.deepEqual(history[key].samples, [[8 * minute, 9]]);
  recordSamples(history, [quota(11, { resetsAtMs: 40 * minute })], 10 * minute);
  recordSamples(history, [quota(12, { resetsAtMs: 40 * minute, windowDurationMs: 60 * minute })], 11 * minute);
  assert.equal(burnRate(history[key].samples, 11 * minute), null);
});

test('expired and removed quotas are discarded, samples are bounded, and prototype keys are ordinary data', () => {
  const history = {};
  const key = '__proto__';
  for (let time = 0; time <= 1000; time++) recordSamples(history, [quota(time, { key })], time);
  assert.equal(Object.getPrototypeOf(history), Object.prototype);
  assert.equal(Object.hasOwn(history, key), true);
  assert.equal(history[key].samples.length, 1000);
  assert.deepEqual(history[key].samples[0], [1, 1]);
  recordSamples(history, [quota(10, { resetsAtMs: 1000 })], 1000);
  assert.deepEqual(Object.keys(history), []);
});

test('burn rate measures only the selected trailing interval without bridging an idle gap', () => {
  const now = 60 * minute;
  assert.equal(burnRate([[0, 0], [minute, 20], [now, 25]], now), null);
  assert.equal(burnRate([[0, 0], [minute, 20]], now), null);
  assert.equal(burnRate([[29 * minute, 0], [58 * minute, 30], [now, 32]], now), 60);
  assert.equal(burnRate([[57 * minute, 30], [59 * minute, 32]], now), 60);
  assert.equal(burnRate([[58 * minute, 30], [now, 32]], now, 1), null);
  assert.equal(burnRate([[now - 89_999, 0], [now, 1]], now), null);
  assert.equal(burnRate([[now - 90_000, 0], [now, 1]], now), 40);
  assert.equal(burnRate([[now - 90_000, 12], [now, 12]], now), 0);
});

test('burn rate rejects invalid, decreasing, out-of-order and future measurements', () => {
  const now = 2 * minute;
  for (const samples of [
    [[0, 20], [now, 10]],
    [[0, 0], [now, NaN]],
    [[now, 0], [0, 10]],
    [[0, 0], [0, 10]],
    [[0, 0], [now + 1, 10]],
    [[0, 0], [now, '10']]
  ]) assert.equal(burnRate(samples, now), null);
});
