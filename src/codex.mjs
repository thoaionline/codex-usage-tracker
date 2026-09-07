import { spawn } from 'node:child_process';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * MAX_LINE_BYTES;
const LOGIN_HELP = 'Run `codex login` with a ChatGPT subscription account; API-key accounts do not expose subscription limits.';

function requestError(error) {
  if (error?.code === -32601) {
    return new Error('This Codex app-server does not support account/rateLimits/read. Update Codex and try again.');
  }
  if (error?.code === -32600 || error?.code === -32602) {
    return new Error('Codex rejected the app-server protocol. Update Codex and try again.');
  }
  // Never propagate the server's message, data, or stderr: these can contain secrets.
  return new Error(`Codex could not read subscription limits. ${LOGIN_HELP}`);
}

function abortError() {
  const error = new Error('Codex usage request aborted.');
  error.name = 'AbortError';
  return error;
}

export async function fetchUsage({
  codexBin = 'codex',
  codexHome,
  timeoutMs = 20000,
  signal,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new Error('Codex request timeout must be a positive number no greater than 2147483647 milliseconds.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('Codex request signal must be an AbortSignal.');
  }
  if (signal?.aborted) throw abortError();

  let child;
  try {
    child = spawn(codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexHome === undefined ? process.env : { ...process.env, CODEX_HOME: codexHome },
    });
  } catch {
    throw new Error('Could not launch Codex. Check the Codex executable and install or update the Codex CLI.');
  }

  return new Promise((resolve, reject) => {
    let expectedId = 1;
    let buffer = '';
    let outputBytes = 0;
    let finished = false;
    let exited = false;
    let closed = false;
    let failure;
    let result;
    let killTimer;

    const release = () => {
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else resolve(result);
    };

    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      failure = error;
      result = value;
      buffer = '';
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!exited && child.pid !== undefined) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 500);
      }
      // Resolve only after close: the child has been reaped and all pipes closed.
      if (closed) release();
    };

    const send = message => {
      if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => {
      finish(new Error('Timed out reading Codex subscription limits. Check your connection and Codex installation, then try again.'));
    }, timeoutMs);

    child.on('error', error => {
      finish(new Error(error.code === 'ENOENT'
        ? 'Codex executable not found. Install the Codex CLI or provide its executable path.'
        : 'Could not start or control Codex. Check executable permissions and your Codex installation.'));
    });
    child.stdin.on('error', () => {
      finish(new Error('Codex closed its input before completing the request. Update Codex and try again.'));
    });
    child.stdout.on('error', () => {
      finish(new Error('Could not read the Codex app-server response. Update Codex and try again.'));
    });
    child.stderr.on('error', () => {
      finish(new Error('Codex app-server output failed. Check your Codex installation.'));
    });
    child.on('exit', () => {
      exited = true;
      clearTimeout(killTimer);
    });
    child.on('close', () => {
      closed = true;
      if (!finished) {
        finish(new Error(`Codex closed before returning subscription limits. ${LOGIN_HELP}`));
      } else {
        release();
      }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (finished) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(new Error('Codex app-server response exceeded the output limit. Update Codex and try again.'));
        return;
      }
      buffer += chunk;
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          finish(new Error('Codex app-server response exceeded the line limit. Update Codex and try again.'));
          return;
        }
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error('Codex app-server returned invalid JSON. Update Codex and try again.'));
          return;
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          finish(new Error('Codex app-server returned an invalid protocol message. Update Codex and try again.'));
          return;
        }
        if (typeof message.method === 'string') {
          if (Object.hasOwn(message, 'id')) {
            if (typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) {
              finish(new Error('Codex app-server returned an invalid request identifier.'));
              return;
            }
            send({ id: message.id, error: { code: -32601, message: 'Client requests are not supported.' } });
          }
          continue;
        }
        if (message.id !== expectedId) continue;
        if (Object.hasOwn(message, 'error')) {
          finish(requestError(message.error));
          return;
        }
        if (!Object.hasOwn(message, 'result')) {
          finish(new Error('Codex app-server response did not contain a result. Update Codex and try again.'));
          return;
        }
        if (expectedId === 1) {
          expectedId = 2;
          send({ method: 'initialized' });
          send({ id: expectedId, method: 'account/rateLimits/read' });
        } else {
          finish(undefined, message.result);
        }
      }
      if (!finished && Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        finish(new Error('Codex app-server response exceeded the line limit. Update Codex and try again.'));
      }
    });
    // Drain, but never retain or display potentially sensitive diagnostics.
    child.stderr.resume();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    send({
      id: expectedId,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex_monitor', title: 'Codex Usage Monitor', version: '0.1.0' },
      },
    });
  });
}
