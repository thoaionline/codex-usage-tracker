# Codex Usage Tracker

A dependency-free terminal dashboard for Codex subscription limits, with usage bars, reset countdowns, and burn-rate estimates. Monitors subscription quotas—not API billing or historical token counts.

## Setup

Requires **Node.js 22+** and the [Codex CLI](https://github.com/openai/codex) with a ChatGPT subscription login.

```bash
npm install -g @openai/codex  # Skip if Codex is already installed
codex login

git clone https://github.com/thoaionline/codex-usage-tracker.git
cd codex-usage-tracker
npm start
```

No project dependencies need installing. The monitor uses your existing Codex login through `codex app-server`; it never starts model turns. Press **q** or **Ctrl-C** to quit.

## Usage

```bash
npm run monitor -- --once --no-color  # Single snapshot
npm run monitor -- -n 30 -w 60       # Poll every 30s; 60-minute burn-rate lookback
npm run monitor -- --help            # All options
npm test                             # Run regression tests
```

Burn estimates need at least 90 seconds of samples and are straight-line projections, not forecasts. History is stored under `$XDG_STATE_HOME/codex-monitor` or `~/.local/state/codex-monitor`; use `--reset-history` to start fresh. `CODEX_HOME` is honored.

**Privacy:** `--json` prints the raw response, including account metadata. Do not publish captured responses, credentials, or local usage history.
