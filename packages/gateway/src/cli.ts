#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createGatewayServer } from './server.js';
import { log } from './logger.js';

const args = process.argv.slice(2);
let configPath = 'gateway.yaml';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' || args[i] === '-c') {
    const next = args[i + 1];
    if (next) {
      configPath = next;
      i++;
    }
  }
}

try {
  const config = loadConfig(configPath);
  const server = createGatewayServer(config);

  server.listen({ port: config.port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      log('error', 'Failed to start gateway', { error: String(err) });
      process.exit(1);
    }
    log('info', `Grantex Gateway listening`, {
      address,
      upstream: config.upstream,
      routes: config.routes.length,
    });
  });

  // Graceful shutdown
  const shutdown = () => {
    log('info', 'Shutting down gateway');
    server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  log('error', 'Failed to start gateway', { error: String(err) });
  process.exit(1);
}
