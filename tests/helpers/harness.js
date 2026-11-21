import http from 'node:http';
import { loadConfig } from '../../src/config.js';
import { Arr } from '../../src/arr.js';
import { createBridge } from '../../src/bridge.js';
import { createServer } from '../../src/server.js';

export const TOKEN = 'test-token-0123456789abcdef';

// A tiny in-memory stand-in for the parts of the Radarr/Sonarr API the bridge uses.
async function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace('/api/v3', '');
      calls.push({ method: req.method, path, query: url.search, body });
      const result = handler(req.method, path, url.searchParams, body);
      res.writeHead(result === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(result === undefined ? '{}' : JSON.stringify(result));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const profiles = [{ id: 4, name: 'HD-1080p' }, { id: 7, name: 'Small' }];
const rootFolders = [{ path: '/data/movies' }];

export async function startRadarrMock() {
  const state = { nextId: 1, movies: new Map(), queue: [], releaseAvailable: false }; // movies by imdb id
  const catalog = { tt1: 'Public Domain Film', tt2: 'Another Film', tt3: 'Third Film' };
  const mock = await startMock((method, path, params, body) => {
    if (path === '/qualityprofile') return profiles;
    if (path === '/rootfolder') return rootFolders;
    if (path === '/movie/lookup') {
      const imdb = params.get('term').replace('imdb:', '');
      if (!catalog[imdb]) return [];
      return [state.movies.get(imdb) || { title: catalog[imdb], imdbId: imdb }];
    }
    if (path === '/movie' && method === 'POST') {
      const movie = { ...body, id: state.nextId++ };
      state.movies.set(body.imdbId, movie);
      if (state.releaseAvailable) state.queue.push({ movieId: movie.id, size: 1000, sizeleft: 1000 });
      return movie;
    }
    if (path === '/moviefile' && method === 'GET') {
      const movie = [...state.movies.values()].find((m) => m.id === Number(params.get('movieId')));
      return movie?.movieFile ? [movie.movieFile] : [];
    }
    const fileById = path.match(/^\/moviefile\/(\d+)$/);
    if (fileById && method === 'DELETE') {
      for (const movie of state.movies.values()) if (movie.movieFile?.id === Number(fileById[1])) delete movie.movieFile;
      return {};
    }
    if (path.startsWith('/movie/') && method === 'PUT') {
      state.movies.set(body.imdbId, body);
      return body;
    }
    if (path === '/queue/details') return state.queue.filter((row) => row.movieId === Number(params.get('movieId')));
    if (path === '/command' && method === 'POST') {
      if (body.name === 'MoviesSearch' && state.releaseAvailable) for (const id of body.movieIds) state.queue.push({ movieId: id, size: 1000, sizeleft: 1000 });
      return { id: 1 };
    }
    if (path === '/command/1') return { id: 1, status: 'completed' };
    return undefined;
  });
  return { ...mock, state };
}

export async function startSonarrMock() {
  // packAvailable: a season search grabs a season pack. episodesAvailable: a per-episode search grabs the episodes.
  const state = { nextId: 1, series: new Map(), episodes: [], queue: [], files: [], packAvailable: false, episodesAvailable: false };
  const catalog = { tt10: 'Some Show' };
  const mock = await startMock((method, path, params, body) => {
    if (path === '/qualityprofile') return profiles;
    if (path === '/rootfolder') return [{ path: '/data/shows' }];
    if (path === '/series/lookup') {
      const imdb = params.get('term').replace('imdb:', '');
      if (!catalog[imdb]) return [];
      return [state.series.get(imdb) || { title: catalog[imdb], imdbId: imdb, seasons: [{ seasonNumber: 1, monitored: false }] }];
    }
    if (path === '/series' && method === 'POST') {
      const series = { ...body, id: state.nextId++ };
      state.series.set(body.imdbId, series);
      state.episodes = [1, 2, 3].map((n) => ({ id: n, seriesId: series.id, seasonNumber: 1, episodeNumber: n, monitored: false, hasFile: false }));
      return series;
    }
    const byId = path.match(/^\/series\/(\d+)$/);
    if (byId && method === 'GET') return [...state.series.values()].find((s) => s.id === Number(byId[1]));
    if (byId && method === 'PUT') { state.series.set(body.imdbId, body); return body; }
    if (path === '/episode') return state.episodes;
    if (path === '/episode/monitor') {
      for (const e of state.episodes) if (body.episodeIds.includes(e.id)) e.monitored = body.monitored;
      return {};
    }
    if (path === '/episodefile') return state.files;
    if (path === '/episodefile/bulk' && method === 'DELETE') {
      state.files = state.files.filter((f) => !body.episodeFileIds.includes(f.id));
      for (const e of state.episodes) if (body.episodeFileIds.includes(e.episodeFileId)) { e.hasFile = false; delete e.episodeFileId; }
      return {};
    }
    if (path === '/queue/details') return state.queue;
    if (path === '/command' && method === 'POST') {
      if (body.name === 'SeasonSearch' && state.packAvailable) state.queue.push({ size: 1000, sizeleft: 1000, episode: { seasonNumber: body.seasonNumber } });
      if (body.name === 'EpisodeSearch' && state.episodesAvailable) for (const _ of body.episodeIds) state.queue.push({ size: 100, sizeleft: 100, episode: { seasonNumber: 1 } });
      return { id: 1 };
    }
    if (path === '/command/1') return { id: 1, status: 'completed' };
    return undefined;
  });
  return { ...mock, state };
}

// Starts the real bridge + HTTP server against fresh mocks. Returns helpers for the tests.
export async function startHarness({ radarr = true, sonarr = false, env = {} } = {}) {
  const radarrMock = radarr ? await startRadarrMock() : null;
  const sonarrMock = sonarr ? await startSonarrMock() : null;
  let clock = 1_000_000;
  const config = loadConfig({
    PUBLIC_URL: 'https://addon.example.test',
    ACCESS_TOKEN: TOKEN,
    ...(radarrMock && { RADARR_URL: radarrMock.url, RADARR_API_KEY: 'r-key' }),
    ...(sonarrMock && { SONARR_URL: sonarrMock.url, SONARR_API_KEY: 's-key' }),
    SERIES_SETTLE_MS: '0',
    SERIES_POLL_MS: '0',
    FOLLOW_UP: 'false', // tests that exercise the follow-up checks turn it on
    FOLLOW_UP_MS: '0',
    ...env,
  });
  const bridge = createBridge({
    config,
    radarr: radarrMock && new Arr(config.radarr),
    sonarr: sonarrMock && new Arr(config.sonarr),
    now: () => clock,
    sleep: async () => {},
  });
  const server = createServer({ config, bridge, now: () => clock });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = (path, init) => fetch(`${base}${path}`, init);
  return {
    config,
    base,
    radarr: radarrMock,
    sonarr: sonarrMock,
    get,
    streams: async (type, id, token = TOKEN) => (await (await get(`/${token}/stream/${type}/${id}.json`)).json()).streams,
    advance: (ms) => { clock += ms; },
    settled: () => bridge.settled(),
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await radarrMock?.close();
      await sonarrMock?.close();
    },
  };
}
