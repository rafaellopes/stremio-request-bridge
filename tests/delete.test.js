import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKEN } from './helpers/harness.js';

const calls = (mock, method, path) => mock.calls.filter((c) => c.method === method && c.path === path);
const ON = { ALLOW_DELETE: 'true' };
const withFile = (h) => h.radarr.state.movies.set('tt2', { id: 5, title: 'Another Film', imdbId: 'tt2', monitored: true, movieFile: { id: 9 } });

async function seasonWithFiles(h) {
  await h.get(`/${TOKEN}/do/season/tt10/1`); // adds the series and its three episodes
  h.sonarr.state.episodes.forEach((e, i) => { e.hasFile = true; e.monitored = true; e.episodeFileId = 100 + i; });
  h.sonarr.state.files = [{ id: 100, seasonNumber: 1 }, { id: 101, seasonNumber: 1 }, { id: 102, seasonNumber: 1 }];
}

test('deleting is off by default: no entry and the routes do not exist', async () => {
  const h = await startHarness();
  try {
    withFile(h);
    assert.deepEqual(await h.streams('movie', 'tt2'), []);
    assert.equal((await h.get(`/${TOKEN}/do/delete/movie/tt2`)).status, 404);
    assert.equal((await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`)).status, 404);
  } finally { await h.close(); }
});

test('a movie that has a file offers "delete", which only asks for confirmation', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    const [stream, confirm] = await h.streams('movie', 'tt2');
    assert.match(stream.name, /Delete from server/);
    assert.equal(stream.url, `https://addon.example.test/${TOKEN}/do/delete/movie/tt2`);
    // Stremio does not refetch the list after the notice plays, so the confirm entry is there from the start.
    assert.match(confirm.name, /Confirm delete/);
    assert.equal(confirm.url, `https://addon.example.test/${TOKEN}/do/confirm-delete/movie/tt2`);
    const res = await h.get(`/${TOKEN}/do/delete/movie/tt2`);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 0, 'the first step deletes nothing');
    assert.equal((await h.streams('movie', 'tt2')).length, 2, 'the list does not change after arming');
  } finally { await h.close(); }
});

test('confirming deletes the file and stops monitoring so Radarr does not fetch it again', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    await h.get(`/${TOKEN}/do/delete/movie/tt2`);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 1);
    const [put] = calls(h.radarr, 'PUT', '/movie/5');
    assert.equal(put.body.monitored, false);
    const [stream] = await h.streams('movie', 'tt2');
    assert.match(stream.name, /Download/, 'the download button is back');
  } finally { await h.close(); }
});

test('the confirm URL does nothing unless the first step happened', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 0);
  } finally { await h.close(); }
});

test('the first step expires after a minute', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    await h.get(`/${TOKEN}/do/delete/movie/tt2`);
    h.advance(61_000);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 0);
    const [stream] = await h.streams('movie', 'tt2');
    assert.match(stream.name, /Delete from server/);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 0, 'still needs a fresh first step');
  } finally { await h.close(); }
});

test('player probes (HEAD, repeated GETs) never delete on their own and never delete twice', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    await h.get(`/${TOKEN}/do/delete/movie/tt2`, { method: 'HEAD' });
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`, { method: 'HEAD' });
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 0, 'HEAD does not even arm');
    const [stream] = await h.streams('movie', 'tt2');
    assert.match(stream.name, /Delete from server/);
    await h.get(`/${TOKEN}/do/delete/movie/tt2`);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    await h.get(`/${TOKEN}/do/confirm-delete/movie/tt2`);
    assert.equal(calls(h.radarr, 'DELETE', '/moviefile/9').length, 1);
  } finally { await h.close(); }
});

test('delete routes need the token like everything else', async () => {
  const h = await startHarness({ env: ON });
  try {
    withFile(h);
    assert.equal((await h.get('/wrong-token-0123456789/do/delete/movie/tt2')).status, 404);
    assert.equal((await h.get('/wrong-token-0123456789/do/confirm-delete/movie/tt2')).status, 404);
  } finally { await h.close(); }
});

test('deleting a season removes its episode files and unmonitors the episodes', async () => {
  const h = await startHarness({ radarr: false, sonarr: true, env: ON });
  try {
    await seasonWithFiles(h);
    const [stream] = await h.streams('series', 'tt10:1:2');
    assert.match(stream.name, /Delete from server/);
    assert.match(stream.description, /season 1/);
    assert.equal(stream.url, `https://addon.example.test/${TOKEN}/do/delete/season/tt10/1`);
    await h.get(`/${TOKEN}/do/delete/season/tt10/1`);
    assert.equal(calls(h.sonarr, 'DELETE', '/episodefile/bulk').length, 0);
    await h.get(`/${TOKEN}/do/confirm-delete/season/tt10/1`);
    const [bulk] = calls(h.sonarr, 'DELETE', '/episodefile/bulk');
    assert.deepEqual(bulk.body.episodeFileIds, [100, 101, 102]);
    const unmonitor = calls(h.sonarr, 'PUT', '/episode/monitor').at(-1);
    assert.equal(unmonitor.body.monitored, false);
    assert.deepEqual(await h.streams('series', 'tt10:1:2').then((s) => s.map((x) => x.name)).then((n) => n.length), 1);
    const [after] = await h.streams('series', 'tt10:1:2');
    assert.match(after.name, /Download/);
  } finally { await h.close(); }
});

test('an episode of another season is not touched by deleting this one', async () => {
  const h = await startHarness({ radarr: false, sonarr: true, env: ON });
  try {
    await seasonWithFiles(h);
    h.sonarr.state.files.push({ id: 200, seasonNumber: 2 });
    await h.get(`/${TOKEN}/do/delete/season/tt10/1`);
    await h.get(`/${TOKEN}/do/confirm-delete/season/tt10/1`);
    const [bulk] = calls(h.sonarr, 'DELETE', '/episodefile/bulk');
    assert.ok(!bulk.body.episodeFileIds.includes(200));
  } finally { await h.close(); }
});
