import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RateLimiter } from './ratelimit.js';
import pkg from '../package.json' with { type: 'json' };

const NOTICES_DIR = fileURLToPath(new URL('../assets/notices/', import.meta.url));
const version = pkg.version;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const NO_STORE = { 'Cache-Control': 'no-store' };

const IMDB = /^tt\d{1,10}$/;
const STREAM_ID = /^tt\d{1,10}(?::\d{1,3}:\d{1,4})?$/;

function sameToken(candidate, expectedDigest) {
  const digest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(digest, expectedDigest);
}

export function createServer({ config, bridge, now = Date.now }) {
  const perIp = new RateLimiter(config.rateLimitPerMinute, 60_000, now);
  const global = new RateLimiter(config.globalLimitPerHour, 3_600_000, now);
  const base = `${config.publicUrl}/${config.token}`;

  const manifest = {
    id: 'community.stremio-request-bridge',
    version,
    name: config.addonName,
    description: 'Request a title on your Radarr/Sonarr from the Stremio stream list, and watch the progress there.',
    resources: ['stream'],
    types: [...(bridge.hasMovies ? ['movie'] : []), ...(bridge.hasSeries ? ['series'] : [])],
    idPrefixes: ['tt'],
    catalogs: [],
  };

  const actionUrl = (kind, imdb, season) => {
    if (kind === 'movie') return `${base}/do/movie/${imdb}`;
    if (kind === 'season') return `${base}/do/season/${imdb}/${season}`;
    if (kind === 'delete-movie') return `${base}/do/delete/movie/${imdb}`;
    if (kind === 'delete-season') return `${base}/do/delete/season/${imdb}/${season}`;
    if (kind === 'confirm-movie') return `${base}/do/confirm-delete/movie/${imdb}`;
    if (kind === 'confirm-season') return `${base}/do/confirm-delete/season/${imdb}/${season}`;
    return `${base}/notice/wait.mp4`;
  };

  const json = (res, body, status = 200) => {
    res.writeHead(status, { ...CORS, ...NO_STORE, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const notFound = (res) => {
    res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain' });
    res.end('not found');
  };

  // Short MP4 shown by the player when the user selects an action entry. Supports Range, which players rely on.
  async function sendNotice(req, res, name, status = 200) {
    const data = await readFile(`${NOTICES_DIR}${config.locale}/${name}.mp4`);
    let start = 0;
    let end = data.length - 1;
    let code = status;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range && status === 200) {
      code = 206;
      if (range[1] !== '') start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), end);
      if (range[1] === '' && range[2] !== '') { start = data.length - Number(range[2]); end = data.length - 1; }
    }
    res.writeHead(code, {
      ...CORS,
      ...NO_STORE,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(code === 206 ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
  }

  const clientIp = (req) => {
    if (config.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded) return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    // Everything else lives under /<token>/. A wrong or missing token looks exactly like any unknown path.
    const [, token, ...rest] = path.split('/');
    if (!token || !sameToken(token, config.tokenDigest)) return notFound(res);
    const route = `/${rest.join('/')}`;
    let m;

    if (route === '/manifest.json') return json(res, manifest);

    if ((m = /^\/stream\/(movie|series)\/(.+)\.json$/.exec(route))) {
      if (!STREAM_ID.test(m[2])) return json(res, { streams: [] });
      return json(res, { streams: await bridge.streams(m[1], m[2], actionUrl) });
    }

    if ((m = /^\/notice\/(ok|wait|err)\.mp4$/.exec(route))) return sendNotice(req, res, m[1]);

    if ((m = /^\/do\/(movie|season)\/(tt\d+)(?:\/(\d+))?$/.exec(route))) {
      const [, kind, imdb, seasonStr] = m;
      const season = seasonStr === undefined ? undefined : Number(seasonStr);
      if (!IMDB.test(imdb) || (kind === 'season' && !(season >= 0 && season < 1000)) || (kind === 'movie' && season !== undefined)) return notFound(res);
      // Players probe the URL (HEAD, range requests) before playing: only a real GET may trigger a request.
      if (req.method !== 'GET') return sendNotice(req, res, 'ok');
      if (!perIp.allow(clientIp(req)) || !global.allow('all')) {
        console.warn('rate limit hit on request endpoint');
        return sendNotice(req, res, 'err');
      }
      try {
        const outcome = await bridge.request(kind, imdb, season);
        console.log(`request ${kind} ${imdb}${season === undefined ? '' : ` s${season}`}: ${outcome}`);
        return sendNotice(req, res, 'ok');
      } catch (err) {
        console.error(`request ${kind} ${imdb} failed: ${err.message}`);
        return sendNotice(req, res, 'err');
      }
    }

    // Deleting is off unless ALLOW_DELETE is set, and then needs two separate URLs: "delete" only arms, and only the
    // "confirm" URL (offered for a minute after arming) deletes. Both ignore anything but a real GET.
    if ((m = /^\/do\/(confirm-)?delete\/(movie|season)\/(tt\d+)(?:\/(\d+))?$/.exec(route))) {
      if (!config.allowDelete) return notFound(res);
      const [, confirm, kind, imdb, seasonStr] = m;
      const season = seasonStr === undefined ? undefined : Number(seasonStr);
      if (!IMDB.test(imdb) || (kind === 'season' && !(season >= 0 && season < 1000)) || (kind === 'movie' && season !== undefined)) return notFound(res);
      if (req.method !== 'GET') return sendNotice(req, res, confirm ? 'deleted' : 'confirm');
      if (!perIp.allow(clientIp(req)) || !global.allow('all')) {
        console.warn('rate limit hit on delete endpoint');
        return sendNotice(req, res, 'err');
      }
      try {
        const label = `${kind} ${imdb}${season === undefined ? '' : ` s${season}`}`;
        if (!confirm) {
          console.log(`delete ${label}: ${bridge.arm(kind, imdb, season)}`);
          return sendNotice(req, res, 'confirm');
        }
        const outcome = await bridge.remove(kind, imdb, season);
        console.log(`delete ${label}: ${outcome}`);
        return sendNotice(req, res, outcome === 'not-armed' ? 'err' : 'deleted');
      } catch (err) {
        console.error(`delete ${kind} ${imdb} failed: ${err.message}`);
        return sendNotice(req, res, 'err');
      }
    }

    return notFound(res);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(`unhandled: ${err.message}`);
      if (!res.headersSent) { res.writeHead(500, CORS); res.end('error'); } else res.end();
    });
  });
}
