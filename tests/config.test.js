import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config.js';

const valid = {
  PUBLIC_URL: 'https://addon.example.test/',
  ACCESS_TOKEN: 'abcdefghijklmnop',
  RADARR_URL: 'http://radarr:7878/',
  RADARR_API_KEY: 'key',
};

test('accepts a minimal Radarr-only configuration and normalises URLs', () => {
  const config = loadConfig(valid);
  assert.equal(config.publicUrl, 'https://addon.example.test');
  assert.equal(config.radarr.url, 'http://radarr:7878');
  assert.equal(config.sonarr, null);
  assert.equal(config.port, 7000);
  assert.equal(config.locale, 'en');
});

test('reports every problem at once', () => {
  assert.throws(() => loadConfig({}), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.length >= 3);
    return true;
  });
});

test('rejects a short or URL-unsafe access token', () => {
  assert.throws(() => loadConfig({ ...valid, ACCESS_TOKEN: 'short' }), /ACCESS_TOKEN/);
  assert.throws(() => loadConfig({ ...valid, ACCESS_TOKEN: 'has/slash/in/it/xx' }), /ACCESS_TOKEN/);
});

test('requires both URL and key for a configured app', () => {
  assert.throws(() => loadConfig({ ...valid, RADARR_API_KEY: '' }), /RADARR_API_KEY/);
});

test('rejects unknown locale and bad numbers', () => {
  assert.throws(() => loadConfig({ ...valid, LOCALE: 'xx' }), /LOCALE/);
  assert.throws(() => loadConfig({ ...valid, PORT: 'abc' }), /PORT/);
});
