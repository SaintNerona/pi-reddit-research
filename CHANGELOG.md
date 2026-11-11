# Changelog

## Unreleased

### Added

- Native rising/controversial discovery ordering and explicit ranked/native trend selection.
- Up to 100 search/trend results, compact listing output, external destinations and sticky/video/self-post context.
- `reddit_subreddit_info` for metadata and optional rules of up to five named communities, with bounded fields, isolated errors and a seven-day cache. Rules default on and add at most one request per successful metadata lookup.
- Opt-in `reddit_thread` comment expansion and completeness reporting, building on PR #5: `comment_limit` accepts up to 500, while `expand_more` defaults to 0 and caps actual extra HTTP attempts at 5.
- Continue-thread lookups within that same budget, after ordinary hidden-child IDs. Each valid parent is attempted once per call; cached responses served without a fetch spend no budget.
- `old` and `qa` comment sorts across the initial fetch, child batches and continuations. The default remains `top`; displayed `top_comments` still selects highest-score comments from the fetched set.
- `stubs_resolved` and `unresolved_stubs` reporting, plus fixture and live-smoke coverage of continuation expansion and the additional sorts. Unresolved counts remain lower bounds, not proof of complete thread coverage.

### Fixed

- Route requests through `api.reddit.com`, reject redirects and incompatible live/cached payloads, and surface sanitized endpoint and partial-tool failures.
- Resource-specific JSON 403 denials no longer start a global cooldown; block pages and HTTP 429 retain cooldown handling.
- Rebase continuation subtree depths against known parents when Reddit resets or omits depth information. Distinguish inferred depths from explicit comment/hidden-branch depths, preserving usable absolute depths even when ancestor depths are absent or bodies deleted.
- Reject malformed continuation reply containers without clearing unresolved stubs; retain valid empty replies and Reddit's empty-string sentinel.
- Validate both child-batch and continuation envelopes before updating indexed evidence, preventing malformed or wrong-post responses from overwriting existing comment ownership. Preserve already loaded evidence on failures or cancellation.

### Notes

- `reddit_pack` does not opt into expansion; comment-permalink subtree routing is not added.
- No new dependencies, database migrations, authentication settings or write operations. The package version remains 0.2.0; these changes have not been released.
