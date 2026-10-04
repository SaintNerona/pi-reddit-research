---
name: reddit-research
description: Use Reddit JSON research tools to find compact evidence about user opinions, bugs, fixes, comparisons, settings, alternatives, trends, guides, hardware, and real-world cases.
---

# Reddit Research

Use the local Reddit tools when the user asks what people on Reddit say, recommend, complain about, compare, or use in real practice.

## Tool Choice

- Use `reddit_pack` for most research questions. It searches posts and fetches top comments for a small evidence pack.
- Use `reddit_search` when you only need candidate posts or want to find whether a topic/repo/error was discussed.
- Use `reddit_thread` when the user gives a Reddit URL or one thread from `reddit_search` looks important.
- Use `reddit_user` when a claim's trustworthiness matters, when the user names an account, or when the strongest evidence rests on one or two accounts.
- Use `reddit_resolve_subreddits` when the user asks where a topic is discussed or when a focused subreddit scope would improve search.
- Use `reddit_subreddits` only for raw subreddit search when ranking is not needed.
- Use `reddit_url_extract` when the user gives an arbitrary Reddit URL, old.reddit URL, post id, or comment id.
- Use `reddit_trends` for "what is currently hot/top/new in r/LocalLLaMA" style questions.

## Intent Mapping

- opinions: "what do people think", product/tool sentiment, praise vs criticism.
- bugs: frequent problems, complaints, failure modes, risks.
- fixes: how people solved an error or configuration issue.
- compare: A vs B, which tool users pick, migration reasons.
- settings: sampler, scheduler, config, parameters, low denoise, hardware settings.
- alternatives: replacements for a library, service, app, or workflow.
- trends: what topics are surfacing recently.
- guides: tutorials, walkthroughs, reproducible setup posts.
- hardware: devices, VRAM/RAM, speed, thermals, purchase advice.
- general: fallback for broad Reddit research.

## Depth

- `quick`: first-pass orientation; fewer posts and comments.
- `normal`: default for most user questions.
- `deep`: use only when the user asks for thorough research; it fetches more comments and costs more tokens/time.

## Pagination

Listing tools return a `next page: pass after=...` line when Reddit supplied a cursor.

- `reddit_search`, `reddit_trends`, `reddit_subreddits`, `reddit_user`, and `reddit_pack` accept a cursor.
- Reuse it with the same query/scope/sort/time (and the same `username` for `reddit_user`); changing any of those invalidates the cursor.
- One page is usually enough. Fetch a second page only when the first page is thin, the user asks for more, or a claim needs more evidence.
- Reddit does not error on a bad cursor: it returns HTTP 200 with the same page and the same cursor again. So do not retry the same cursor expecting progress, and do not invent cursor values.
- `reddit_search` and `reddit_trends` only accept a single cursor for a single-subreddit scope (search also supports all-Reddit scope). With several subreddits the cursor is ignored and the output says so. Follow the per-subreddit instructions in the text or `cursors.per_subreddit`: a safe `after` advances only past a contiguous prefix of returned posts; `restart: true` means re-run that subreddit without `after` to recover unreturned posts. Narrow to one subreddit and deduplicate by post ID, because local ranking may repeat posts.
- `reddit_user` uses `after_posts` (from `more posts: pass after_posts=t3_...`) and `after_comments` (from `more comments: pass after_comments=t1_...`). Mixing them up is rejected with a note instead of silently repeating page one.

## Source Credibility

- `reddit_user` returns account age, karma, account signals (verified, employee, moderator), recent posts, and recent comments.
- Use it to check whether a strong claim comes from a long-standing account or a throwaway, and to see what else that author said.
- Account age and karma are weak signals. Never present them as proof of expertise, honesty, or correctness; describe them as signals and say what you observed.
- When the output says `no public profile page for this account`, say so and treat its comments with extra caution; Reddit returns no profile object for suspended, banned, and shadowbanned accounts.
- A single high-vote comment is one data point. If the conclusion depends on it, check the author and look for corroborating accounts.

## Answering Rules

- When a tool has a `subreddits` parameter, pass multiple subreddits as one comma-separated string like `LocalLLaMA, LocalLLM, ClaudeCode`, not as a JSON/list value.
- Pass `sections` to `reddit_user` as a comma-separated string too, for example `about,comments`.
- Treat Reddit as anecdotal evidence, not truth.
- Separate repeated patterns from one-off comments.
- Mention uncertainty when evidence is thin or old.
- Cite evidence by post number, subreddit, or thread URL from tool output.
- Prefer concrete details from comments: versions, commands, settings, hardware, exact error text, and final outcome.
- For comparisons, group findings by option and distinguish direct user experience from speculation.
- Do not invent subscriber counts, trend numbers, score totals, or popularity claims unless the tool output includes them.
- Use `evidence_items` and clusters from `reddit_pack` as hints, not as final truth.
