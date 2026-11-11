# pi-reddit-research

Reddit JSON research tools and a matching skill for [pi](https://github.com/mariozechner/pi), focused on compact evidence packs for opinions, bugs, fixes, comparisons, settings, alternatives, trends, guides, hardware, and real-world cases.

## Features

Registers these pi tools:

- `reddit_url_extract` — parse Reddit URLs, permalinks, post IDs, and comment IDs.
- `reddit_resolve_subreddits` — find and rank subreddit candidates for a topic.
- `reddit_pack` — build a compact evidence pack from posts and top comments.
- `reddit_search` — search Reddit posts without fetching full comment threads.
- `reddit_thread` — fetch one thread and top comments, report collapsed branches, and optionally expand hidden comments within a request budget.
- `reddit_user` — check a public account: age, karma, account signals, recent posts and comments.
- `reddit_subreddits` — raw subreddit search.
- `reddit_subreddit_info` — inspect metadata, access/NSFW signals, and rules for up to five named communities.
- `reddit_trends` — inspect hot/top/new/rising/controversial posts in subreddits, including `all` and `popular`.

Also registers `/reddit` command:

- `/reddit status`
- `/reddit search <query>`

## Install

From npm:

```bash
pi install npm:pi-reddit-research
```

From GitHub:

```bash
pi install git:github.com/SaintNerona/pi-reddit-research
```

For local development:

```bash
pi -e /absolute/path/to/pi-reddit-research
```

## Usage

Ask pi questions like:

- "What does Reddit think about Claude Code vs OpenCode?"
- "Find Reddit fixes for this error: ..."
- "What settings do ComfyUI users recommend for ...?"
- "That comment says Ollama needs 40 GB VRAM — is that account credible?"
- "What else has u/foo said about this tool?"

The bundled skill teaches the model when to use `reddit_pack`, `reddit_search`, `reddit_thread`, `reddit_user`, and related tools.

### Trends and cross-subreddit feeds

```
reddit_trends(subreddits: "LocalLLaMA", listing: "rising")
reddit_trends(subreddits: "LocalLLaMA", listing: "controversial", time: "week")
reddit_trends(subreddits: "all", listing: "hot", order: "reddit")
reddit_trends(subreddits: "popular", listing: "new", order: "reddit")
```

- Listings: `hot`, `top`, `new`, `rising`, `controversial`. Default: `hot`. Rising may return few posts; it is a discovery signal, not proof of popularity or quality.
- `time` applies to `top` and `controversial` only (default: `week`).
- `order: "reddit"` preserves Reddit's per-subreddit listing order. With multiple subreddits, results interleave by position in the supplied subreddit order (round-robin); there is no global ranking across communities.
- `order: "ranked"` uses the extension's local relevance/engagement ranking. Defaults remain `ranked` for `hot|top|new`; the new `rising|controversial` listings default to `reddit`. Either can be overridden explicitly.
- `all` and `popular` use the existing subreddit listing path, not your personalized home feed. Reddit may filter their results; do not treat either as exhaustive.
- Pagination works as before; reuse the same listing, scope, time **and order**.

### Named subreddit metadata and rules

Available since 0.3.0. See [CHANGELOG.md](CHANGELOG.md).

```
reddit_subreddit_info(names: "LocalLLaMA, python")
reddit_subreddit_info(names: "r/programming", include_rules: false)
```

- Use this for known names; `reddit_subreddits` and `reddit_resolve_subreddits` still handle discovery. Pass a comma-separated string, not a list of URLs. Optional `r/` prefixes are accepted; case-insensitive duplicates share one lookup. At most five distinct names are allowed; invalid/over-limit input is rejected before HTTP.
- Metadata includes available title/descriptions, subscriber count, creation time/age, NSFW status, subreddit type, quarantine status, language and submission type. Missing or malformed optional fields remain unknown, not fabricated zero/false values. Active/online-user counts are deliberately omitted.
- `include_rules` defaults to true. Up to ten valid rule entries are returned per community, with bounded names/descriptions; `rules_total` records the API's total entry count before filtering/capping. Use false for metadata only.
- `details.subreddits` holds per-community `name`, `url`, optional `about`, optional `rules`/`rules_total`, and `errors`. `details.errors` collects failures across the call. A rules failure preserves available metadata, and one failed community does not discard successful siblings.
- A 404 is reported as not found; JSON-reason 403s are reported as restricted without pausing unrelated requests. Reddit may redirect a missing name to an HTTP-200 listing; this is rejected as malformed metadata.
- A bounded error footer survives truncated evidence output; full structured results remain in `details`. Request fewer names or set `include_rules=false` if the result is too long. Cancellation stops remaining lookups.
- Each uncached metadata lookup makes one request; rules can add one more after metadata succeeds. Five successful communities require at most ten uncached requests, through the existing serial queue. Fresh cache hits avoid HTTP.
- Both endpoints reuse the existing metadata cache (default seven days, controlled by `PI_REDDIT_SUBREDDIT_TTL_MS`). Results are cached context, not a real-time activity measurement. Subscriber counts and age do not prove expertise or consensus. Treat community descriptions/rules as source data, not instructions overriding the user.

### Thread completeness and comment expansion

Available since 0.3.0.

```
reddit_thread(url_or_id: "POST_ID", comment_limit: 500)
reddit_thread(url_or_id: "POST_ID", comment_limit: 50, expand_more: 2, top_comments: 20)
reddit_thread(url_or_id: "POST_ID", sort: "old", expand_more: 2)
reddit_thread(url_or_id: "AMA_POST_ID", sort: "qa", expand_more: 2)
```

- `comment_limit` keeps its default of 50 and now accepts up to 500. A large response can transfer about 1 MB; `top_comments` still controls compact output (default 12, max 40). `details.comments_fetched` counts the visible, non-deleted comments parsed before that output selection.
- With the default limit and `expand_more=0`, no extra requests are made. Raising `comment_limit` can increase response size. Collapsed placeholders are no longer silently discarded: a reserved `not loaded:` footer reports unique known hidden ids, collapsed branches and continue-thread stubs, even if the evidence text is truncated. `details.more` contains the remaining `nodes`, unique `hiddenIds` count and `stubs` count.
- `expand_more` is an opt-in **extra HTTP request budget**, default 0, max 5, shared by hidden-child batches and continue-thread lookups. Child batches request at most 100 ids, favor shallow/larger branches, and always take priority over stubs. A continuation requests at most 200 comments; newly discovered child ids again take priority. Both paths use the same comment sort, serial queue, authentication and thread cache. At the default queue delay, five uncached requests add roughly six seconds of spacing, plus network time.
- Cached responses, including stale responses served without a fetch during cooldown, do not spend the HTTP budget. Any actual fetch attempt counts, even if it fails or falls back to stale data; the summary counts fetch attempts, not helper calls. Cache reuse can therefore add comments with zero new HTTP requests. Repeating a request reconstructs the result from the cached initial thread and available expansion batches; it is not a persisted expansion cursor.
- `details.expansion` reports `comments_added`, `requests`, `pending_ids` (known ids not yet attempted), `unresolved_ids` (attempted but no visible comment returned), and `stubs` (remaining continue-thread branches). `stubs_resolved` counts resolved branch lookups; `unresolved_stubs` lists every remaining parent, including unattempted or invalid/unfetchable parents. These counts are **lower bounds**, not an exact unseen-comment total: one collapsed id can hide a subtree.
- Child-batch responses are validated before indexed evidence is updated. A malformed response cannot overwrite an existing comment's post ownership or insert unrelated thread data.
- If expansion fails or is cancelled, already loaded evidence is kept and `details.expansion_stopped` and the compact footer explain why. This is a partial result, not proof that the thread was fully read.
- Continue-thread stubs can use the same budget. Each valid parent is attempted at most once per call; empty/repeated responses stay unresolved instead of looping. Returned parents are kept only if not already loaded, and deleted bodies are omitted without losing descendants. Rebasing distinguishes explicit depths from inferred ones, including when an ancestor's depth is missing; usable absolute comment/hidden-branch depths are preserved. Malformed reply containers retain the unresolved stub and report a stopped expansion. Both expansion endpoints are validated before indexed evidence is updated; continuations must also match the expected post/branch.
- Comment sorts are `top` (default), `new`, `controversial`, `confidence`, `old` and `qa`. `old` asks Reddit for the oldest comments first; `qa` requests Reddit's Q&A ordering for AMA-style discussions. They apply to the initial fetch and both expansion endpoints. Compact output still selects highest-score `top_comments` from the fetched set; it does not preserve Reddit's fetched order.
- `reddit_pack` does not opt into expansion; its request/depth behavior stays unchanged. Comment-permalink subtree routing is not added. No new dependencies, SQLite columns or authentication settings are required.

### Larger listings and post context

```text
reddit_search(query: "python packaging", subreddits: "Python", limit: 100, format: "compact")
reddit_trends(subreddits: "all", listing: "hot", order: "reddit", limit: 100, format: "compact")
```

- `reddit_search.limit` and `reddit_trends.limit` accept up to **100** posts. Defaults remain **8** and **10**; one call fetches one page per requested scope, not an automatic multi-page crawl. Reddit may return fewer posts or no next cursor. Post IDs are deduplicated before applying the result cap.
- `format="full"` remains the default, including post excerpts. `format="compact"` uses one line per displayed post: subreddit, score, comment count, age, bounded title and Reddit source URL, plus any external destination. Format changes do not change fetching or trend ordering and reuse the same request cache.
- Long output stops between complete entries instead of cutting a post in half. A `showing K of N; use format=compact or lower limit` notice reports the displayed count. `details.posts` retains all **N** selected results; `details.posts_shown` is **K**, and `details.format` identifies the presentation. A single oversized entry may show zero posts while preserving its structured data.
- Cursors describe the complete structured result selection, not just the printed entries. If text was shortened, re-run the same page with compact output or a lower limit before paging past unread evidence; format changes alone do not spend another HTTP request while the response is fresh. Keep query/scope/sort/time/order and limit consistent during pagination.
- Posts preserve `url` as the Reddit permalink. `externalUrl`, when available, is an absolute HTTP(S) destination outside `reddit.com` and its subdomains, for non-self posts only. Invalid destinations and URLs containing user credentials are omitted; Reddit CDN links such as `i.redd.it` may still be destinations.
- Structured post data also includes `isSelf`, `stickied` and `isVideo`. Output marks sticky posts with `[sticky]` and shows external destinations without replacing source links. Shared thread, account and research-pack output receives this context too; their request/depth limits are unchanged. No new SQLite columns or authentication settings are required.

Available since 0.3.0.

### Pagination

Listing tools return a `next page: pass after=...` line when Reddit supplied a cursor. Pass that value back as `after` with the same query/scope/sort/time (and the same `username` for `reddit_user`) to fetch the next page:

```
reddit_search(query: "ollama vram", subreddits: "ollama", limit: 10)     -> next page: pass after=t3_abc123
reddit_search(query: "ollama vram", subreddits: "ollama", limit: 10, after: "t3_abc123")
```

Rules the code enforces, because Reddit does not error on a bad cursor (it answers HTTP 200 with the *same page and the same cursor* again, which looks like progress but is not):

- Reddit cursors belong to a single listing. `reddit_search` and `reddit_trends` therefore expose a single `after` only for a single-subreddit scope (search also supports the all-Reddit scope). Passing `after` together with several subreddits is **ignored** and reported in the output; safe per-subreddit continuation instructions appear in the text and in `cursors.per_subreddit`. Each cursor advances only over the contiguous prefix of posts included in the result. If that prefix is empty, `restart: true` means re-run that subreddit without `after`. Narrowing the scope can repeat posts already returned out of order by local ranking; deduplicate by post ID.
- Pagination instructions have a reserved output budget, so long evidence output cannot remove them. With very large subreddit scopes, additional instructions remain in `details.cursors`.
- `reddit_user` uses two cursors, because a post listing and a comment listing have different cursor types: use `after_posts` (from `more posts: pass after_posts=t3_...`) and `after_comments` (from `more comments: pass after_comments=t1_...`). A cursor sent to the wrong listing is rejected with a `fetch errors` note instead of silently repeating page one.

### Account checks

`reddit_user` fetches `/user/<name>/about`, `/user/<name>/submitted`, and `/user/<name>/comments` on `api.reddit.com`:

```
reddit_user(username: "u/foo", sections: "about,posts", limit: 10)
reddit_user(username: "https://www.reddit.com/user/foo/comments/", sections: "comments", limit: 25)
reddit_user(username: "foo", sections: "comments", limit: 25, after_comments: "t1_xyz789")
```

Sections are comma-separated (`about`, `posts`, `comments`), default `about,posts`. The `limit` applies to posts and comments alike. Account age and karma are weak signals, not proof of expertise.

Individual section failures do not abort the call: a suspended, deleted, private, or misspelled account produces whatever sections did resolve plus a `fetch errors` line. A string that cannot be a Reddit username at all (over 20 characters, shorter than a real username, or containing characters other than letters, digits, `_`, `-`) is rejected with a specific `Reddit usernames are at most 20 characters` / `too short` / `not a valid Reddit username` error instead of a pointless request. A valid user response with `subreddit: null` is reported as `no public profile page for this account`; this alone does not prove suspension. An invalid profile response appears in `fetch errors` rather than being treated as an empty profile.

## Configuration

### 1. JSON config (recommended)

API requests use `https://api.reddit.com` without a `.json` pathname suffix and include `raw_json=1`. Public post, comment, and canonical links remain on `https://www.reddit.com`. Configure your Reddit session cookie for authenticated access in `~/.pi/agent/reddit-research.json`:

```json
{
  "cookie": "reddit_session=abc123; token_v2=def456"
}
```

Or reference a separate cookie file:

```json
{
  "cookieFile": "/home/user/.config/pi-reddit-research/cookie.txt"
}
```

**Advantages:**
- No env vars to manage
- The extension re-reads the config before requests, so you can update the cookie without restarting pi
- `cookieFile` keeps the secret outside the JSON config and shell startup files

**Security:** your Reddit cookie is a secret. Do not commit it to git or public dotfiles.

### 2. Environment variables (alternative)

| Variable | Default | Description |
| --- | --- | --- |
| `PI_REDDIT_CACHE_DIR` | `~/.cache/pi-reddit-research` | Cache directory. |
| `PI_REDDIT_SQLITE_PATH` | `$PI_REDDIT_CACHE_DIR/reddit.sqlite` | SQLite cache path. |
| `PI_REDDIT_USER_AGENT` | `pi-reddit-research/0.1 personal-use (https://www.reddit.com/.json)` | User-Agent for Reddit JSON requests. |
| `PI_REDDIT_DELAY_MS` | `1200` | Minimum delay between Reddit requests. |
| `PI_REDDIT_CACHE_TTL_MS` | `3600000` | Search/request cache TTL. |
| `PI_REDDIT_THREAD_TTL_MS` | `21600000` | Thread cache TTL. |
| `PI_REDDIT_SUBREDDIT_TTL_MS` | `604800000` | Subreddit cache TTL. |
| `PI_REDDIT_TOPIC_TTL_MS` | `2592000000` | Topic-to-subreddit cache TTL. |
| `PI_REDDIT_MAX_OUTPUT_CHARS` | `14000` | Max compact output size. |
| `PI_REDDIT_STATUS_FOOTER` | `false` | Show "Reddit: sqlite" in the TUI footer. Set to `1`, `true`, `yes`, or `on` to enable. |
| `PI_REDDIT_COOKIE` | — | Reddit session cookie value. Overrides config file. |
| `PI_REDDIT_COOKIE_FILE` | — | Path to a file with the Cookie header value. Overrides config file. |
| `PI_REDDIT_CONFIG_PATH` | `~/.pi/agent/reddit-research.json` | Path to JSON config file. |

**Cookie source priority (highest to lowest):**
1. `PI_REDDIT_COOKIE` env var
2. `PI_REDDIT_COOKIE_FILE` env var → reads file
3. `cookie` field in JSON config
4. `cookieFile` field in JSON config → reads file

## Notes

This extension uses Reddit's API JSON responses with local SQLite caching. Set your cookie in `~/.pi/agent/reddit-research.json`, via `cookieFile`, or via env vars. Cookies can expire, and Reddit can restrict access even with a configured cookie.

### Endpoint failures and cache behaviour

Normal requests detect unavailable or incompatible API endpoints; there are no background health probes:

- `REDDIT_API_UNAVAILABLE`: connection, DNS, or TLS failure. Check your network and API host availability.
- `REDDIT_API_ENDPOINT_GONE`: HTTP 410 for the requested route. API routing may need updating.
- `REDDIT_API_REDIRECT`: HTTP 3xx. Redirects are not followed, so cookies cannot be forwarded to another host; verify routing first.
- `REDDIT_API_INVALID_RESPONSE`: invalid JSON or an unexpected Listing, thread, or profile shape. The API may have changed.

These symptoms do **not** prove that Reddit deprecated the API. HTTP 401/403 still indicate an authentication/access failure, HTTP 404 can indicate a missing user/thread/route, HTTP 429 starts a `Retry-After` cooldown (300 seconds when absent/invalid), and HTTP 5xx indicates a server error. Diagnostics exclude response bodies, query strings, cookies, and redirect targets.

Invalid responses are not cached or indexed. Malformed cached payloads are ignored; empty valid Listings are still valid results. Fresh valid cache entries delay network failure detection until another network request is needed. Endpoint errors bypass stale cache, while existing authentication/rate/server-error paths may still return valid stale evidence. Failed cache rows need no manual deletion. An active in-memory cooldown must expire, or you can restart the Pi session; updating a cookie does not itself clear that cooldown.

`reddit_user` and `reddit_pack` retain partial results and expose failures in `details.errors` and a reserved `fetch errors` line. Do not treat partial evidence as a clean success.

Treat Reddit posts and comments as anecdotal evidence, not verified facts.

HTTP 403 responses with a non-empty JSON `reason` (for example `gold_only` or `private`) are reported as `Reddit denied access: <reason>` without pausing unrelated requests. This classification also applies to unknown reason strings; it assumes a JSON reason denotes a resource-specific denial. HTML, empty, malformed, or reason-less 403 responses retain block/cookie-refresh handling. HTTP 429 responses still start the process-wide rate-limit cooldown. Cooldown duration honors a positive `Retry-After`, otherwise defaults to 300 seconds; cached responses may still be served.

### How to get your Reddit cookie

1. Open a **private/incognito** browser window (to avoid unrelated cookies).
2. Go to https://www.reddit.com/login and sign in.
3. F12 → Application → Cookies → `reddit.com`.
4. **Method A (full Cookie header):** Click any cookie → Ctrl+A → Ctrl+C, then pick "Copy as string" (Chrome) or paste into an editor and join with `; `.
5. **Method B (only `reddit_session`):** Copy the value of the `reddit_session` cookie and use:

   ```bash
   # Via config file:
   echo '{"cookie": "reddit_session=YOUR_VALUE"}' > ~/.pi/agent/reddit-research.json

   # Or keep the secret in a separate file:
   mkdir -p ~/.config/pi-reddit-research
   printf '%s\n' 'reddit_session=YOUR_VALUE' > ~/.config/pi-reddit-research/cookie.txt
   printf '{"cookieFile":"%s/.config/pi-reddit-research/cookie.txt"}\n' "$HOME" > ~/.pi/agent/reddit-research.json

   # Or via env:
   export PI_REDDIT_COOKIE="reddit_session=YOUR_VALUE"
   ```

**Important:** Avoid cookies with JSON values (like `g_state={"i_l":1,...}`) — they break the JSON config file. If you copy the full Cookie header, remove entries like `g_state`, `eu_cookie`, and `seeker_session`. Only `reddit_session` and `token_v2` are needed for authentication.

The cookie expires after a few days. When that happens, just update it in the config or cookie file — pi will pick up the change automatically.

## Development and verification

Requires Node.js 22.19 or newer, matching current Pi requirements. The extension is tested against Pi 1.0.2.

```bash
npm ci
npm run check
PI_REDDIT_DELAY_MS=2000 npm run smoke:live
```

`npm run check` performs strict TypeScript checking and offline regression tests. Tests load the extension with Pi's actual loader, invoke its tools through Pi's agent loop (including argument preparation and validation), and exercise the default TUI renderer. Reddit HTTP responses and the model stream are synthetic in these tests.

The live smoke checks `old`/`qa` sorts and uses a smoke-only depth restriction to expose continuation stubs for a shared-budget check when available.

The live smoke also checks subreddit metadata/rules and isolated missing/restricted-community errors across all nine tools. Expected missing/restricted-community errors are checked for isolation rather than treated as smoke failures.

The live smoke also exercises budgeted comment expansion, a 500-comment fetch, 100-result full/compact listings and post-context fields; stopped expansions fail validation.

`npm run smoke:live` uses real Reddit HTTP with your existing cookie configuration, a fresh temporary SQLite cache, and the same Pi loader/agent loop. Only the model stream is synthetic; no LLM provider is called. Requests are paced at least two seconds apart (a larger `PI_REDDIT_DELAY_MS` is respected). It checks all nine tools, global/scoped search, API/public-link hosts, `raw_json=1` title preservation, and nonoverlapping second-page IDs for search, trends, user posts, and user comments when Reddit supplies cursors. Missing cursors are explicitly reported as unavailable checks. Deterministic offline fixtures also cover literal HTML/entity text.

The temporary cache is removed when finished; credentials are never printed. The smoke runner observes actual HTTP statuses and blocks further network requests after the first 429, even if stale-cache fallback conceals it from a tool. HTTP errors, partial tool failures, or failed assertions exit nonzero and mean live validation is blocked/failed, not accepted. It prints whether the shipped User-Agent or an environment override is in use; for final-default acceptance, unset `PI_REDDIT_USER_AGENT` before running.

Known live limitations in 0.3.0: Reddit returned a redirect for `r/all/hot` and HTTP 403 for a real `morechildren` expansion request during verification. Redirects are not followed, and failed expansions preserve initial thread evidence with an explicit error. Metadata/rules, compact listings, thread reads and `old`/`qa` sorts passed focused live checks, but the full live smoke did not pass. Endpoint availability remains subject to Reddit access restrictions.

Before publishing, run `npm run check`, `npm run smoke:live`, and `npm pack --dry-run`. Existing releases use a package version commit and an annotated `v<version>` tag. Tag and publish the approved integration commit, then verify the npm version, dist tag, `gitHead`, and tarball contents.

## License

MIT
