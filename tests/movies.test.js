import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKEN } from './helpers/harness.js';

const post = (h, kind, imdb) => h.get(`/${TOKEN}/do/${kind}/${imdb}`);
const calls = (mock, method, path) => mock.calls.filter((c) => c.method === method && c.path === path);

test('a movie that is not in the library offers a download button', async () => {
  const h = await startHarness();
  try {
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Download/);
    assert.equal(stream.url, `https://addon.example.test/${TOKEN}/do/movie/tt1`);
    assert.equal(calls(h.radarr, 'POST', '/movie').length, 0, 'listing streams must not add anything');
  } finally { await h.close(); }
});

test('selecting the button adds the movie with the default profile and root folder, then searches', async () => {
  const h = await startHarness();
  try {
    const res = await post(h, 'movie', 'tt1');
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    const [added] = calls(h.radarr, 'POST', '/movie');
    assert.equal(added.body.imdbId, 'tt1');
    assert.equal(added.body.qualityProfileId, 4);
    assert.equal(added.body.rootFolderPath, '/data/movies');
    assert.equal(added.body.addOptions.searchForMovie, true);
    assert.equal(added.body.monitored, true);
  } finally { await h.close(); }
});

test('quality profile and root folder can be configured by name and path', async () => {
  const h = await startHarness({ env: { RADARR_QUALITY_PROFILE: 'small', RADARR_ROOT_FOLDER: '/mnt/films' } });
  try {
    await post(h, 'movie', 'tt1');
    const [added] = calls(h.radarr, 'POST', '/movie');
    assert.equal(added.body.qualityProfileId, 7);
    assert.equal(added.body.rootFolderPath, '/mnt/films');
  } finally { await h.close(); }
});

test('an unknown quality profile name fails the request instead of guessing', async () => {
  const h = await startHarness({ env: { RADARR_QUALITY_PROFILE: 'nope' } });
  try {
    await post(h, 'movie', 'tt1');
    assert.equal(calls(h.radarr, 'POST', '/movie').length, 0);
  } finally { await h.close(); }
});

test('after a request the entry shows "requested" and the button is not offered again', async () => {
  const h = await startHarness();
  try {
    await post(h, 'movie', 'tt1');
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Requested/);
    assert.match(stream.url, /\/notice\/wait\.mp4$/);
  } finally { await h.close(); }
});

test('a queued download reports progress', async () => {
  const h = await startHarness();
  try {
    await post(h, 'movie', 'tt1');
    h.radarr.state.queue.push({ movieId: 1, size: 1000, sizeleft: 580 });
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Downloading 42%/);
    assert.match(stream.description, /42%/);
  } finally { await h.close(); }
});

test('a movie that already has a file offers nothing (the media server addon plays it)', async () => {
  const h = await startHarness();
  try {
    // Radarr's lookup returns `movieFile` (not `hasFile`) for movies it already has.
    h.radarr.state.movies.set('tt2', { id: 5, title: 'Another Film', imdbId: 'tt2', monitored: true, movieFile: { id: 9 } });
    assert.deepEqual(await h.streams('movie', 'tt2'), []);
  } finally { await h.close(); }
});

test('a known movie without a file is re-searched instead of added twice', async () => {
  const h = await startHarness();
  try {
    h.radarr.state.movies.set('tt3', { id: 8, title: 'Third Film', imdbId: 'tt3', monitored: false });
    await post(h, 'movie', 'tt3');
    assert.equal(calls(h.radarr, 'POST', '/movie').length, 0);
    assert.equal(calls(h.radarr, 'PUT', '/movie/8').length, 1, 'it gets monitored');
    const [search] = calls(h.radarr, 'POST', '/command');
    assert.deepEqual(search.body, { name: 'MoviesSearch', movieIds: [8] });
  } finally { await h.close(); }
});

test('titles Radarr does not know about produce no entry', async () => {
  const h = await startHarness();
  try {
    assert.deepEqual(await h.streams('movie', 'tt999'), []);
  } finally { await h.close(); }
});

test('the button reappears if a request found nothing for a long time', async () => {
  const h = await startHarness();
  try {
    await post(h, 'movie', 'tt1');
    h.advance(11 * 60 * 1000);
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /Download/);
  } finally { await h.close(); }
});

test('Portuguese locale and custom names are applied', async () => {
  const h = await startHarness({ env: { LOCALE: 'pt', SOURCE_NAME: 'Home' } });
  try {
    const [stream] = await h.streams('movie', 'tt1');
    assert.match(stream.name, /^Home\n⬇ Descarregar/);
  } finally { await h.close(); }
});
