# Using a Stremio stream as an action button

*Source code: github.com/rafaellopes/stremio-request-bridge*

Stremio addons have no user interface. They answer one question: which streams exist for this title? I wanted a button that says "request this title on my server", and the only place to put it was inside that answer.

So I made one of the streams not a video, but an action.

## The trick

When you open a title, Stremio asks every installed addon for streams and merges the answers into one list. Each entry is a name, a description and a URL that is supposed to be a video. My addon returns an entry called "Download" whose URL points at its own `/do/movie/<id>` endpoint. Select it, Stremio opens the URL, the endpoint sends the title to Radarr (or Sonarr for series), and it answers with a four second MP4 that says "Request sent". The player plays a real video, so the user gets feedback instead of an error.

The same entry then doubles as a status line. Each time the title page opens, the addon asks Radarr and Sonarr where things are and returns "Requested", "Downloading 42%" or nothing at all once the file is in the library, where another addon takes over and offers it for playback. There is no database. The state lives in the apps that already own it.

## Where it got interesting

An action behind a GET is the interesting part, because everything that can call a GET can now trigger it. A few things I had to deal with.

**Players probe URLs.** Players and proxies can send a HEAD or a ranged request before playing. If those had side effects, every probe would fire a request. Only a real GET triggers anything now, and the same request within ten minutes is ignored.

**Radarr's lookup does not tell you if you own the movie.** I checked `hasFile` on the lookup result, which is always empty. For a movie you already have, the proof is a nested `movieFile`. My first version offered to download films that were already in the library.

**Sonarr undoes your work if you are early.** To request a single season I add the series with `monitor: none` and then monitor only that season. Sonarr loads the episode list first and applies `monitor: none` afterwards, which silently wiped my flags, and the season search found nothing to search for. The fix is to wait for the episodes to appear, and a bit longer, before touching anything.

**A season search finds season packs, not seasons.** One day a request for a whole season went through, Sonarr accepted it, and nothing downloaded. The season search had finished with "0 reports downloaded" because the show only exists as single episodes, while a manual search listed all eight as approved. The lesson is to treat "the API accepted it" as the start of the job: the addon now checks the queue afterwards, falls back to searching episode by episode, and tells the user when there is still nothing.

**A permissive quality profile will happily pick a 33 GB release.** My first real request ran with a profile that allowed any 1080p, and Radarr grabbed a 33 GB remux. I cancelled it and capped the size in the profile. The addon uses whatever profile you configure, and the README says to give that profile a size limit.

## Making it safe to publish

My own version had my domain, my folders and my quality profile in the code, and a GET endpoint with no protection at all. Turning it into something other people can run meant three things.

First, configuration: everything comes from environment variables, with sensible defaults taken from Radarr and Sonarr themselves. Second, security. Every route lives under a secret token in the path, compared in constant time, and a wrong token looks identical to an unknown page. There is a per-client and a global rate limit, strict id validation, and the addon can only add or monitor a title and start a search, nothing else. Third, tests: forty-five of them, running the real HTTP server against small fake Radarr and Sonarr APIs. They cover the request flow end to end in under two seconds, and the project has no dependencies.

## The general lesson

When a platform gives you one extension point, look at what the host does with your answer. Here the host plays a URL, so a URL can be an action. The price is that you now own the side effects behind a GET, and it is cheaper to design for them from the first commit than to find them one by one.

The code is MIT licensed, runs from a single container, and is on GitHub: github.com/rafaellopes/stremio-request-bridge

---

## Short version for a LinkedIn post

Stremio addons have no UI, so how do you add a "request this title" button? I turned one of the streams in the answer into an action: select it and the URL sends the title to Radarr or Sonarr, answers with a short notice video, and later the same entry shows the download progress. The fun part was everything that can go wrong behind a GET: players that probe URLs, an API that does not say whether you own a movie, and a Sonarr that wipes your settings if you are too early. Now it is configurable, protected by a secret path, rate limited and covered by tests, MIT licensed. Write-up and code: github.com/rafaellopes/stremio-request-bridge
