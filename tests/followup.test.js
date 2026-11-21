import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKEN } from './helpers/harness.js';

const calls = (mock, method, path) => mock.calls.filter((c) => c.method === method && c.path === path);
const commands = (mock) => calls(mock, 'POST', '/command').map((c) => c.body.name);
const FOLLOW = { FOLLOW_UP: 'true' };

test('a season search that finds a season pack does not search episode by episode', async () => {
  const h = await startHarness({ radarr: false, sonarr: true, env: FOLLOW });
  try {
    h.sonarr.state.packAvailable = true;
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    await h.settled();
    assert.deepEqual(commands(h.sonarr), ['SeasonSearch']);
  } finally { await h.close(); }
});

test('when the season search grabs nothing, the missing episodes are searched one by one', async () => {
  const h = await startHarness({ radarr: false, sonarr: true, env: FOLLOW });
  try {
    h.sonarr.state.episodesAvailable = true;
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    await h.settled();
    assert.deepEqual(commands(h.sonarr), ['SeasonSearch', 'EpisodeSearch']);
    const [, episodeSearch] = calls(h.sonarr, 'POST', '/command');
    assert.deepEqual(episodeSearch.body.episodeIds, [1, 2, 3]);
    const [stream] = await h.streams('series', 'tt10:1:1');
    assert.match(stream.name, /Downloading/, 'the episodes are now in the queue');
  } finally { await h.close(); }
});

test('when nothing is found at all, the entry says so and offers to search again', async () => {
  const h = await startHarness({ radarr: false, sonarr: true, env: FOLLOW });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    await h.settled();
    const [stream] = await h.streams('series', 'tt10:1:1');
    assert.match(stream.name, /Nothing found yet/);
    assert.match(stream.description, /monitored/);
    assert.equal(stream.url, `https://addon.example.test/${TOKEN}/do/season/tt10/1`, 'the same action URL retries');
    // Retrying works even though the request is still inside the 10 minute window.
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    assert.equal(commands(h.sonarr).filter((c) => c === 'SeasonSearch').length, 2);
  } finally { await h.close(); }
});

test('season progress is read from the queue row even without the embedded episode', async () => {
  const h = await startHarness({ radarr: false, sonarr: true });
  try {
    await h.get(`/${TOKEN}/do/season/tt10/1`);
    h.sonarr.state.queue.push({ size: 200, sizeleft: 100, seasonNumber: 1 });
    const [stream] = await h.streams('series', 'tt10:1:1');
    assert.match(stream.name, /Downloading 50%/);
    assert.ok(calls(h.sonarr, 'GET', '/queue/details').every((c) => c.query.includes('includeEpisode=true')));
  } finally { await h.close(); }
});

test('a movie request that finds nothing is reported after the follow-up check', async () => {
  const h = await startHarness({ env: FOLLOW });
  try {
    await h.get(`/${TOKEN}/do/movie/tt1`);
    await h.settled();
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Nothing found yet/);
  } finally { await h.close(); }
});

test('a movie request that was picked up is not reported as missing', async () => {
  const h = await startHarness({ env: FOLLOW });
  try {
    h.radarr.state.releaseAvailable = true;
    await h.get(`/${TOKEN}/do/movie/tt1`);
    await h.settled();
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Downloading/);
  } finally { await h.close(); }
});
