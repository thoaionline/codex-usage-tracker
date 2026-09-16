#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetchUsage } from '../src/codex.mjs';
import { extractWindows, recordSamples, burnRate } from '../src/usage.mjs';
import { historyPath, loadHistory, writeState } from '../src/history.mjs';
import { render, safeText } from '../src/render.mjs';
import { copyAuthJson } from '../src/clipboard.mjs';

const HELP = `codex-monitor 0.1.0 - live Codex subscription usage

Usage: codex-monitor [options]
       npm run monitor -- [options]

  --once                  Print one dashboard and exit
  --json                  Print the raw rate-limit response and exit
  -n, --interval <sec>    Poll interval (default 60; range 5..86400)
  -w, --rate-window <min> Burn-rate lookback (default 30; range 2..10080)
  --timeout <sec>         Per-fetch deadline (default 20; range 1..300)
  --reset-history        Discard this account's saved burn samples
  --state-dir <path>     Override the private history/status directory
  --codex-bin <path>     Codex executable (default: codex on PATH)
  --codex-home <path>    Override CODEX_HOME for the Codex subprocess
  --color / --no-color   Force or disable ANSI colors
  -h, --help             Show this help
  -v, --version          Show the version

Requires Node.js >=22 and a Codex CLI supporting app-server. Sign in with
'codex login' using ChatGPT. API-key billing is not subscription quota usage.
Uses only initialize and account/rateLimits/read; never starts model turns.
Token refresh stays with Codex. CODEX_HOME is honored.

An interactive terminal redraws every second; q or Ctrl-C quits.
Press c to copy auth.json as CODEX_AUTH_JSON to the system clipboard.
Redirected output automatically prints once. NO_COLOR and TERM=dumb disable colors;
TERM=dumb also disables interactive redraws. --json never writes monitor state.

Usage bars show consumption; time bars show elapsed quota-window time.
Durations come from Codex, including model-specific pools. Projections are
straight-line estimates, not forecasts. They require 90s of samples in the
lookback and restart on rollovers or usage decreases. Expired readings are
marked explicitly rather than assumed to reset to zero.
At most 1000 samples are retained per window. Small terminals use a compact
layout; enlarge the terminal or use --once if all rows do not fit.

State: $XDG_STATE_HOME/codex-monitor, or ~/.local/state/codex-monitor.
History is isolated by hashed account ID; missing identity means session-only
samples. status.json records the last refresh result without credentials.
Concurrent monitors are safe from partial writes but the last writer wins.
Exit status: 0 success, 1 fetch/runtime failure, 2 invalid arguments.

Examples:
  npm start
  npm run monitor -- --once --no-color
  node bin/codex-monitor.mjs --json
  node bin/codex-monitor.mjs -n 30 -w 60
`;

