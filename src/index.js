#!/usr/bin/env node
import { ConfigError, loadConfig } from './config.js';
import { Arr } from './arr.js';
import { createBridge } from './bridge.js';
import { createServer } from './server.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const bridge = createBridge({
  config,
  radarr: config.radarr && new Arr(config.radarr),
  sonarr: config.sonarr && new Arr(config.sonarr),
});

createServer({ config, bridge }).listen(config.port, config.host, () => {
  console.log(`stremio-request-bridge listening on ${config.host}:${config.port}`);
  console.log(`install in Stremio with: ${config.publicUrl}/<ACCESS_TOKEN>/manifest.json`);
});
