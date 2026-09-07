import { stripVTControlCharacters } from 'node:util';

// Backend labels and errors are text, never terminal instructions.
export function safeText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

function duration(ms) {
  let seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

export function render(state, options, nowMs = Date.now()) {
  const columns = Math.max(20, Math.min(options.columns || 80, 100));
  const width = columns - 4;
  const rows = Math.max(5, options.rows || 24);
  const compact = options.live && (state.windows?.length ?? 1) * 8 + 8 > rows;
  const lines = [''];
  const color = (text, code) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const line = (text = '', code = 0) => {
    const chars = Array.from(safeText(text));
    while (chars.length > width) {
      let end = chars.lastIndexOf(' ', width);
      if (end < Math.floor(width / 2)) end = width;
      lines.push(`  ${color(chars.splice(0, end).join(''), code)}`);
      if (chars[0] === ' ') chars.shift();
    }
    lines.push(`  ${color(chars.join(''), code)}`);
  };
  const bar = (label, percent, code, fill) => {
    const barWidth = Math.max(4, width - 17);
    const used = Math.round(Math.max(0, Math.min(100, percent)) / 100 * barWidth);
    const text = `${label.padEnd(5)} [${fill.repeat(used)}${'-'.repeat(barWidth - used)}] ${Math.round(percent)}%`;
    line(text, code);
  };
  const primary = state.data?.rateLimits ?? Object.values(state.data?.rateLimitsByLimitId ?? {})[0];
  line(`CODEX USAGE${primary?.planType ? ` / ${safeText(primary.planType)}` : ''}`, 1);
  line();

  const stale = Boolean(state.error) || (state.fetchedAtMs != null && nowMs - state.fetchedAtMs > options.interval * 2000);
  if (state.windows === null) {
    line(state.error ? `Error: ${state.error}` : 'Reading Codex subscription limits...', 31);
  } else if (state.windows.length === 0) {
    line('No subscription quota windows were reported.');
    line('This does not mean usage is zero or unlimited.', 2);
  } else {
    for (const window of state.windows) {
      const expired = window.resetsAtMs !== null && window.resetsAtMs <= nowMs;
      const severity = window.usedPercent >= 90 ? 31 : window.usedPercent >= 60 ? 33 : 32;
      line(window.label, 1);
      bar('Used', window.usedPercent, severity, '#');
      if (!expired && window.windowDurationMs !== null && window.resetsAtMs !== null) {
        const elapsed = Math.max(0, Math.min(1, 1 - (window.resetsAtMs - nowMs) / window.windowDurationMs));
        bar('Time', elapsed * 100, 36, '=');
      }
      if (expired) {
        line('Reset due; awaiting fresh limits. Usage is the last reading.', 33);
      } else {
        const left = `${Math.max(0, 100 - window.usedPercent).toFixed(1).replace(/\.0$/, '')}% left${stale ? ' (last reading)' : ''}`;
        if (!compact || window.resetsAtMs === null) line(left);
        if (window.resetsAtMs !== null) {
          line(`${compact ? `${left} / ` : ''}Resets in ${duration(window.resetsAtMs - nowMs)} / ${new Date(window.resetsAtMs).toLocaleString()}`, 2);
        } else {
          line('Reset time unavailable.', 2);
        }
        const rate = state.rates[window.key];
        if (stale) {
          line('Projection paused until the next successful refresh.', 33);
        } else if (window.usedPercent >= 100) {
          line('Limit reached.', 31);
        } else if (rate == null) {
          line(`Measuring burn rate (${options.rateWindow}m lookback; needs 90s of samples)...`, 2);
        } else if (rate === 0) {
          line('No measured usage change in recent samples.', 2);
        } else if (window.resetsAtMs === null) {
          line(`Burn: ${rate.toFixed(1)} percentage points/hour.`, 2);
        } else {
          const untilReset = window.resetsAtMs - nowMs;
          const sampleAge = Math.max(0, nowMs - state.fetchedAtMs);
          const untilFull = (100 - window.usedPercent) / rate * 3600000 - sampleAge;
          if (untilFull < untilReset) {
            line(`${rate.toFixed(1)}%/h -> runs out in ${duration(untilFull)}, ${duration(untilReset - untilFull)} before reset`, 31);
          } else {
            line(`${rate.toFixed(1)}%/h -> ~${Math.round(window.usedPercent + rate * (untilReset + sampleAge) / 3600000)}% at reset`, 32);
          }
        }
      }
      if (!compact) line();
    }
  }
  if (primary?.credits?.unlimited === true) line('Credits: unlimited');
  else if (primary?.credits?.balance != null) line(`Credits: ${safeText(primary.credits.balance)}`);
  if (primary?.spendControlReached === true || state.data?.spendControlReached === true) line('Account spend limit reached.', 31);
  if (state.data?.rateLimitResetCredits?.availableCount > 0) {
    line(`Earned resets available: ${state.data.rateLimitResetCredits.availableCount} (manage in Codex)`);
  }
  if (state.fetchedAtMs !== null) line(`Updated ${duration(nowMs - state.fetchedAtMs)} ago / codex app-server`, 2);
  if (state.error && state.windows !== null) line(`Error: ${state.error} / showing last good data`, 31);
  if (state.warning) line(`Warning: ${state.warning}`, 33);
  if (state.windows !== null && !state.persistent) line('Burn history is session-only; no account identity was reported.', 2);
  if (options.live) line(`Refresh ${options.interval}s / q or Ctrl-C to quit`, 2);
  if (options.live && lines.length >= rows) {
    const footer = lines.at(-1);
    lines.splice(rows - 3);
    lines.push(`  ${'More: enlarge terminal or use --once'.slice(0, width)}`, footer);
  }
  return `${lines.join('\n')}\n`;
}
