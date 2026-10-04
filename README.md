# pi-reddit-research

Reddit JSON research tools and a matching skill for [pi](https://github.com/mariozechner/pi), focused on compact evidence packs for opinions, bugs, fixes, comparisons, settings, alternatives, trends, guides, hardware, and real-world cases.

## Features

Registers these pi tools:

- `reddit_url_extract` — parse Reddit URLs, permalinks, post IDs, and comment IDs.
- `reddit_resolve_subreddits` — find and rank subreddit candidates for a topic.
- `reddit_pack` — build a compact evidence pack from posts and top comments.
- `reddit_search` — search Reddit posts without fetching full comment threads.
- `reddit_thread` — fetch one thread and top comments.
- `reddit_user` — check a public account: age, karma, account signals, recent posts and comments.
- `reddit_subreddits` — raw subreddit search.
- `reddit_trends` — inspect hot/top/new posts in one or more subreddits.

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

`reddit_user` fetches `/user/<name>/about.json`, `/submitted.json`, and `/comments.json`:

```
reddit_user(username: "u/foo", sections: "about,posts", limit: 10)
reddit_user(username: "https://www.reddit.com/user/foo/comments/", sections: "comments", limit: 25)
reddit_user(username: "foo", sections: "comments", limit: 25, after_comments: "t1_xyz789")
```

Sections are comma-separated (`about`, `posts`, `comments`), default `about,posts`. The `limit` applies to posts and comments alike. Account age and karma are weak signals, not proof of expertise.

Individual section failures do not abort the call: a suspended, deleted, private, or misspelled account produces whatever sections did resolve plus a `fetch errors` line. A string that cannot be a Reddit username at all (over 20 characters, shorter than a real username, or containing characters other than letters, digits, `_`, `-`) is rejected with a specific `Reddit usernames are at most 20 characters` / `too short` / `not a valid Reddit username` error instead of a pointless request. Because Reddit answers `/user/<name>/about.json` with HTTP 200 for banned and suspended accounts (no `is_suspended` flag), the tool reports `no public profile page for this account` when Reddit returns no profile object.

## Configuration

### 1. JSON config (recommended)

Since mid-2026, Reddit requires authentication for `.json` access. Create `~/.pi/agent/reddit-research.json`:

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

This extension uses Reddit's `.json` endpoints with local SQLite caching. **Since mid-2026, Reddit requires authentication for `.json` access.** Set your cookie in `~/.pi/agent/reddit-research.json`, via `cookieFile`, or via env vars to restore functionality.

Treat Reddit posts and comments as anecdotal evidence, not verified facts.

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
npm run smoke:live
```

`npm run check` performs strict TypeScript checking and offline regression tests. Tests load the extension with Pi's actual loader, invoke its tools through Pi's agent loop (including argument preparation and validation), and exercise the default TUI renderer. Reddit HTTP responses and the model stream are synthetic in these tests.

`npm run smoke:live` uses real Reddit HTTP with your existing cookie configuration, a fresh temporary SQLite cache, and the same Pi loader/agent loop. Only the model stream is synthetic; no LLM provider is called. It checks all eight tools and verifies that page two does not overlap page one for search, trends, user posts, and user comments when Reddit supplies cursors. The temporary cache is removed when finished; credentials are never printed. It exits nonzero on HTTP errors, partial user-section errors, or failed assertions.

Before publishing, run `npm run check`, `npm run smoke:live`, and `npm pack --dry-run`. Existing releases use a package version commit and an annotated `v<version>` tag. Tag and publish the approved integration commit, then verify the npm version, dist tag, `gitHead`, and tarball contents.

## License

MIT
