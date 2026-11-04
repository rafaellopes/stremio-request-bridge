import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, TOKEN } from './helpers/harness.js';

const added = (h) => h.radarr.calls.filter((c) => c.method === 'POST' && c.path === '/movie').length;

test('everything except /healthz is hidden behind the token', async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.get('/healthz')).status, 200);
    assert.equal((await h.get('/manifest.json')).status, 404);
    assert.equal((await h.get('/wrong-token-0123456789/manifest.json')).status, 404);
    assert.equal((await h.get('/wrong-token-0123456789/do/movie/tt1')).status, 404);
    assert.equal((await h.get(`/${TOKEN}/manifest.json`)).status, 200);
    assert.equal(added(h), 0);
  } finally { await h.close(); }
});

test('a wrong token gets the same answer as an unknown path', async () => {
  const h = await startHarness();
  try {
    const wrong = await (await h.get('/wrong-token-0123456789/do/movie/tt1')).text();
    const unknown = await (await h.get('/anything/at/all')).text();
    assert.equal(wrong, unknown);
  } finally { await h.close(); }
});

test('probing the action URL (HEAD, OPTIONS) never triggers a request', async () => {
  const h = await startHarness();
  try {
    await h.get(`/${TOKEN}/do/movie/tt1`, { method: 'HEAD' });
    await h.get(`/${TOKEN}/do/movie/tt1`, { method: 'POST' });
    await h.get(`/${TOKEN}/do/movie/tt1`, { method: 'OPTIONS' });
    assert.equal(added(h), 0);
    await h.get(`/${TOKEN}/do/movie/tt1`);
    assert.equal(added(h), 1);
  } finally { await h.close(); }
});

test('the same request repeated by a player is only sent once', async () => {
  const h = await startHarness();
  try {
    for (let i = 0; i < 4; i++) await h.get(`/${TOKEN}/do/movie/tt1`);
    assert.equal(added(h), 1);
  } finally { await h.close(); }
});

test('malformed ids are rejected before reaching Radarr', async () => {
  const h = await startHarness();
  try {
    assert.equal((await h.get(`/${TOKEN}/do/movie/tt1%3Bdrop`)).status, 404);
    assert.equal((await h.get(`/${TOKEN}/do/movie/notanid`)).status, 404);
    assert.equal((await h.get(`/${TOKEN}/do/season/tt10/99999`)).status, 404);
    assert.deepEqual(await h.streams('movie', 'tt1;rm'), []);
    assert.equal(h.radarr.calls.length, 0);
  } finally { await h.close(); }
});

test('the per-client limit stops a burst of different requests', async () => {
  const h = await startHarness({ env: { RATE_LIMIT_PER_MINUTE: '2' } });
  try {
    for (const id of ['tt1', 'tt2', 'tt3']) await h.get(`/${TOKEN}/do/movie/${id}`);
    assert.equal(added(h), 2, 'the third distinct request is refused');
    h.advance(61_000);
    await h.get(`/${TOKEN}/do/movie/tt3`);
    assert.equal(added(h), 3, 'allowed again after the window');
  } finally { await h.close(); }
});

test('the global hourly cap applies across clients', async () => {
  const h = await startHarness({ env: { GLOBAL_LIMIT_PER_HOUR: '1', TRUST_PROXY: 'true' } });
  try {
    await h.get(`/${TOKEN}/do/movie/tt1`, { headers: { 'x-forwarded-for': '10.0.0.1' } });
    await h.get(`/${TOKEN}/do/movie/tt2`, { headers: { 'x-forwarded-for': '10.0.0.2' } });
    assert.equal(added(h), 1);
  } finally { await h.close(); }
});

test('the notice video supports range requests', async () => {
  const h = await startHarness();
  try {
    const res = await h.get(`/${TOKEN}/notice/ok.mp4`, { headers: { range: 'bytes=0-99' } });
    assert.equal(res.status, 206);
    assert.match(res.headers.get('content-range'), /^bytes 0-99\//);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  } finally { await h.close(); }
});
