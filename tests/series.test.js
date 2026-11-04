import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKEN } from './helpers/harness.js';

const calls = (mock, method, path) => mock.calls.filter((c) => c.method === method && c.path === path);

test('a series that is not in the library offers a season button', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    const [stream] = await h.streams('series', 'tt10:1:2');
    assert.match(stream.name, /Download/);
    assert.match(stream.description, /season 1/);
    assert.equal(stream.url, `https://addon.example.test/${TOKEN}/do/season/tt10/1`);
  } finally { await h.close(); }
});

test('requesting a season adds the series unmonitored, then monitors that season and its episodes, then searches', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    const [added] = calls(h.sonarr, 'POST', '/series');
    assert.equal(added.body.addOptions.monitor, 'none', 'we never want the whole series');
    assert.equal(added.body.rootFolderPath, '/data/shows');
    assert.equal(calls(h.sonarr, 'PUT', '/series/1').length, 1, 'season gets monitored');
    const [monitor] = calls(h.sonarr, 'PUT', '/episode/monitor');
    assert.deepEqual(monitor.body.episodeIds, [1, 2, 3]);
    const [search] = calls(h.sonarr, 'POST', '/command');
    assert.deepEqual(search.body, { name: 'SeasonSearch', seriesId: 1, seasonNumber: 1 });
  } finally { await h.close(); }
});

test('a season that does not exist fails cleanly', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/9`);
    assert.equal(calls(h.sonarr, 'POST', '/command').length, 0);
  } finally { await h.close(); }
});

test('season progress is reported once downloads are queued', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    h.sonarr.state.queue.push({ size: 400, sizeleft: 100, episode: { seasonNumber: 1 } });
    const [stream] = await h.streams('series', 'tt10:1:1');
    assert.match(stream.name, /Downloading 75%/);
  } finally { await h.close(); }
});

test('an episode that already has its file offers nothing', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    h.sonarr.state.episodes[1].hasFile = true;
    assert.deepEqual(await h.streams('series', 'tt10:1:2'), []);
  } finally { await h.close(); }
});

test('with only Radarr configured, series are ignored (and the manifest says so)', async () => {
  const h = await startHarness({ radarr: true, sonarr: false });
  try {
    assert.deepEqual(await h.streams('series', 'tt10:1:1'), []);
    const manifest = await (await h.get(`/${TOKEN}/manifest.json`)).json();
    assert.deepEqual(manifest.types, ['movie']);
  } finally { await h.close(); }
});