function options() {
  const { values } = parseArgs({
    options: {
      once: { type: 'boolean' }, json: { type: 'boolean' },
      interval: { type: 'string', short: 'n', default: '60' },
      'rate-window': { type: 'string', short: 'w', default: '30' },
      timeout: { type: 'string', default: '20' },
      'reset-history': { type: 'boolean' }, 'state-dir': { type: 'string' },
      'codex-bin': { type: 'string', default: 'codex' }, 'codex-home': { type: 'string' },
      color: { type: 'boolean' }, 'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: false,
  });
  if (values.help || values.version) return values;
  const number = (name, min, max) => {
    const value = Number(values[name]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`--${name} must be between ${min} and ${max}`);
    }
    return value;
  };
  if (values.color && values['no-color']) throw new Error('choose --color or --no-color, not both');
  if (values.json && values['reset-history']) throw new Error('--json cannot be combined with --reset-history');
  for (const name of ['codex-bin', 'codex-home', 'state-dir']) {
    if (values[name] !== undefined && !values[name].trim()) throw new Error(`--${name} cannot be empty`);
  }
  return {
    ...values,
    interval: number('interval', 5, 86400),
    rateWindow: number('rate-window', 2, 10080),
    timeoutMs: number('timeout', 1, 300) * 1000,
    color: values.color ?? (!values['no-color'] && Boolean(process.stdout.isTTY) &&
      process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'),
    live: !values.once && !values.json && Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb',
    stateDir: path.resolve(values['state-dir'] ?? path.join(process.env.XDG_STATE_HOME ||
      path.join(os.homedir(), '.local', 'state'), 'codex-monitor')),
  };
}

async function main(opts) {
  if (opts.help) return void process.stdout.write(HELP);
  if (opts.version) return void process.stdout.write('0.1.0\n');

  const controller = new AbortController();
  const stop = () => controller.abort();
  const brokenPipe = (error) => {
    if (error.code === 'EPIPE') stop();
    else {
      process.exitCode = 1;
      stop();
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.on('error', brokenPipe);
  const request = () => fetchUsage({
    codexBin: opts['codex-bin'],
    codexHome: opts['codex-home'] ? path.resolve(opts['codex-home']) : undefined,
    timeoutMs: opts.timeoutMs,
    signal: controller.signal,
  });
  let tick;
  let screen = false;
  const wasRaw = process.stdin.isRaw;
  let copyAuth;
  const onKey = (key) => {
    if (key.includes('q') || key.includes('\x03')) stop();
    else if (key === 'c') void copyAuth?.();
  };
  try {
    if (opts.json) {
      const data = await request();
      // Validate compatibility while preserving the upstream JSON contract.
      extractWindows(data);
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return;
    }
    let history = Object.create(null);
    let currentFile;
    let reset = opts['reset-history'];
    const state = {
      windows: null, data: null, rates: Object.create(null), fetchedAtMs: null,
      error: null, warning: null, persistent: false,
    };
    const draw = () => {
      if (controller.signal.aborted) return;
      process.stdout.write(`${screen ? '\x1b[H\x1b[2J' : ''}${render(state, {
        ...opts, columns: process.stdout.columns, rows: process.stdout.rows,
      })}`);
    };
    let copying = false;
    copyAuth = async () => {
      if (copying || controller.signal.aborted) return;
      copying = true;
      state.clipboard = 'Copying CODEX_AUTH_JSON...';
      draw();
      try {
        await copyAuthJson({
          codexHome: opts['codex-home'], signal: controller.signal,
        });
        state.clipboard = 'CODEX_AUTH_JSON copied to clipboard.';
      } catch (error) {
        state.clipboard = safeText(error.message);
      } finally {
        copying = false;
        draw();
      }
    };
    const refresh = async () => {
      state.warning = null;
      const warnings = [];
      try {
        const data = await request();
        const windows = extractWindows(data);
        const now = Date.now();
        const file = historyPath(opts.stateDir, data.accountId);
        if (file !== currentFile || reset) {
          history = Object.create(null);
          if (!reset) {
            try {
              history = await loadHistory(file);
            } catch (error) {
              warnings.push(`Could not load burn history (${safeText(error.message)}); measuring afresh.`);
            }
          }
          currentFile = file;
          reset = false;
        }
        recordSamples(history, windows, now);
        state.rates = Object.fromEntries(windows.map((window) => [window.key,
          burnRate(history[window.key]?.samples, now, opts.rateWindow)]));
        state.windows = windows;
        state.data = data;
        state.fetchedAtMs = now;
        state.error = null;
        state.persistent = file !== null;
        if (file) {
          try {
            await writeState(file, { version: 1, windows: history });
          } catch (error) {
            warnings.push(`Could not save burn history: ${safeText(error.message)}`);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        state.error = safeText(error.message);
      }
      try {
        await writeState(path.join(opts.stateDir, 'status.json'), {
          source: 'codex-app-server', status: state.error ? 'error' : 'ok',
          updatedAt: new Date().toISOString(),
          fetchedAt: state.fetchedAtMs === null ? null : new Date(state.fetchedAtMs).toISOString(),
          error: state.error,
        });
      } catch (error) {
        warnings.push(`Could not save status: ${safeText(error.message)}`);
      }
      state.warning = warnings.join(' ') || null;
    };

    if (opts.live) {
      screen = true;
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onKey);
        process.stdin.resume();
      }
      draw();
      tick = setInterval(draw, 1000);
    }
    do {
      const started = Date.now();
      await refresh();
      draw();
      if (!opts.live) {
        if (state.error) process.exitCode = 1;
        break;
      }
      await sleep(Math.max(0, opts.interval * 1000 - (Date.now() - started)), undefined, {
        signal: controller.signal,
      });
    } while (!controller.signal.aborted);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearInterval(tick);
    if (screen) {
      process.stdin.removeListener('data', onKey);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(Boolean(wasRaw));
        process.stdin.pause();
      }
      process.stdout.write('\x1b[?25h\x1b[?1049l');
    }
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

let opts;
try {
  opts = options();
} catch (error) {
  process.stderr.write(`codex-monitor: ${safeText(error.message)}\nTry --help for usage.\n`);
  process.exitCode = 2;
}
if (opts) {
  await main(opts).catch((error) => {
    process.stderr.write(`codex-monitor: ${safeText(error.message)}\n`);
    process.exitCode = 1;
  });
}
