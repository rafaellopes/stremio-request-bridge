import { strings } from './i18n.js';

const DEDUPE_MS = 10 * 60 * 1000; // how long a fresh request counts as "searching" before we offer the button again
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const progress = (rows) => {
  const size = rows.reduce((sum, row) => sum + (row.size || 0), 0);
  const left = rows.reduce((sum, row) => sum + (row.sizeleft || 0), 0);
  return size ? Math.round(((size - left) / size) * 100) : 0;
};

// All the Radarr/Sonarr logic: working out what state a title is in, and requesting it.
// Streams are only offered for what is actually configured and never for titles that are already in the library.
export function createBridge({ config, radarr, sonarr, now = Date.now, sleep = defaultSleep }) {
  const t = strings(config.locale);
  const doneHint = config.doneHint || t.doneHint;
  const requested = new Map(); // action path -> timestamp of the last request

  const markRequested = (key) => {
    const ts = now();
    for (const [k, v] of requested) if (ts - v > DEDUPE_MS) requested.delete(k);
    requested.set(key, ts);
  };
  const wasRequestedRecently = (key) => requested.has(key) && now() - requested.get(key) < DEDUPE_MS;

  // Root folder and quality profile: use the configured value, otherwise the first one the app offers.
  const defaults = { radarr: null, sonarr: null };
  async function resolveDefaults(kind, client, settings) {
    if (defaults[kind]) return defaults[kind];
    let qualityProfileId;
    const profiles = await client.get('/qualityprofile');
    if (settings.qualityProfile === undefined) {
      qualityProfileId = profiles[0]?.id;
    } else if (/^\d+$/.test(settings.qualityProfile)) {
      qualityProfileId = Number(settings.qualityProfile);
    } else {
      const wanted = settings.qualityProfile.toLowerCase();
      qualityProfileId = profiles.find((p) => p.name.toLowerCase() === wanted)?.id;
      if (qualityProfileId === undefined) throw new Error(`quality profile "${settings.qualityProfile}" not found in ${kind}`);
    }
    const rootFolderPath = settings.rootFolder || (await client.get('/rootfolder'))[0]?.path;
    if (qualityProfileId === undefined || !rootFolderPath) throw new Error(`${kind} has no quality profile or root folder configured`);
    defaults[kind] = { qualityProfileId, rootFolderPath };
    return defaults[kind];
  }

  const entry = (status, detail, url) => ({ name: `${config.sourceName}\n${status}`, description: detail, url });

  // ---- movies (Radarr) ----

  async function movieState(imdb) {
    const [movie] = await radarr.get(`/movie/lookup?term=imdb:${imdb}`);
    if (!movie) return { movie: null, state: 'unknown' };
    if (!movie.id) return { movie, state: 'new' };
    // The lookup payload has no `hasFile`; an existing file shows up as `movieFile`.
    if (movie.hasFile || movie.movieFile) return { movie, state: 'have' };
    const queue = await radarr.get(`/queue/details?movieId=${movie.id}`);
    if (queue.length) return { movie, state: 'downloading', pct: progress(queue) };
    return { movie, state: wasRequestedRecently(`movie/${imdb}`) ? 'requested' : 'new' };
  }

  async function requestMovie(imdb) {
    const { movie, state } = await movieState(imdb);
    if (!movie) throw new Error('movie not found');
    // Duplicate clicks are filtered before we get here, so "requested" (no file, nothing queued) is safe to act on.
    if (state === 'have' || state === 'downloading') return;
    if (movie.id) {
      // Known to Radarr but no file and nothing queued: make sure it is monitored and search again.
      if (!movie.monitored) await radarr.put(`/movie/${movie.id}`, { ...movie, monitored: true });
      await radarr.post('/command', { name: 'MoviesSearch', movieIds: [movie.id] });
      return;
    }
    const { qualityProfileId, rootFolderPath } = await resolveDefaults('radarr', radarr, config.radarr);
    await radarr.post('/movie', {
      ...movie,
      qualityProfileId,
      rootFolderPath,
      monitored: true,
      minimumAvailability: config.minimumAvailability,
      addOptions: { searchForMovie: true },
    });
  }

  async function movieStreams(imdb, actionUrl) {
    const { state, pct } = await movieState(imdb);
    if (state === 'have' || state === 'unknown') return [];
    if (state === 'new') return [entry(t.action, t.movieDetail, actionUrl('movie', imdb))];
    if (state === 'downloading') return [entry(t.downloading(pct), `${t.downloadingMovie(pct)}\n${doneHint}`, actionUrl('wait'))];
    return [entry(t.requested, `${t.requestedMovie}\n${doneHint}`, actionUrl('wait'))];
  }

  // ---- series (Sonarr) ----

  async function seriesState(imdb, season, episode) {
    const [series] = await sonarr.get(`/series/lookup?term=imdb:${imdb}`);
    if (!series) return { series: null, state: 'unknown' };
    if (!series.id) return { series, state: 'new' };
    const episodes = await sonarr.get(`/episode?seriesId=${series.id}`);
    const current = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === episode);
    if (current?.hasFile) return { series, state: 'have' };
    const queue = await sonarr.get(`/queue/details?seriesId=${series.id}`);
    const mine = queue.filter((row) => row.episode?.seasonNumber === season);
    if (mine.length) return { series, state: 'downloading', pct: progress(mine) };
    return { series, state: wasRequestedRecently(`season/${imdb}/${season}`) ? 'requested' : 'new' };
  }

  async function requestSeason(imdb, season) {
    const [lookup] = await sonarr.get(`/series/lookup?term=imdb:${imdb}`);
    if (!lookup) throw new Error('series not found');
    let id = lookup.id;
    if (!id) {
      const { qualityProfileId, rootFolderPath } = await resolveDefaults('sonarr', sonarr, config.sonarr);
      const added = await sonarr.post('/series', {
        ...lookup,
        qualityProfileId,
        rootFolderPath,
        seriesType: 'standard',
        seasonFolder: true,
        monitored: true,
        addOptions: { monitor: 'none', searchForMissingEpisodes: false },
      });
      id = added.id;
      // Sonarr loads the episode list first and applies `monitor: none` afterwards, which would undo anything we set
      // too early. Wait for the episodes to appear, then a little longer for that step to finish.
      for (let i = 0; i < 20; i++) {
        await sleep(config.seriesPollMs);
        if ((await sonarr.get(`/episode?seriesId=${id}`)).length) break;
      }
      await sleep(config.seriesSettleMs);
    }
    const series = await sonarr.get(`/series/${id}`);
    const target = series.seasons.find((s) => s.seasonNumber === season);
    if (!target) throw new Error(`season ${season} does not exist`);
    if (!target.monitored) {
      target.monitored = true;
      await sonarr.put(`/series/${id}`, series);
    }
    const unmonitored = (await sonarr.get(`/episode?seriesId=${id}`)).filter((e) => e.seasonNumber === season && !e.monitored);
    if (unmonitored.length) await sonarr.put('/episode/monitor', { episodeIds: unmonitored.map((e) => e.id), monitored: true });
    await sonarr.post('/command', { name: 'SeasonSearch', seriesId: id, seasonNumber: season });
  }

  async function seriesStreams(imdb, season, episode, actionUrl) {
    const { state, pct } = await seriesState(imdb, season, episode);
    if (state === 'have' || state === 'unknown') return [];
    if (state === 'new') return [entry(t.action, t.seasonDetail(season), actionUrl('season', imdb, season))];
    if (state === 'downloading') return [entry(t.downloading(pct), `${t.downloadingSeason(season, pct)}\n${doneHint}`, actionUrl('wait'))];
    return [entry(t.requested, `${t.requestedSeason(season)}\n${doneHint}`, actionUrl('wait'))];
  }

  return {
    hasMovies: Boolean(radarr),
    hasSeries: Boolean(sonarr),

    // `id` is the Stremio id: "tt0063350" for a movie, "tt7366338:1:2" for season 1 episode 2.
    async streams(type, id, actionUrl) {
      try {
        const [imdb, seasonStr, episodeStr] = id.split(':');
        if (type === 'movie' && radarr) return await movieStreams(imdb, actionUrl);
        if (type === 'series' && sonarr) return await seriesStreams(imdb, Number(seasonStr), Number(episodeStr), actionUrl);
      } catch (err) {
        console.error(`streams ${type} ${id}: ${err.message}`);
      }
      return [];
    },

    // Returns 'sent' for a new request and 'duplicate' when the same one was made moments ago.
    async request(kind, imdb, season) {
      const key = kind === 'movie' ? `movie/${imdb}` : `season/${imdb}/${season}`;
      if (wasRequestedRecently(key)) return 'duplicate';
      markRequested(key);
      try {
        if (kind === 'movie') await requestMovie(imdb);
        else await requestSeason(imdb, season);
      } catch (err) {
        requested.delete(key);
        throw err;
      }
      return 'sent';
    },
  };
}
