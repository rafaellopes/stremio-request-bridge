# How it works

## The one hook an addon has

Stremio addons answer HTTP requests. For a title, Stremio calls `GET /stream/movie/tt0063350.json` on every installed addon and merges the answers into one list. An entry in that list is `{ name, description, url }`, and `url` is expected to be a video.

This bridge answers with an entry whose `url` is not a video but an action:

```
Stremio                      Bridge                       Radarr / Sonarr
  | GET /stream/movie/tt..     |                              |
  |--------------------------->|  lookup + queue state        |
  |                            |----------------------------->|
  |  [ "Request" entry ]       |<-----------------------------|
  |<---------------------------|                              |
  |                            |                              |
  | user selects the entry     |                              |
  | GET /do/movie/tt..         |                              |
  |--------------------------->|  add + search                |
  |                            |----------------------------->|
  |  4 second notice (mp4)     |                              |
  |<---------------------------|                              |
  |                            |                              |
  | reopen the title           |                              |
  | GET /stream/movie/tt..     |  queue progress              |
  |--------------------------->|----------------------------->|
  |  [ "Downloading 42%" ]     |                              |
  |<---------------------------|                              |
```

Because the action URL returns a real MP4 (a short notice), the player plays it and the user gets feedback instead of an error.

## The states

Each time a title page opens, the bridge asks Radarr/Sonarr and shows exactly one entry:

| State | How it is detected | Entry |
|---|---|---|
| in the library | Radarr: `movieFile` present. Sonarr: the episode has a file | none (your media server addon offers it) |
| downloading | the title has rows in `/queue/details` | `Downloading NN%` |
| requested | requested through this addon in the last 10 minutes | `Requested` |
| new | none of the above | `Download` button |

Nothing is stored: state comes from the apps, apart from a small in-memory list of recent requests.

## Problems worth knowing about

These each cost time while building it.

**Players probe URLs.** Players and proxies commonly send `HEAD` or ranged requests before playing. A side effect on those would fire a request on every probe, so only a real `GET` triggers anything, and the same request within 10 minutes is ignored.

**Radarr's lookup has no `hasFile`.** `GET /movie/lookup?term=imdb:...` returns the movie resource, but for movies you already own the proof of a file is the nested `movieFile`, not `hasFile`. Checking `hasFile` made the bridge offer a download button for films that were already in the library.

**Sonarr undoes your monitoring if you are early.** The clean way to request one season is to add the series with `monitor: none`, then monitor only that season. But Sonarr loads the episode list first and applies `monitor: none` afterwards, so anything set too early is wiped and the season search finds nothing to look for. The bridge waits for the episodes to appear, and a moment longer, before it sets the monitored flags.

**A known title is not a new title.** If Radarr already has the movie (unmonitored, no file, nothing queued), adding it again fails. The right move is to monitor it and trigger `MoviesSearch`.

**The default profile can be huge.** With a profile that allows any 1080p, the first request chose a 33 GB release. The bridge uses whichever profile you configure, so give that profile a size limit.

**HTTPS is not optional.** Stremio on TVs and phones refuses plain http addons, so the addon needs a certificate, even when everything else on the network is local.

## Security model

An action behind a `GET` is a request anyone can forge if they know the URL. The mitigation is layered and deliberately simple: a secret path segment compared in constant time, indistinguishable 404s, a per-client and a global rate limit, strict id validation, and no write access to anything except "add, monitor and search" in Radarr/Sonarr. See the README for the list.
