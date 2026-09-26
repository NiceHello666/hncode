#!/usr/bin/env node
// Entry point for the global web UI daemon.
//
// Normally spawned by web-daemon-client.js from a TUI session; it can also be
// run by hand (`node src/web-daemon-cli.js`) to keep the UI up without a TUI.
//
// Everything it would have printed to a terminal goes to the log file instead,
// because a daemon started detached has no terminal to report to — that log is
// the only place a bind failure can be read afterwards.

import { startWebDaemon, defaultDaemonPipe } from './web-daemon.js';
import { resolveConfig } from './config.js';

const cfg = resolveConfig();

async function main() {
  const host = process.env.HNCODE_WEB_HOST || cfg.webHost || '127.0.0.1';
  const port = Number(process.env.HNCODE_WEB_PORT ?? (cfg.webPort == null ? 8765 : cfg.webPort));
  const pipePath = defaultDaemonPipe();

  let daemon;
  try {
    daemon = await startWebDaemon({ host, port, pipePath });
  } catch (e) {
    // The port is the usual failure: something else already holds it. Say WHICH
    // address and how to change it, because a detached daemon cannot ask.
    if (e && (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(e.message)))) {
      process.stderr.write(
        `[web-daemon] port ${port} on ${host} is already in use.\n`
        + '[web-daemon] Choose another in config.toml:  web_port = 8766\n'
        + '[web-daemon] or for this run:  HNCODE_WEB_PORT=8766\n',
      );
      process.exit(1);
    }
    throw e;
  }

  if (daemon.pipeError) {
    // Another daemon already owns the pipe. Not an error for the caller — this
    // one simply has nothing to add, so it exits and the TUI keeps using the
    // existing daemon.
    process.stderr.write(`[web-daemon] another daemon already owns ${pipePath}; exiting\n`);
    daemon.close();
    process.exit(0);
  }

  process.stdout.write(
    `[web-daemon] listening on ${daemon.url} (pid ${process.pid})\n`
    + `[web-daemon] pipe: ${daemon.pipePath}\n`,
  );

  const shutdown = () => {
    try { daemon.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[web-daemon] fatal: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
