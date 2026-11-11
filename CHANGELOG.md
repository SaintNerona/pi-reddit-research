# Changelog

## Unreleased

### Added

- `reddit_subreddit_info` for metadata and optional rules of up to five named communities. Accepts comma-separated names, optional `r/` prefixes and case-insensitive deduplication; validates input before HTTP.
- Available descriptions, subscriber count, creation time/age, NSFW/access signals, language and submission type. Missing optional values remain unknown; active/online-user counts are omitted.
- Up to ten valid rules per community, with bounded names/descriptions and the API's total rule-entry count. Rules default on; `include_rules=false` requests metadata only.
- Per-community error isolation, preservation of metadata when rules fail, cancellation support and error summaries that survive output truncation. HTTP-200 listings returned for missing names are rejected as malformed metadata.
- README examples, bundled research guidance, offline fixtures and live smoke coverage for metadata/rules, caching, restricted/missing communities and partial failures.

### Notes

- Reuses the existing serial request queue and seven-day metadata cache; at most ten uncached requests for five successful communities with rules enabled.
- Requires the resource-specific 403 handling from PR #4; independent of the comment-expansion work in PR #5.
- No new dependencies, database migrations, authentication changes or write operations. The package version remains 0.2.0; these changes have not been released.
