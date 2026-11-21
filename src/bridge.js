import { strings } from './i18n.js';

const DEDUPE_MS = 10 * 60 * 1000; // how long a fresh request counts as "searching" before we offer the button again
const ARM_MS = 60 * 1000; // after the first "delete" selection, how long the confirm entry stays valid
const REMOVED_MS = 2 * 60 * 1000; // repeated confirm requests right after a delete (player probes) are not errors
const FINISHED = ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const progress = (rows) => {
  const size = rows.reduce((sum, row) => sum + (row.size || 0), 0);
  const left = rows.reduce((sum, row) => sum + (row.sizeleft || 0), 0);
  return size ? Math.round(((size - left) / size) * 100) : 0;
};

// All the Radarr/Sonarr logic: working out what state a title is in, requesting it, and (optionally) deleting it.
// Streams are only offered for what is actually configured.
export function createBridge({ config, radarr, sonarr, now = Date.now, sleep = defaultSleep }) {
  const t = strings(config.locale);
  const doneHint = config.doneHint || t.doneHint;
  const requested = new Map(); // key -> timestamp of the last request
  const notFound = new Set(); // keys whose search came back empty (cleared when the user asks again)
  const armed = new Map(); // delete key -> timestamp of the first "delete" selection
  const removed = new Map(); // delete key -> timestamp of a finished delete
  const background = new Set();

  const prune = (map, ttl) => {
    const ts = now();
    for (const [k, v] of map) if (ts - v > ttl) map.delete(k);
  };
  const markRequested = (key) => { prune(requested, DEDUPE_MS); requested.set(key, now()); };
  const wasRequestedRecently = (key) => requested.has(key) && now() - requested.get(key) < DEDUPE_MS;
  const isArmed = (key) => armed.has(key) && now() - armed.get(key) < ARM_MS;

  // Follow-ups run after the player already got its notice. A failure there is logged, never thrown at the user.
  const track = (promise) => {
    const task = promise.catch((err) => console.error(`follow-up failed: ${err.message}`)).finally(() => background.delete(task));
    background.add(task);
  };

  async function waitForCommand(client, command) {
    if (!command?.id) return;
    for (let i = 0; i < 60; i++) {
      await sleep(config.seriesPollMs);
      const current = await client.get(`/command/${command.id}`).catch(() => null);
      if (!current || FINISHED.includes(current.status)) return;
    }
  }

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

  const movieKey = (imdb) => `movie/${imdb}`;
  const seasonKey = (imdb, season) => `season/${imdb}/${season}`;
  const deleteKey = (kind, imdb, season) => `delete/${kind === 'movie' ? movieKey(imdb) : seasonKey(imdb, season)}`;

  // The two-step delete. Both entries are always listed: Stremio keeps the stream list it already fetched when the
  // player closes, so a "confirm" entry that only appeared after the first step would never show up on screen.
  // Safety does not depend on the list: the confirm URL only deletes within a minute of the first step.
  function deleteEntries(kind, imdb, season, actionUrl) {
    if (!config.allowDelete) return [];
    const isMovie = kind === 'movie';
    return [
      entry(t.remove, isMovie ? t.removeMovie : t.removeSeason(season), actionUrl(`delete-${kind}`, imdb, season)),
      entry(t.confirmRemove, isMovie ? t.confirmRemoveMovie : t.confirmRemoveSeason(season), actionUrl(`confirm-${kind}`, imdb, season)),
    ];
  }

  // ---- movies (Radarr) ----

  async function movieState(imdb) {
    const [movie] = await radarr.get(`/movie/lookup?term=imdb:${imdb}`);
    if (!movie) return { movie: null, state: 'unknown' };
    if (!movie.id) return { movie, state: 'new' };
    // The lookup payload has no `hasFile`; an existing file shows up as `movieFile`.
    if (movie.hasFile || movie.movieFile) return { movie, state: 'have' };
    const queue = await radarr.get(`/queue/details?movieId=${movie.id}`);
    if (queue.length) return { movie, state: 'downloading', pct: progress(queue) };
    if (notFound.has(movieKey(imdb))) return { movie, state: 'notfound' };
    return { movie, state: wasRequestedRecently(movieKey(imdb)) ? 'requested' : 'new' };
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
    } else {
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
    if (config.followUp) track(followUpMovie(imdb));
  }

  // A request that Radarr accepted is not a download. Look again a bit later and say so if nothing was found.
  async function followUpMovie(imdb) {
    await sleep(config.followUpMs);
    const { state } = await movieState(imdb);
    if (state === 'requested') notFound.add(movieKey(imdb));
  }

  async function removeMovie(imdb) {
    const { movie } = await movieState(imdb);
    if (!movie?.id) return;
    const fileId = movie.movieFile?.id ?? (await radarr.get(`/moviefile?movieId=${movie.id}`))[0]?.id;
    if (fileId) await radarr.delete(`/moviefile/${fileId}`);
    // Without this Radarr would search for it again.
    if (movie.monitored) {
      const { movieFile, ...rest } = movie; // the file is gone, do not send the stale copy back
      await radarr.put(`/movie/${movie.id}`, { ...rest, monitored: false });
    }
  }

  async function movieStreams(imdb, actionUrl) {
    const { state, pct } = await movieState(imdb);
    if (state === 'unknown') return [];
    if (state === 'have') return deleteEntries('movie', imdb, undefined, actionUrl);
    if (state === 'new') return [entry(t.action, t.movieDetail, actionUrl('movie', imdb))];
    if (state === 'downloading') return [entry(t.downloading(pct), `${t.downloadingMovie(pct)}\n${doneHint}`, actionUrl('wait'))];
    if (state === 'notfound') return [entry(t.notFound, t.notFoundMovie, actionUrl('movie', imdb))];
    return [entry(t.requested, `${t.requestedMovie}\n${doneHint}`, actionUrl('wait'))];
  }

  // ---- series (Sonarr) ----

  const inSeason = (row, season) => (row.episode?.seasonNumber ?? row.seasonNumber) === season;
  const seasonQueue = async (id, season) => (await sonarr.get(`/queue/details?seriesId=${id}&includeEpisode=true`)).filter((row) => inSeason(row, season));

  async function seriesState(imdb, season, episode) {
    const [series] = await sonarr.get(`/series/lookup?term=imdb:${imdb}`);
    if (!series) return { series: null, state: 'unknown' };
    if (!series.id) return { series, state: 'new' };
    const episodes = await sonarr.get(`/episode?seriesId=${series.id}`);
    const current = episodes.find((e) => e.seasonNumber === season && e.episodeNumber === episode);
    if (current?.hasFile) return { series, state: 'have' };
    const mine = await seasonQueue(series.id, season);
    if (mine.length) return { series, state: 'downloading', pct: progress(mine) };
    if (notFound.has(seasonKey(imdb, season))) return { series, state: 'notfound' };
    return { series, state: wasRequestedRecently(seasonKey(imdb, season)) ? 'requested' : 'new' };
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
    const search = await sonarr.post('/command', { name: 'SeasonSearch', seriesId: id, seasonNumber: season });
    if (config.followUp) track(followUpSeason(imdb, id, season, search));
  }

  // Sonarr's season search only grabs complete season packs. Many shows only exist as single episodes, so when the
  // season search ends with nothing queued, search the missing episodes one by one. If that also finds nothing, say so.
  async function followUpSeason(imdb, id, season, search) {
    await waitForCommand(sonarr, search);
    await sleep(config.seriesSettleMs);
    if ((await seasonQueue(id, season)).length) return;
    const missing = (await sonarr.get(`/episode?seriesId=${id}`)).filter((e) => e.seasonNumber === season && e.monitored && !e.hasFile);
    if (!missing.length) return;
    console.log(`season ${season} of ${imdb}: no season pack, searching ${missing.length} episodes one by one`);
    await waitForCommand(sonarr, await sonarr.post('/command', { name: 'EpisodeSearch', episodeIds: missing.map((e) => e.id) }));
    await sleep(config.seriesSettleMs);
    if (!(await seasonQueue(id, season)).length) notFound.add(seasonKey(imdb, season));
  }

  async function removeSeason(imdb, season) {
    const [series] = await sonarr.get(`/series/lookup?term=imdb:${imdb}`);
    if (!series?.id) return;
    const files = (await sonarr.get(`/episodefile?seriesId=${series.id}`)).filter((f) => f.seasonNumber === season);
    if (files.length) await sonarr.delete('/episodefile/bulk', { episodeFileIds: files.map((f) => f.id) });
    // Without this Sonarr would search for the episodes again.
    const monitored = (await sonarr.get(`/episode?seriesId=${series.id}`)).filter((e) => e.seasonNumber === season && e.monitored);
    if (monitored.length) await sonarr.put('/episode/monitor', { episodeIds: monitored.map((e) => e.id), monitored: false });
  }

  async function seriesStreams(imdb, season, episode, actionUrl) {
    const { state, pct } = await seriesState(imdb, season, episode);
    if (state === 'unknown') return [];
    if (state === 'have') return deleteEntries('season', imdb, season, actionUrl);
    if (state === 'new') return [entry(t.action, t.seasonDetail(season), actionUrl('season', imdb, season))];
    if (state === 'downloading') return [entry(t.downloading(pct), `${t.downloadingSeason(season, pct)}\n${doneHint}`, actionUrl('wait'))];
    if (state === 'notfound') return [entry(t.notFound, t.notFoundSeason(season), actionUrl('season', imdb, season))];
    return [entry(t.requested, `${t.requestedSeason(season)}\n${doneHint}`, actionUrl('wait'))];
  }

  return {
    hasMovies: Boolean(radarr),
    hasSeries: Boolean(sonarr),

    // Resolves when every follow-up check has finished (used by the tests).
    settled: () => Promise.all([...background]),

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
      const key = kind === 'movie' ? movieKey(imdb) : seasonKey(imdb, season);
      // A title reported as "nothing found" can always be asked for again, even inside the dedupe window.
      if (!notFound.has(key) && wasRequestedRecently(key)) return 'duplicate';
      markRequested(key);
      notFound.delete(key);
      try {
        if (kind === 'movie') await requestMovie(imdb);
        else await requestSeason(imdb, season);
      } catch (err) {
        requested.delete(key);
        throw err;
      }
      return 'sent';
    },

    // Step 1 of a delete: only remembers that the user asked. Nothing is touched yet.
    arm(kind, imdb, season) {
      armed.set(deleteKey(kind, imdb, season), now());
      return 'armed';
    },

    // Step 2: deletes, but only if step 1 happened in the last minute. Players probe URLs and may call this more than
    // once for a single selection, so a repeat right after a delete is reported as such, not as an error.
    async remove(kind, imdb, season) {
      const key = deleteKey(kind, imdb, season);
      prune(removed, REMOVED_MS);
      if (removed.has(key)) return 'duplicate';
      if (!isArmed(key)) return 'not-armed';
      armed.delete(key);
      if (kind === 'movie') await removeMovie(imdb);
      else await removeSeason(imdb, season);
      removed.set(key, now());
      requested.delete(kind === 'movie' ? movieKey(imdb) : seasonKey(imdb, season));
      return 'deleted';
    },
  };
}
