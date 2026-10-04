import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const redditBaseUrl = "https://www.reddit.com";
const cacheDir = process.env.PI_REDDIT_CACHE_DIR ?? join(homedir(), ".cache", "pi-reddit-research");
const sqlitePath = process.env.PI_REDDIT_SQLITE_PATH ?? join(cacheDir, "reddit.sqlite");
const userAgent =
	process.env.PI_REDDIT_USER_AGENT ??
	"pi-reddit-research/0.1 personal-use (https://www.reddit.com/.json)";

// Reddit session cookie support.
// Priority: PI_REDDIT_COOKIE env > PI_REDDIT_COOKIE_FILE env > "cookie" in config.json > "cookieFile" in config.json
const redditConfigPath =
	process.env.PI_REDDIT_CONFIG_PATH ??
	join(homedir(), ".pi", "agent", "reddit-research.json");

interface RedditConfig {
	cookie?: string;
	cookieFile?: string;
}

function readRedditConfig(): RedditConfig | undefined {
	try {
		const raw = readFileSync(redditConfigPath, "utf-8").trim();
		if (!raw) return undefined;
		return JSON.parse(raw) as RedditConfig;
	} catch {
		return undefined;
	}
}

function loadRedditCookie(): string | undefined {
	// env vars always win (and don't stale)
	if (process.env.PI_REDDIT_COOKIE) return process.env.PI_REDDIT_COOKIE;
	if (process.env.PI_REDDIT_COOKIE_FILE) {
		try {
			return readFileSync(process.env.PI_REDDIT_COOKIE_FILE, "utf-8").trim();
		} catch {
			return undefined;
		}
	}
	// config file — re-read every time when asked (enables updating cookie without restart)
	const config = readRedditConfig();
	if (config?.cookie) return config.cookie;
	if (config?.cookieFile) {
		try {
			return readFileSync(config.cookieFile, "utf-8").trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

let redditCookie = loadRedditCookie();

const requestDelayMs = Math.max(250, Number(process.env.PI_REDDIT_DELAY_MS ?? 1200));
const defaultTtlMs = Math.max(30_000, Number(process.env.PI_REDDIT_CACHE_TTL_MS ?? 60 * 60_000));
const threadTtlMs = Math.max(30_000, Number(process.env.PI_REDDIT_THREAD_TTL_MS ?? 6 * 60 * 60_000));
const subredditTtlMs = Math.max(30_000, Number(process.env.PI_REDDIT_SUBREDDIT_TTL_MS ?? 7 * 24 * 60 * 60_000));
const topicTtlMs = Math.max(30_000, Number(process.env.PI_REDDIT_TOPIC_TTL_MS ?? 30 * 24 * 60 * 60_000));
const maxOutputChars = Math.max(2000, Number(process.env.PI_REDDIT_MAX_OUTPUT_CHARS ?? 14_000));
const showStatusFooter = ["1", "true", "yes", "on"].includes((process.env.PI_REDDIT_STATUS_FOOTER ?? "").toLowerCase());

type JsonObject = Record<string, unknown>;
type RedditSort = "relevance" | "hot" | "top" | "new" | "comments";
type RedditTime = "hour" | "day" | "week" | "month" | "year" | "all";
type RedditDepth = "quick" | "normal" | "deep";
type RedditIntent =
	| "opinions"
	| "bugs"
	| "fixes"
	| "compare"
	| "settings"
	| "alternatives"
	| "trends"
	| "guides"
	| "hardware"
	| "general";

const sorts = new Set<RedditSort>(["relevance", "hot", "top", "new", "comments"]);
const times = new Set<RedditTime>(["hour", "day", "week", "month", "year", "all"]);
const depths = new Set<RedditDepth>(["quick", "normal", "deep"]);
const intents = new Set<RedditIntent>([
	"opinions",
	"bugs",
	"fixes",
	"compare",
	"settings",
	"alternatives",
	"trends",
	"guides",
	"hardware",
	"general",
]);

let lastRequestAt = 0;
let cooldownUntil = 0;

const knownSubredditPriority = new Map<string, number>([
	["localllama", 14],
	["localllm", 12],
	["claudecode", 10],
	["claudeai", 8],
	["opencodecli", 8],
	["ollama", 7],
	["mcpservers", 7],
	["vibecoding", 6],
	["comfyui", 6],
	["stablediffusion", 5],
]);

type EvidenceCluster =
	| "praise"
	| "complaints"
	| "fixes"
	| "settings"
	| "hardware"
	| "alternatives"
	| "guides"
	| "risks"
	| "general";

interface RedditPost {
	id: string;
	fullname: string;
	subreddit: string;
	title: string;
	author: string;
	score: number;
	numComments: number;
	createdUtc: number;
	age: string;
	permalink: string;
	url: string;
	domain: string;
	flair: string;
	selftext: string;
	over18: boolean;
	rankScore?: number;
	rankReasons?: string[];
}

interface RedditComment {
	id: string;
	author: string;
	score: number;
	body: string;
	depth: number;
	createdUtc?: number;
	url?: string;
	parentId?: string;
	subreddit?: string;
}

interface EvidenceItem {
	kind: "post" | "comment";
	cluster: EvidenceCluster;
	post_id: string;
	post_index: number;
	subreddit: string;
	score: number;
	url: string;
	text: string;
	reason: string;
}

interface SubredditCandidate {
	subreddit: string;
	score: number;
	reasons: string[];
	title?: string;
	public_description?: string;
	subscribers?: number;
}

interface RedditUrlParts {
	kind: "post" | "comment" | "subreddit" | "user" | "unknown";
	subreddit?: string;
	post_id?: string;
	comment_id?: string;
	username?: string;
	multireddit?: string;
	canonical_url?: string;
}

function ensureCacheDir() {
	mkdirSync(cacheDir, { recursive: true });
}

class RedditStore {
	private db: DatabaseSync;

	constructor(path: string) {
		ensureCacheDir();
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS requests (
				url TEXT PRIMARY KEY,
				status INTEGER,
				saved_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				raw_json TEXT,
				error TEXT
			);
			CREATE TABLE IF NOT EXISTS posts (
				id TEXT PRIMARY KEY,
				subreddit TEXT,
				title TEXT,
				selftext_excerpt TEXT,
				score INTEGER,
				num_comments INTEGER,
				created_utc REAL,
				url TEXT,
				permalink TEXT,
				flair TEXT,
				author TEXT,
				over_18 INTEGER,
				rank_score REAL,
				rank_reasons TEXT,
				crawled_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS comments (
				id TEXT PRIMARY KEY,
				post_id TEXT,
				author TEXT,
				score INTEGER,
				body_excerpt TEXT,
				depth INTEGER,
				created_utc REAL,
				url TEXT,
				saved_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS subreddits (
				display_name TEXT PRIMARY KEY,
				title TEXT,
				public_description TEXT,
				subscribers INTEGER,
				saved_at INTEGER
			);
			CREATE TABLE IF NOT EXISTS search_results (
				query_key TEXT,
				post_id TEXT,
				rank_score REAL,
				rank_reasons TEXT,
				saved_at INTEGER,
				PRIMARY KEY (query_key, post_id)
			);
			CREATE TABLE IF NOT EXISTS topic_subreddit_scores (
				topic_key TEXT,
				subreddit TEXT,
				score REAL,
				reasons TEXT,
				saved_at INTEGER,
				PRIMARY KEY (topic_key, subreddit)
			);
		`);
	}

	getRequest(url: string, allowStale = false) {
		const row = this.db.prepare("SELECT raw_json, expires_at FROM requests WHERE url = ?").get(url) as
			| { raw_json: string; expires_at: number }
			| undefined;
		if (!row || !row.raw_json) return undefined;
		if (!allowStale && row.expires_at < Date.now()) return undefined;
		try {
			return JSON.parse(row.raw_json);
		} catch {
			return undefined;
		}
	}

	saveRequest(url: string, status: number, ttlMs: number, data: unknown, error?: string) {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO requests (url, status, saved_at, expires_at, raw_json, error)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(url) DO UPDATE SET
				 status = excluded.status,
				 saved_at = excluded.saved_at,
				 expires_at = excluded.expires_at,
				 raw_json = excluded.raw_json,
				 error = excluded.error`,
			)
			.run(url, status, now, now + ttlMs, data === undefined ? null : JSON.stringify(data), error ?? null);
	}

	savePosts(posts: RedditPost[]) {
		const statement = this.db.prepare(
			`INSERT INTO posts (
				id, subreddit, title, selftext_excerpt, score, num_comments, created_utc,
				url, permalink, flair, author, over_18, rank_score, rank_reasons, crawled_at
			 )
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 subreddit = excluded.subreddit,
			 title = excluded.title,
			 selftext_excerpt = excluded.selftext_excerpt,
			 score = excluded.score,
			 num_comments = excluded.num_comments,
			 created_utc = excluded.created_utc,
			 url = excluded.url,
			 permalink = excluded.permalink,
			 flair = excluded.flair,
			 author = excluded.author,
			 over_18 = excluded.over_18,
			 rank_score = excluded.rank_score,
			 rank_reasons = excluded.rank_reasons,
			 crawled_at = excluded.crawled_at`,
		);
		const now = Date.now();
		for (const post of posts) {
			statement.run(
				post.id,
				post.subreddit,
				post.title,
				compactWhitespace(post.selftext, 700),
				post.score,
				post.numComments,
				post.createdUtc,
				post.url,
				post.permalink,
				post.flair,
				post.author,
				post.over18 ? 1 : 0,
				post.rankScore ?? null,
				JSON.stringify(post.rankReasons ?? []),
				now,
			);
		}
	}

	saveComments(postId: string, postUrl: string, comments: RedditComment[]) {
		const statement = this.db.prepare(
			`INSERT INTO comments (id, post_id, author, score, body_excerpt, depth, created_utc, url, saved_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 post_id = excluded.post_id,
			 author = excluded.author,
			 score = excluded.score,
			 body_excerpt = excluded.body_excerpt,
			 depth = excluded.depth,
			 created_utc = excluded.created_utc,
			 url = excluded.url,
			 saved_at = excluded.saved_at`,
		);
		const now = Date.now();
		for (const comment of comments) {
			const url = comment.url ?? `${postUrl}${comment.id ? `${comment.id}/` : ""}`;
			statement.run(
				comment.id,
				postId,
				comment.author,
				comment.score,
				compactWhitespace(comment.body, 700),
				comment.depth,
				comment.createdUtc ?? null,
				url,
				now,
			);
		}
	}

	saveSubreddits(items: JsonObject[]) {
		const statement = this.db.prepare(
			`INSERT INTO subreddits (display_name, title, public_description, subscribers, saved_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(display_name) DO UPDATE SET
			 title = excluded.title,
			 public_description = excluded.public_description,
			 subscribers = excluded.subscribers,
			 saved_at = excluded.saved_at`,
		);
		const now = Date.now();
		for (const item of items) {
			const name = optionalString(item.display_name);
			if (!name) continue;
			statement.run(
				name,
				optionalString(item.title) ?? "",
				optionalString(item.public_description) ?? "",
				optionalNumber(item.subscribers) ?? null,
				now,
			);
		}
	}

	saveSearchResults(queryKey: string, posts: RedditPost[]) {
		const statement = this.db.prepare(
			`INSERT INTO search_results (query_key, post_id, rank_score, rank_reasons, saved_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(query_key, post_id) DO UPDATE SET
			 rank_score = excluded.rank_score,
			 rank_reasons = excluded.rank_reasons,
			 saved_at = excluded.saved_at`,
		);
		const now = Date.now();
		for (const post of posts) {
			statement.run(queryKey, post.id, post.rankScore ?? 0, JSON.stringify(post.rankReasons ?? []), now);
		}
	}

	getTopicSubreddits(topicKey: string, maxAgeMs: number) {
		const rows = this.db
			.prepare("SELECT subreddit, score, reasons, saved_at FROM topic_subreddit_scores WHERE topic_key = ? ORDER BY score DESC")
			.all(topicKey) as { subreddit: string; score: number; reasons: string; saved_at: number }[];
		const now = Date.now();
		if (!rows.length || rows.some((row) => now - row.saved_at > maxAgeMs)) return undefined;
		return rows.map((row) => ({
			subreddit: row.subreddit,
			score: row.score,
			reasons: parseJsonArray(row.reasons),
		}));
	}

	saveTopicSubreddits(topicKey: string, candidates: SubredditCandidate[]) {
		const statement = this.db.prepare(
			`INSERT INTO topic_subreddit_scores (topic_key, subreddit, score, reasons, saved_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(topic_key, subreddit) DO UPDATE SET
			 score = excluded.score,
			 reasons = excluded.reasons,
			 saved_at = excluded.saved_at`,
		);
		const now = Date.now();
		for (const candidate of candidates) {
			statement.run(topicKey, candidate.subreddit, candidate.score, JSON.stringify(candidate.reasons), now);
		}
	}
}

const store = new RedditStore(sqlitePath);

function normalizeString(value: unknown) {
	if (typeof value !== "string") return value;
	let normalized = value.trim();
	for (let i = 0; i < 2; i++) {
		if (
			(normalized.startsWith('"') && normalized.endsWith('"')) ||
			(normalized.startsWith("'") && normalized.endsWith("'"))
		) {
			normalized = normalized.slice(1, -1).trim();
		}
	}
	return normalized;
}

function optionalString(value: unknown) {
	const normalized = normalizeString(value);
	return typeof normalized === "string" && normalized.length > 0 ? normalized : undefined;
}

function optionalNumber(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(normalizeString(value));
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
	const parsed = Math.trunc(optionalNumber(value) ?? fallback);
	return Math.min(max, Math.max(min, parsed));
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
	const normalized = optionalString(value)?.toLowerCase();
	return normalized && allowed.has(normalized as T) ? (normalized as T) : fallback;
}

function boolValue(value: unknown, fallback: boolean) {
	if (typeof value === "boolean") return value;
	const normalized = optionalString(value)?.toLowerCase();
	if (["true", "yes", "1", "on"].includes(normalized ?? "")) return true;
	if (["false", "no", "0", "off"].includes(normalized ?? "")) return false;
	return fallback;
}

function stringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.flatMap((item) => stringList(item) ?? []);
		return items.length ? items : undefined;
	}
	const normalized = optionalString(value);
	if (!normalized) return undefined;
	const items = normalized
		.split(/[,\n]/)
		.map((item) =>
			item
				.replace(/^[\s*+-]+/, "")
				.replace(/^r\//i, "")
				.trim(),
		)
		.filter(Boolean);
	return items.length ? items : undefined;
}

function stringListParam(value: unknown): string | undefined {
	const items = stringList(value);
	return items?.length ? items.join(",") : undefined;
}

function textResult(text: string, details?: unknown, navigation = "") {
	return {
		content: [{ type: "text" as const, text: limitOutput(text, navigation) }],
		details,
	};
}

function limitOutput(text: string, navigation = "") {
	// Reserve complete navigation lines before truncating the evidence body. Pi sends content
	// to the model, while details are mainly for renderers and programmatic consumers.
	const navigationLines: string[] = [];
	const navigationBudget = Math.floor(maxOutputChars / 2);
	for (const line of navigation.split("\n").filter(Boolean)) {
		if ([...navigationLines, line].join("\n").length > navigationBudget - 80) {
			navigationLines.push("Additional pagination instructions are in details.cursors.");
			break;
		}
		navigationLines.push(line);
	}
	const footer = navigationLines.length ? `\n\n${navigationLines.join("\n")}` : "";
	const bodyBudget = maxOutputChars - footer.length;
	if (text.length <= bodyBudget) return text + footer;
	const note = `\n\n[truncated to ${maxOutputChars} chars; narrow the query or use reddit_thread for a specific post]`;
	return text.slice(0, Math.max(0, bodyBudget - note.length)).trimEnd() + note + footer;
}

function compactWhitespace(text: unknown, max = 360) {
	const normalized = String(text ?? "")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function ageFromUtc(createdUtc: number) {
	if (!createdUtc) return "?";
	const diff = Math.max(0, Date.now() / 1000 - createdUtc);
	if (diff < 3600) return `${Math.floor(diff / 60)}m`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
	if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
	if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
	return `${Math.floor(diff / (86400 * 365))}y`;
}

function redditUrl(path: string) {
	if (path.startsWith("http://") || path.startsWith("https://")) return path;
	return `${redditBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function addRawJson(path: string) {
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}raw_json=1`;
}

function setCooldownFromResponse(response: Response) {
	const retryAfter = Number(response.headers.get("retry-after"));
	const cooldownSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 300;
	cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownSeconds * 1000);
}

function normalizeRequestUrl(path: string) {
	const url = new URL(redditUrl(addRawJson(path)));
	const params = [...url.searchParams.entries()].sort(([aKey, aVal], [bKey, bVal]) => {
		const keyCmp = aKey.localeCompare(bKey);
		return keyCmp || aVal.localeCompare(bVal);
	});
	url.search = "";
	for (const [key, value] of params) url.searchParams.append(key, value);
	return url.toString();
}

function parseJsonArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String);
	if (typeof value !== "string") return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

class RedditRequestQueue {
	private tail: Promise<unknown> = Promise.resolve();

	async fetchJson(path: string, ttlMs = defaultTtlMs, signal?: AbortSignal) {
		const url = normalizeRequestUrl(path);
		const fresh = store.getRequest(url);
		if (fresh !== undefined) return fresh;

		const task = this.tail.then(() => this.fetchNow(url, ttlMs, signal));
		this.tail = task.catch(() => undefined);
		return task;
	}

	private async fetchNow(url: string, ttlMs: number, signal?: AbortSignal) {
		const fresh = store.getRequest(url);
		if (fresh !== undefined) return fresh;

		const cooldownMs = cooldownUntil - Date.now();
		if (cooldownMs > 0) {
			const stale = store.getRequest(url, true);
			if (stale !== undefined) return stale;
			throw new Error(`Reddit JSON is cooling down for ${Math.ceil(cooldownMs / 1000)}s after a rate-limit/block response.`);
		}

		const waitMs = lastRequestAt + requestDelayMs - Date.now();
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		lastRequestAt = Date.now();
		redditCookie = loadRedditCookie();

		const headers: Record<string, string> = {
			"user-agent": userAgent,
			accept: "application/json,text/plain,*/*",
			"accept-language": "en-US,en;q=0.9",
		};
		if (redditCookie) {
			headers["cookie"] = redditCookie;
		}
		const response = await fetch(url, {
			signal,
			headers,
			redirect: "follow",
		});

		if (response.status === 403 || response.status === 429) {
			// Forbidden: try refreshing the cookie from config in case it was updated
			if (response.status === 403) {
				const previousCookie = redditCookie;
				redditCookie = loadRedditCookie();
				if (redditCookie && redditCookie !== previousCookie) {
					// Cookie was refreshed in config — don't set cooldown, agent will retry
					store.saveRequest(url, response.status, ttlMs, undefined, "Reddit 403; cookie refreshed from config, retrying...");
					throw new Error("Reddit JSON HTTP 403; cookie refreshed from config — retry the request.");
				}
			}
			setCooldownFromResponse(response);
			const stale = store.getRequest(url, true);
			if (stale !== undefined) return stale;
			const cookieHint = !redditCookie
				? " Reddit no longer serves .json to unauthenticated clients. Set a cookie in ~/.pi/agent/reddit-research.json, or use PI_REDDIT_COOKIE env var."
				: " Your Reddit session cookie may be expired. Update it in your config and retry.";
			store.saveRequest(url, response.status, ttlMs, undefined, `Reddit JSON HTTP ${response.status}; cooldown started.`);
			throw new Error(`Reddit JSON HTTP ${response.status}; cooldown started.${cookieHint}`);
		}
		if (!response.ok) {
			const text = await response.text();
			const error = `Reddit JSON HTTP ${response.status}: ${compactWhitespace(text, 240)}`;
			const stale = store.getRequest(url, true);
			if (stale !== undefined) return stale;
			store.saveRequest(url, response.status, ttlMs, undefined, error);
			throw new Error(error);
		}

		const data = await response.json();
		store.saveRequest(url, response.status, ttlMs, data);
		indexRedditPayload(data);
		return data;
	}
}

const requestQueue = new RedditRequestQueue();

async function fetchRedditJson(path: string, ttlMs = defaultTtlMs, signal?: AbortSignal) {
	return requestQueue.fetchJson(path, ttlMs, signal);
}

function listingChildren(data: unknown) {
	const root = data as JsonObject;
	const listing = root.data as JsonObject | undefined;
	return Array.isArray(listing?.children) ? (listing.children as JsonObject[]) : [];
}

interface ListingCursor {
	after?: string;
	// No leading items were returned: start this subreddit again without a cursor.
	restart?: boolean;
}

interface ListingCursors extends ListingCursor {
	per_subreddit?: Record<string, ListingCursor>;
	after_ignored?: boolean;
}

function listingCursor(data: unknown): ListingCursor {
	const root = data as JsonObject | undefined;
	const listing = root?.data as JsonObject | undefined;
	return { after: optionalString(listing?.after) };
}

function returnedListingCursors(listings: { key: string; data: unknown }[], posts: RedditPost[], afterIgnored = false): ListingCursors {
	if (listings.length === 1) return listingCursor(listings[0].data);
	const returned = new Set(posts.map((post) => post.id));
	const perSubreddit: Record<string, ListingCursor> = {};
	for (const { key, data } of listings) {
		const fetched = parsePosts(data);
		const firstUnreturned = fetched.findIndex((post) => !returned.has(post.id));
		// Ranking can put a later item ahead of an earlier one. Only advance over the
		// contiguous returned prefix; advancing to Reddit's page end would lose evidence.
		perSubreddit[key] = firstUnreturned === -1 ? listingCursor(data)
			: firstUnreturned === 0 ? { restart: true }
				: { after: fetched[firstUnreturned - 1].fullname };
	}
	return { per_subreddit: perSubreddit, after_ignored: afterIgnored || undefined };
}

function listingNavigation(cursors: ListingCursors, context: string) {
	const lines: string[] = [];
	if (cursors.after_ignored) lines.push("after was ignored because multiple subreddits were requested; re-run with one subreddit to paginate");
	if (cursors.after) lines.push(`next page: pass after=${cursors.after} with the same ${context}`);
	if (cursors.per_subreddit) {
		for (const [subreddit, cursor] of Object.entries(cursors.per_subreddit)) {
			if (cursor.restart) lines.push(`r/${subreddit}: re-run with subreddits=${subreddit} without after (unreturned posts remain)`);
			else if (cursor.after) lines.push(`r/${subreddit}: next page: pass subreddits=${subreddit} and after=${cursor.after} with the same ${context}`);
		}
		if (lines.length) lines.push("Narrow to one subreddit to continue; locally ranked pages may repeat previously returned posts. Deduplicate by post id.");
	}
	return lines.join("\n");
}

async function fetchPagedListings(entries: { key: string; path: string }[], ttlMs: number, signal?: AbortSignal) {
	const listings: { key: string; data: unknown }[] = [];
	for (const entry of entries) {
		const data = await fetchRedditJson(entry.path, ttlMs, signal);
		listings.push({ key: entry.key, data });
	}
	return { listings };
}

function parsePost(child: JsonObject): RedditPost | undefined {
	if (child.kind !== "t3" || !child.data || typeof child.data !== "object") return undefined;
	const data = child.data as JsonObject;
	const id = String(data.id ?? "").trim();
	if (!id) return undefined;
	const permalink = String(data.permalink ?? `/comments/${id}/`);
	const createdUtc = Number(data.created_utc ?? 0);
	return {
		id,
		fullname: String(data.name ?? `t3_${id}`),
		subreddit: String(data.subreddit ?? ""),
		title: String(data.title ?? ""),
		author: String(data.author ?? "unknown"),
		score: Number(data.score ?? 0),
		numComments: Number(data.num_comments ?? 0),
		createdUtc,
		age: ageFromUtc(createdUtc),
		permalink,
		url: redditUrl(permalink),
		domain: String(data.domain ?? ""),
		flair: String(data.link_flair_text ?? ""),
		selftext: String(data.selftext ?? ""),
		over18: Boolean(data.over_18),
	};
}

function parsePosts(listing: unknown) {
	return listingChildren(listing).map(parsePost).filter((post): post is RedditPost => !!post);
}

function flattenComments(children: JsonObject[], depth = 0, out: RedditComment[] = []) {
	for (const child of children) {
		if (child.kind === "t1" && child.data && typeof child.data === "object") {
			const data = child.data as JsonObject;
			const body = String(data.body ?? "").trim();
			if (body && body !== "[deleted]" && body !== "[removed]") {
				out.push({
					id: String(data.id ?? data.name ?? ""),
					author: String(data.author ?? "unknown"),
					score: Number(data.score ?? 0),
					body,
					depth,
					createdUtc: Number(data.created_utc ?? 0),
					url: optionalString(data.permalink) ? redditUrl(String(data.permalink)) : undefined,
					parentId: optionalString(data.parent_id),
					subreddit: optionalString(data.subreddit),
				});
			}
			const replies = data.replies;
			if (replies && typeof replies === "object") {
				const replyChildren = (((replies as JsonObject).data as JsonObject | undefined)?.children ?? []) as JsonObject[];
				flattenComments(replyChildren, depth + 1, out);
			}
		}
	}
	return out;
}

function parseThread(data: unknown) {
	const items = Array.isArray(data) ? data : [];
	const posts = parsePosts(items[0]);
	const post = posts[0];
	const commentChildren = listingChildren(items[1]);
	return {
		post,
		comments: flattenComments(commentChildren),
	};
}

function indexRedditPayload(data: unknown) {
	if (Array.isArray(data)) {
		const thread = parseThread(data);
		if (thread.post) {
			store.savePosts([thread.post]);
			store.saveComments(thread.post.id, thread.post.url, thread.comments);
		}
		return;
	}

	const posts = parsePosts(data);
	if (posts.length) store.savePosts(posts);

	const subs = listingChildren(data)
		.map((child) => (child.kind === "t5" && child.data && typeof child.data === "object" ? (child.data as JsonObject) : undefined))
		.filter((item): item is JsonObject => !!item);
	if (subs.length) store.saveSubreddits(subs);
}

function extractPostId(urlOrId: string) {
	const value = urlOrId.trim();
	const direct = value.match(/^(?:t3_)?([a-z0-9]{5,12})$/i);
	if (direct) return direct[1];
	const fromUrl = value.match(/\/comments\/([a-z0-9]{5,12})(?:\/|$)/i);
	return fromUrl?.[1];
}

function extractRedditUrl(urlOrId: string): RedditUrlParts {
	const value = String(normalizeString(urlOrId) ?? "").trim();
	const directPost = value.match(/^(?:t3_)?([a-z0-9]{5,12})$/i);
	if (directPost) {
		return {
			kind: "post",
			post_id: directPost[1],
			canonical_url: `${redditBaseUrl}/comments/${directPost[1]}/`,
		};
	}
	const directComment = value.match(/^t1_([a-z0-9]{5,12})$/i);
	if (directComment) return { kind: "comment", comment_id: directComment[1] };

	let url: URL;
	try {
		url = value.startsWith("/") ? new URL(value, redditBaseUrl) : new URL(value);
	} catch {
		return { kind: "unknown" };
	}

	const path = url.pathname.replace(/\/+$/, "");
	const post = path.match(/\/r\/([^/]+)\/comments\/([a-z0-9]{5,12})(?:\/[^/]+)?(?:\/([a-z0-9]{5,12}))?/i);
	if (post) {
		const canonical = `${redditBaseUrl}/r/${post[1]}/comments/${post[2]}/${post[3] ? `_/${post[3]}/` : ""}`;
		return {
			kind: post[3] ? "comment" : "post",
			subreddit: post[1],
			post_id: post[2],
			comment_id: post[3],
			canonical_url: canonical,
		};
	}

	const commentsOnly = path.match(/\/comments\/([a-z0-9]{5,12})(?:\/[^/]+)?(?:\/([a-z0-9]{5,12}))?/i);
	if (commentsOnly) {
		return {
			kind: commentsOnly[2] ? "comment" : "post",
			post_id: commentsOnly[1],
			comment_id: commentsOnly[2],
			canonical_url: `${redditBaseUrl}/comments/${commentsOnly[1]}/${commentsOnly[2] ? `_/${commentsOnly[2]}/` : ""}`,
		};
	}

	const subreddit = path.match(/\/r\/([^/]+)$/i);
	if (subreddit) return { kind: "subreddit", subreddit: subreddit[1], canonical_url: `${redditBaseUrl}/r/${subreddit[1]}/` };

	const multi = path.match(/\/(?:u|user)\/([^/]+)\/m\/([^/]+)/i);
	if (multi) {
		return {
			kind: "user",
			username: multi[1],
			multireddit: multi[2],
			canonical_url: `${redditBaseUrl}/user/${multi[1]}/m/${multi[2]}/`,
		};
	}

	const user = path.match(/\/(?:u|user)\/([^/]+)/i);
	if (user) return { kind: "user", username: user[1], canonical_url: `${redditBaseUrl}/user/${user[1]}/` };

	return { kind: "unknown", canonical_url: url.toString() };
}

function queryTerms(query: string) {
	return query
		.toLowerCase()
		.split(/[^a-z0-9_+#.-]+/i)
		.map((term) => term.trim())
		.filter((term) => term.length >= 2);
}

function subredditPriority(subreddit: string) {
	return knownSubredditPriority.get(subreddit.toLowerCase()) ?? 0;
}

function rankPost(post: RedditPost, query: string): RedditPost {
	const q = query.toLowerCase().trim();
	const title = post.title.toLowerCase();
	const body = post.selftext.toLowerCase();
	const terms = queryTerms(query);
	let score = 0;
	const reasons: string[] = [];

	if (q && title.includes(q)) {
		score += 40;
		reasons.push("exact title match");
	} else if (q && body.includes(q)) {
		score += 18;
		reasons.push("exact body match");
	}

	const titleHits = terms.filter((term) => title.includes(term)).length;
	const bodyHits = terms.filter((term) => body.includes(term)).length;
	if (titleHits) {
		score += titleHits * 8;
		reasons.push(`${titleHits} title term match${titleHits === 1 ? "" : "es"}`);
	}
	if (bodyHits) {
		score += bodyHits * 2.5;
		reasons.push(`${bodyHits} body term match${bodyHits === 1 ? "" : "es"}`);
	}

	score += Math.log1p(Math.max(0, post.score)) * 3;
	score += Math.log1p(Math.max(0, post.numComments)) * 4;
	if (post.numComments >= 50) reasons.push("active discussion");
	if (post.score >= 100) reasons.push("high score");

	const ageDays = post.createdUtc ? Math.max(0, (Date.now() / 1000 - post.createdUtc) / 86400) : 365;
	const recencyBoost = Math.max(0, 12 - Math.log1p(ageDays) * 3);
	score += recencyBoost;
	if (ageDays <= 30) reasons.push("recent");

	const priority = subredditPriority(post.subreddit);
	if (priority) {
		score += priority;
		reasons.push(`priority subreddit r/${post.subreddit}`);
	}

	if (post.over18) {
		score -= 25;
		reasons.push("NSFW penalty");
	}
	if (!post.selftext && !post.domain) score -= 5;
	if (post.title.toLowerCase().includes("[removed]") || post.selftext.toLowerCase().includes("[removed]")) score -= 20;

	return {
		...post,
		rankScore: Math.round(score * 10) / 10,
		rankReasons: reasons.slice(0, 5),
	};
}

function queryKey(query: string, subreddits: string[] | undefined, sort: RedditSort, time: RedditTime, after?: string) {
	return JSON.stringify({
		query: query.toLowerCase().trim(),
		subreddits: [...(subreddits ?? [])].map((s) => s.toLowerCase()).sort(),
		sort,
		time,
		after: after ?? null,
	});
}

async function searchPosts(params: {
	query: string;
	subreddits?: string[];
	sort: RedditSort;
	time: RedditTime;
	limit: number;
	after?: string;
	signal?: AbortSignal;
}) {
	const limit = Math.min(100, Math.max(1, params.limit));
	const q = encodeURIComponent(params.query);
	const sort = encodeURIComponent(params.sort);
	const time = encodeURIComponent(params.time);
	// Reddit cursors belong to one listing. With several subreddits there is no single cursor
	// to reuse, and Reddit answers a mismatched cursor with HTTP 200 plus the same page again,
	// so never forward a cursor into a multi-subreddit scope.
	const requestedAfter = optionalString(params.after);
	const multiScope = Boolean(params.subreddits && params.subreddits.length > 1);
	const after = multiScope ? undefined : requestedAfter;
	const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
	const entries = params.subreddits?.length
		? params.subreddits.map((subreddit) => ({
				key: subreddit,
				path: `/r/${encodeURIComponent(subreddit)}/search.json?q=${q}&restrict_sr=1&sort=${sort}&t=${time}&limit=${limit}${cursor}`,
			}))
		: [{ key: "all", path: `/search.json?q=${q}&sort=${sort}&t=${time}&limit=${limit}${cursor}` }];

	const { listings } = await fetchPagedListings(entries, defaultTtlMs, params.signal);
	const seen = new Set<string>();
	const posts: RedditPost[] = [];
	for (const { data } of listings) {
		for (const post of parsePosts(data)) {
			if (seen.has(post.id)) continue;
			seen.add(post.id);
			posts.push(rankPost(post, params.query));
		}
	}
	const ranked = posts.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0)).slice(0, limit);
	store.savePosts(ranked);
	store.saveSearchResults(queryKey(params.query, params.subreddits, params.sort, params.time, after), ranked);
	const cursors = returnedListingCursors(listings, ranked, Boolean(multiScope && requestedAfter));
	return { posts: ranked, cursors };
}

async function getThread(urlOrId: string, sort: RedditSort, commentLimit: number, signal?: AbortSignal) {
	const id = extractPostId(urlOrId);
	if (!id) throw new Error(`Could not extract Reddit post id from: ${urlOrId}`);
	const commentsSort = sort === "relevance" || sort === "comments" ? "confidence" : sort;
	const path = `/comments/${encodeURIComponent(id)}.json?limit=${commentLimit}&sort=${encodeURIComponent(commentsSort)}`;
	return parseThread(await fetchRedditJson(path, threadTtlMs, signal));
}

function topComments(comments: RedditComment[], limit: number, minLength = 20) {
	return comments
		.filter((comment) => comment.body.length >= minLength)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

function formatPostLine(post: RedditPost, index: number) {
	const flair = post.flair ? ` [${post.flair}]` : "";
	const nsfw = post.over18 ? " NSFW" : "";
	const rank = post.rankScore !== undefined ? `, rank ${post.rankScore}` : "";
	const reasons = post.rankReasons?.length ? ` (${post.rankReasons.join("; ")})` : "";
	return `${index}. r/${post.subreddit}${flair}${nsfw} - ${post.title}\n   score ${post.score}, comments ${post.numComments}, age ${post.age}, by u/${post.author}${rank}${reasons}\n   ${post.url}`;
}

function formatPostExcerpt(post: RedditPost) {
	const excerpt = compactWhitespace(post.selftext, 420);
	if (excerpt) return `   post excerpt: ${excerpt}`;
	const domain = post.domain ? ` (${post.domain})` : "";
	return `   link post${domain}`;
}

function formatComments(comments: RedditComment[], limit: number, indent = "   ") {
	const selected = topComments(comments, limit);
	if (!selected.length) return `${indent}comments: none fetched or no useful comments`;
	return [`${indent}top comments:`]
		.concat(selected.map((comment) => `${indent}- +${comment.score} u/${comment.author}: ${compactWhitespace(comment.body, 360)}`))
		.join("\n");
}

function formatPosts(posts: RedditPost[], title: string) {
	const lines = [title];
	if (!posts.length) return `${title}\nNo Reddit posts found. Try broader terms, another time range, or explicit subreddits.`;
	posts.forEach((post, idx) => {
		lines.push(formatPostLine(post, idx + 1));
		lines.push(formatPostExcerpt(post));
	});
	return lines.join("\n");
}

function observedSubreddits(posts: RedditPost[]) {
	const counts = new Map<string, number>();
	for (const post of posts) counts.set(post.subreddit, (counts.get(post.subreddit) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 12)
		.map(([subreddit, count]) => `r/${subreddit} (${count})`)
		.join(", ");
}

function depthDefaults(depth: RedditDepth) {
	if (depth === "quick") return { posts: 6, commentPosts: 2, comments: 3 };
	if (depth === "deep") return { posts: 14, commentPosts: 6, comments: 8 };
	return { posts: 10, commentPosts: 4, comments: 5 };
}

function intentHints(intent: RedditIntent) {
	const hints: Record<RedditIntent, string> = {
		opinions: "Use high-score comments as sentiment evidence; separate praise, criticism, and caveats.",
		bugs: "Look for repeated failures, error strings, hardware/software versions, and unresolved reports.",
		fixes: "Prioritize comments that include concrete commands, settings, versions, or final outcomes.",
		compare: "Group evidence by option; note which claims come from direct use vs speculation.",
		settings: "Extract concrete parameters, configs, sampler/scheduler names, and reported tradeoffs.",
		alternatives: "Collect named alternatives and why people switched or rejected them.",
		trends: "Prefer newer/high-engagement posts and recurring themes across subreddits.",
		guides: "Prefer posts/comments with step-by-step instructions, repos, docs, or reproducible setups.",
		hardware: "Extract exact device specs, memory/VRAM, speed numbers, thermals, and constraints.",
		general: "Synthesize only from cited posts/comments; do not over-weight one thread.",
	};
	return hints[intent];
}

const clusterKeywords: Record<EvidenceCluster, RegExp[]> = {
	praise: [/\b(great|amazing|love|blown away|game.?changer|works well|impressive|solid)\b/i],
	complaints: [/\b(issue|problem|bug|broken|fails?|failure|crash|slow|bad|worse|annoying|pain)\b/i],
	fixes: [/\b(fix(?:ed)?|solv(?:ed|es)|workaround|try this|set |use |command|patch|upgrade|downgrade)\b/i],
	settings: [/\b(sampler|scheduler|denoise|temperature|top[_ -]?p|top[_ -]?k|ctx|context|batch|threads?|config|setting)\b/i],
	hardware: [/\b(vram|ram|gb|rtx|3090|4090|4070|mac|m1|m2|m3|m4|tokens?\/s|t\/s|cpu|gpu)\b/i],
	alternatives: [/\b(alternative|instead|replace|switch(?:ed)?|vs\.?|better than|worse than|compared)\b/i],
	guides: [/\b(guide|tutorial|how to|walkthrough|steps?|docs?|repo|github)\b/i],
	risks: [/\b(risk|danger|unsafe|security|privacy|leak|cost|quota|license)\b/i],
	general: [],
};

function classifyCluster(text: string, intent: RedditIntent): EvidenceCluster {
	const preferred: Partial<Record<RedditIntent, EvidenceCluster[]>> = {
		bugs: ["complaints", "risks"],
		fixes: ["fixes", "settings"],
		settings: ["settings", "hardware"],
		hardware: ["hardware", "complaints"],
		compare: ["alternatives", "praise", "complaints"],
		alternatives: ["alternatives"],
		guides: ["guides", "fixes"],
		opinions: ["praise", "complaints"],
	};
	for (const cluster of preferred[intent] ?? []) {
		if (clusterKeywords[cluster].some((pattern) => pattern.test(text))) return cluster;
	}
	for (const [cluster, patterns] of Object.entries(clusterKeywords) as [EvidenceCluster, RegExp[]][]) {
		if (cluster !== "general" && patterns.some((pattern) => pattern.test(text))) return cluster;
	}
	return "general";
}

function makeEvidenceItems(posts: RedditPost[], commentsByPost: Map<string, RedditComment[]>, intent: RedditIntent, perPost: number) {
	const items: EvidenceItem[] = [];
	posts.forEach((post, postIdx) => {
		const postText = compactWhitespace(`${post.title}. ${post.selftext}`, 500);
		if (postText.length > 20) {
			items.push({
				kind: "post",
				cluster: classifyCluster(postText, intent),
				post_id: post.id,
				post_index: postIdx + 1,
				subreddit: post.subreddit,
				score: post.score,
				url: post.url,
				text: postText,
				reason: post.rankReasons?.join("; ") || "ranked source post",
			});
		}
		for (const comment of topComments(commentsByPost.get(post.id) ?? [], perPost)) {
			const text = compactWhitespace(comment.body, 500);
			items.push({
				kind: "comment",
				cluster: classifyCluster(text, intent),
				post_id: post.id,
				post_index: postIdx + 1,
				subreddit: post.subreddit,
				score: comment.score,
				url: comment.url ?? post.url,
				text,
				reason: `top comment on source post ${postIdx + 1}`,
			});
		}
	});
	return items.sort((a, b) => b.score - a.score).slice(0, 40);
}

function clusterEvidence(items: EvidenceItem[]) {
	const clusters: Record<string, EvidenceItem[]> = {};
	for (const item of items) {
		clusters[item.cluster] ??= [];
		if (clusters[item.cluster].length < 6) clusters[item.cluster].push(item);
	}
	return clusters;
}

function formatEvidenceClusters(clusters: Record<string, EvidenceItem[]>) {
	const lines = ["Evidence clusters:"];
	for (const [cluster, items] of Object.entries(clusters)) {
		if (!items.length || cluster === "general") continue;
		lines.push(`- ${cluster}: ${items.map((item) => `#${item.post_index} ${compactWhitespace(item.text, 120)}`).join(" | ")}`);
	}
	if (lines.length === 1) lines.push("- no strong keyword clusters; inspect source posts directly");
	return lines.join("\n");
}

async function redditPack(args: {
	topic: string;
	intent: RedditIntent;
	depth: RedditDepth;
	time: RedditTime;
	sort: RedditSort;
	subreddits?: string[];
	max_posts?: number;
	comments_per_post?: number;
	after?: string;
	signal?: AbortSignal;
}) {
	const defaults = depthDefaults(args.depth);
	const maxPosts = clampInt(args.max_posts, defaults.posts, 1, defaults.posts);
	const commentsPerPost = clampInt(args.comments_per_post, defaults.comments, 1, Math.max(defaults.comments, 12));
	const { posts, cursors } = await searchPosts({
		query: args.topic,
		subreddits: args.subreddits,
		sort: args.sort,
		time: args.time,
		limit: maxPosts,
		after: args.after,
		signal: args.signal,
	});

	const commentPosts = posts.slice(0, defaults.commentPosts);
	const commentsByPost = new Map<string, RedditComment[]>();
	for (const post of commentPosts) {
		try {
			const thread = await getThread(post.id, "top", Math.max(10, commentsPerPost * 4), args.signal);
			if (thread.post) commentsByPost.set(post.id, thread.comments);
		} catch {
			// Keep the research pack usable when an individual thread fails.
		}
	}

	const evidenceItems = makeEvidenceItems(posts, commentsByPost, args.intent, commentsPerPost);
	const clusters = clusterEvidence(evidenceItems);

	const lines = [
		`Reddit research pack`,
		`topic: ${args.topic}`,
		`intent: ${args.intent}; time: ${args.time}; sort: ${args.sort}; depth: ${args.depth}`,
		args.subreddits?.length ? `scope: ${args.subreddits.map((s) => `r/${s}`).join(", ")}` : "scope: all Reddit search",
		posts.length ? `observed subreddits: ${observedSubreddits(posts)}` : "",
		`reading hint for model: ${intentHints(args.intent)}`,
		"",
		formatEvidenceClusters(clusters),
		"",
		"Evidence:",
	].filter(Boolean);

	posts.forEach((post, idx) => {
		lines.push(formatPostLine(post, idx + 1));
		lines.push(formatPostExcerpt(post));
		const comments = commentsByPost.get(post.id);
		if (comments) lines.push(formatComments(comments, commentsPerPost));
	});

	return {
		text: lines.join("\n"),
		details: {
			topic: args.topic,
			intent: args.intent,
			cursors,
			posts: posts.map((post) => ({ ...post, selftext: compactWhitespace(post.selftext, 500) })),
			evidence_items: evidenceItems,
			clusters,
			commented_post_count: commentsByPost.size,
		},
	};
}

function topicKey(topic: string) {
	return topic.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreSubredditCandidate(topic: string, item: JsonObject, posts: RedditPost[] = []): SubredditCandidate | undefined {
	const subreddit = optionalString(item.display_name);
	if (!subreddit) return undefined;
	const haystack = `${item.display_name ?? ""} ${item.title ?? ""} ${item.public_description ?? ""}`.toLowerCase();
	const terms = queryTerms(topic);
	let score = 0;
	const reasons: string[] = [];
	const subscribers = optionalNumber(item.subscribers);

	if (terms.length) {
		const hits = terms.filter((term) => haystack.includes(term)).length;
		if (hits) {
			score += hits * 10;
			reasons.push(`${hits} topic term match${hits === 1 ? "" : "es"}`);
		}
	}
	if (subscribers) {
		score += Math.log1p(subscribers) * 2;
		reasons.push("subscriber signal");
	}
	const priority = subredditPriority(subreddit);
	if (priority) {
		score += priority;
		reasons.push("known AI/dev subreddit");
	}
	const matchingPosts = posts.filter((post) => post.subreddit.toLowerCase() === subreddit.toLowerCase());
	if (matchingPosts.length) {
		score += matchingPosts.length * 8;
		score += Math.log1p(matchingPosts.reduce((sum, post) => sum + Math.max(0, post.score) + Math.max(0, post.numComments), 0));
		reasons.push(`${matchingPosts.length} matching search post${matchingPosts.length === 1 ? "" : "s"}`);
	}
	return {
		subreddit,
		score: Math.round(score * 10) / 10,
		reasons: reasons.slice(0, 5),
		title: optionalString(item.title),
		public_description: optionalString(item.public_description),
		subscribers,
	};
}

async function resolveSubreddits(topic: string, limit: number, refresh: boolean, signal?: AbortSignal) {
	const key = topicKey(topic);
	if (!refresh) {
		const cached = store.getTopicSubreddits(key, topicTtlMs);
		if (cached?.length) return cached.slice(0, limit) as SubredditCandidate[];
	}

	const subData = await fetchRedditJson(`/subreddits/search.json?q=${encodeURIComponent(topic)}&limit=${Math.max(limit, 15)}`, subredditTtlMs, signal);
	const subItems = listingChildren(subData)
		.map((child) => (child.data && typeof child.data === "object" ? (child.data as JsonObject) : undefined))
		.filter((item): item is JsonObject => !!item);
	const { posts: searchPostsForTopic } = await searchPosts({ query: topic, sort: "relevance", time: "year", limit: 25, signal });
	const bySub = new Map<string, SubredditCandidate>();

	for (const item of subItems) {
		const candidate = scoreSubredditCandidate(topic, item, searchPostsForTopic);
		if (candidate) bySub.set(candidate.subreddit.toLowerCase(), candidate);
	}
	for (const post of searchPostsForTopic) {
		const key = post.subreddit.toLowerCase();
		if (bySub.has(key)) continue;
		const candidate = scoreSubredditCandidate(topic, { display_name: post.subreddit, title: post.subreddit }, searchPostsForTopic);
		if (candidate) bySub.set(key, candidate);
	}

	const ranked = [...bySub.values()].sort((a, b) => b.score - a.score).slice(0, limit);
	store.saveTopicSubreddits(key, ranked);
	return ranked;
}

function formatSubredditCandidates(topic: string, candidates: SubredditCandidate[]) {
	const lines = [`Ranked subreddits for "${topic}":`];
	if (!candidates.length) return `${lines[0]}\nNo subreddit candidates found.`;
	candidates.forEach((candidate, idx) => {
		const subscribers = candidate.subscribers !== undefined ? `; subscribers ${candidate.subscribers}` : "";
		const description = candidate.public_description ? `; ${compactWhitespace(candidate.public_description, 180)}` : "";
		lines.push(`${idx + 1}. r/${candidate.subreddit} - score ${candidate.score}; ${candidate.reasons.join("; ")}${subscribers}${description}`);
	});
	return lines.join("\n");
}

type UserSection = "about" | "posts" | "comments";
const userSections = new Set<UserSection>(["about", "posts", "comments"]);
const userSorts = new Set<string>(["new", "top", "hot", "controversial"]);

function extractUsername(value: string) {
	const normalized = String(normalizeString(value) ?? "").trim();
	if (!normalized) return undefined;
	// The trailing boundary matters: without it a percent-encoded path such as /user/sp%65z/ silently
	// yields the truncated "sp" and queries the wrong account.
	const fromUrl = normalized.match(/\/(?:u|user)\/([A-Za-z0-9_-]{2,20})(?=[/?#]|$)/i);
	if (fromUrl) return fromUrl[1];
	const direct = normalized.match(/^(?:u\/|user\/|@)?([A-Za-z0-9_-]{2,20})$/);
	return direct?.[1];
}

const usernamePrompt = "Provide a Reddit username, for example spez, u/spez, or a reddit.com/user/... URL.";

// Explains why a username could not be extracted. A bare token is treated as a username attempt, so
// an over-long or malformed name says what is wrong with it instead of claiming nothing was found.
// Echoed values are collapsed and capped: the input is caller-supplied and can be arbitrarily long.
function usernameProblem(value: string) {
	const normalized = String(normalizeString(value) ?? "").trim();
	const bare = normalized.replace(/^@/, "");
	if (!bare) return usernamePrompt;
	if (!bare.includes("/")) {
		const shown = compactWhitespace(bare, 60);
		if (bare.length > 20) {
			return `Reddit usernames are at most 20 characters; got "${shown}" (${bare.length} characters).`;
		}
		if (bare.length < 3) {
			return `"${shown}" is too short to be a Reddit username (3-20 characters).`;
		}
		if (!/^[A-Za-z0-9_-]+$/.test(bare)) {
			return `"${shown}" is not a valid Reddit username (letters, digits, "_", and "-" only).`;
		}
	}
	return `Could not extract a Reddit username from: ${compactWhitespace(normalized, 120)}`;
}

interface RedditUserProfile {
	username: string;
	fullname?: string;
	createdUtc?: number;
	age: string;
	linkKarma?: number;
	commentKarma?: number;
	totalKarma?: number;
	verified: boolean;
	isEmployee: boolean;
	isMod: boolean;
	hasVerifiedEmail: boolean;
	publicDescription?: string;
	suspended: boolean;
	profileVisible: boolean;
}

function parseUserAbout(data: unknown, fallbackUsername: string): RedditUserProfile {
	const payload = (((data as JsonObject)?.data ?? {}) as JsonObject);
	const profile = ((payload.subreddit ?? {}) as JsonObject);
	const id = optionalString(payload.id);
	const createdUtc = optionalNumber(payload.created_utc) ?? optionalNumber(payload.created);
	return {
		username: optionalString(payload.name) ?? fallbackUsername,
		fullname: id ? `t2_${id}` : undefined,
		createdUtc,
		age: ageFromUtc(createdUtc ?? 0),
		linkKarma: optionalNumber(payload.link_karma),
		commentKarma: optionalNumber(payload.comment_karma),
		totalKarma: optionalNumber(payload.total_karma),
		verified: boolValue(payload.verified, false),
		isEmployee: boolValue(payload.is_employee, false),
		isMod: boolValue(payload.is_mod, false),
		hasVerifiedEmail: boolValue(payload.has_verified_email, false),
		publicDescription: optionalString(profile.public_description) ?? optionalString(payload.public_description),
		suspended: boolValue(payload.is_suspended, false),
		// Reddit returns `subreddit: null` when an account has no public profile page,
		// which is what suspended, banned, and shadowbanned accounts look like (HTTP 200).
		profileVisible: Boolean(payload.subreddit && typeof payload.subreddit === "object"),
	};
}

async function redditUser(args: {
	username: string;
	sections: UserSection[];
	sort: string;
	time: RedditTime;
	limit: number;
	afterPosts?: string;
	afterComments?: string;
	signal?: AbortSignal;
}) {
	const username = extractUsername(args.username);
	if (!username) throw new Error(usernameProblem(args.username));
	const errors: string[] = [];
	const cursors: Partial<Record<UserSection, ListingCursor>> = {};
	let about: RedditUserProfile | undefined;
	const posts: RedditPost[] = [];
	const comments: RedditComment[] = [];

	if (args.sections.includes("about")) {
		try {
			about = parseUserAbout(await fetchRedditJson(`/user/${encodeURIComponent(username)}/about.json`, defaultTtlMs, args.signal), username);
		} catch (error) {
			if (args.signal?.aborted) throw error;
			errors.push(`about: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const section of ["posts", "comments"] as const) {
		if (!args.sections.includes(section)) continue;
		const listingName = section === "posts" ? "submitted" : "comments";
		// Cursors are fullname-typed per listing. Reddit answers a cursor from the wrong
		// listing with HTTP 200 and the same page again, so validate before sending it.
		const expected = section === "posts" ? "t3_" : "t1_";
		const requested = optionalString(section === "posts" ? args.afterPosts : args.afterComments);
		let after = requested;
		if (after && !after.startsWith(expected)) {
			errors.push(`${section}: ignored cursor ${after} (expected a ${expected}... cursor for this listing)`);
			after = undefined;
		}
		const cursorParam = after ? `&after=${encodeURIComponent(after)}` : "";
		const path = `/user/${encodeURIComponent(username)}/${listingName}.json?limit=${args.limit}&sort=${encodeURIComponent(args.sort)}&t=${encodeURIComponent(args.time)}${cursorParam}`;
		try {
			const listing = await fetchRedditJson(path, defaultTtlMs, args.signal);
			cursors[section] = listingCursor(listing);
			if (section === "posts") posts.push(...parsePosts(listing));
			else comments.push(...flattenComments(listingChildren(listing)));
		} catch (error) {
			if (args.signal?.aborted) throw error;
			errors.push(`${section}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { username, about, posts, comments, cursors, errors, sections: args.sections, sort: args.sort, limit: args.limit };
}

function formatRedditUser(result: Awaited<ReturnType<typeof redditUser>>) {
	const about = result.about;
	const lines = [`u/${result.username}${about?.fullname ? ` (${about.fullname})` : ""}`];
	if (about) {
		if (about.suspended) lines.push("   account is suspended by Reddit");
		if (!about.profileVisible) lines.push("   no public profile page for this account (often suspended, banned, or shadowbanned; check before trusting its comments)");
		const karma = [
			about.linkKarma !== undefined ? `post karma ${about.linkKarma}` : "",
			about.commentKarma !== undefined ? `comment karma ${about.commentKarma}` : "",
			about.totalKarma !== undefined ? `total karma ${about.totalKarma}` : "",
		].filter(Boolean);
		lines.push(`   account age ${about.age}; ${karma.length ? karma.join(", ") : "karma unknown"}`);
		const flags = [
			about.verified ? "verified" : "",
			about.isEmployee ? "reddit employee" : "",
			about.isMod ? "moderator" : "",
			about.hasVerifiedEmail ? "verified email" : "",
		].filter(Boolean);
		if (flags.length) lines.push(`   account signals: ${flags.join(", ")} (weak signals, not proof of expertise or honesty)`);
		if (about.publicDescription) lines.push(`   public description: ${compactWhitespace(about.publicDescription, 240)}`);
	}
	if (result.sections.includes("posts")) {
		if (result.posts.length) {
			lines.push(`   recent posts (${result.posts.length}, sort ${result.sort}):`);
			result.posts.forEach((post, idx) => lines.push(`   ${formatPostLine(post, idx + 1)}`));
		} else {
			lines.push("   recent posts: none returned");
		}
	}
	if (result.sections.includes("comments")) {
		const shown = topComments(result.comments, result.limit, 1);
		if (shown.length) {
			lines.push(`   recent comments (${result.comments.length} fetched, showing ${shown.length} by score):`);
			for (const comment of shown) {
				const where = comment.subreddit ? `r/${comment.subreddit} ` : "";
				const parent = comment.parentId ? `parent ${comment.parentId} ` : "";
				lines.push(`   - +${comment.score} ${where}${parent}: ${compactWhitespace(comment.body, 320)}`);
				if (comment.url) lines.push(`     ${comment.url}`);
			}
		} else {
			lines.push("   recent comments: none returned");
		}
	}
	if (!about && !result.posts.length && !result.comments.length) {
		lines.push("No public data returned. The account may be suspended, deleted, private, or the name may be wrong.");
	}
	return lines.join("\n");
}

export default function redditResearch(pi: ExtensionAPI) {

	if (showStatusFooter) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setStatus("reddit", "Reddit: sqlite");
		});

		pi.on("session_shutdown", (_event, ctx) => {
			ctx.ui.setStatus("reddit", undefined);
		});
	}

	pi.registerCommand("reddit", {
		description: "Search Reddit JSON quickly",
		handler: async (args, ctx) => {
			try {
				const [subcommand, ...rest] = String(args ?? "").trim().split(/\s+/);
				if (!subcommand || subcommand === "status") {
					redditCookie = loadRedditCookie();
					const cooldownMs = Math.max(0, cooldownUntil - Date.now());
					ctx.ui.notify(
						`Reddit research ready. SQLite: ${sqlitePath}. Delay: ${requestDelayMs}ms. TTLs: search ${Math.round(defaultTtlMs / 60_000)}m, thread ${Math.round(threadTtlMs / 60_000)}m, subreddit ${Math.round(subredditTtlMs / 3_600_000)}h, topic ${Math.round(topicTtlMs / 86_400_000)}d. Cooldown: ${Math.ceil(cooldownMs / 1000)}s. Cookies: ${redditCookie ? "set" : "not set — create ~/.pi/agent/reddit-research.json or set PI_REDDIT_COOKIE"}. Config: ${redditConfigPath}.`,
						"info",
					);
					return;
				}
				if (subcommand === "search") {
					const query = rest.join(" ").trim();
					if (!query) {
						ctx.ui.notify("Usage: /reddit search <query>", "warning");
						return;
					}
					const { posts } = await searchPosts({ query, sort: "relevance", time: "year", limit: 5 });
					ctx.ui.notify(formatPosts(posts, `Reddit search: ${query}`).slice(0, 2000), "info");
					return;
				}
				ctx.ui.notify("Usage: /reddit [status|search <query>]", "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "reddit_url_extract",
		label: "Reddit URL Extract",
		description: "Parse a Reddit URL, permalink, t3 post id, or t1 comment id into normalized identifiers.",
		promptSnippet: "Extract subreddit, post id, comment id, and canonical URL from a Reddit link",
		parameters: Type.Object({
			url_or_id: Type.String({ description: "Reddit URL, permalink, t3 post id, or t1 comment id." }),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			return { url_or_id: String(normalizeString(raw.url_or_id) ?? "") };
		},
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const result = extractRedditUrl(params.url_or_id);
			return textResult(JSON.stringify(result, null, 2), result);
		},
	});

	pi.registerTool({
		name: "reddit_resolve_subreddits",
		label: "Reddit Resolve Subreddits",
		description: "Resolve a topic into ranked subreddit candidates using Reddit subreddit search, post search, SQLite cache, and subreddit priority hints.",
		promptSnippet: "Find and rank subreddits for focused Reddit research",
		promptGuidelines: [
			"Use reddit_resolve_subreddits before focused reddit_pack searches when the best subreddit scope is unclear.",
			"Use returned subreddit scores as search guidance, not as objective popularity facts.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Topic, product, repo, tool, or community to resolve into subreddits." }),
			limit: Type.Optional(Type.Number({ description: "Maximum subreddit candidates. Default 10, max 25." })),
			refresh: Type.Optional(Type.Boolean({ description: "Bypass cached topic_subreddit_scores. Default false." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			return {
				topic: String(normalizeString(raw.topic) ?? ""),
				limit: clampInt(raw.limit, 10, 1, 25),
				refresh: boolValue(raw.refresh, false),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const candidates = await resolveSubreddits(params.topic, clampInt(params.limit, 10, 1, 25), boolValue(params.refresh, false), signal);
			return textResult(formatSubredditCandidates(params.topic, candidates), { topic: params.topic, subreddits: candidates });
		},
	});

	pi.registerTool({
		name: "reddit_pack",
		label: "Reddit Pack",
		description: "Build a compact Reddit research pack for opinions, bugs, fixes, comparisons, settings, alternatives, trends, guides, hardware, or general research.",
		promptSnippet: "Research Reddit discussions with compact post and top-comment evidence",
		promptGuidelines: [
			"Use reddit_pack when the user asks what Reddit thinks, reports, recommends, compares, complains about, or uses in practice.",
			"Prefer depth=quick for a quick orientation, depth=normal for normal answers, and depth=deep only when the user asks for thorough Reddit research.",
			"After reddit_pack, synthesize patterns from the returned evidence and cite post numbers or r/subreddit names; do not treat Reddit anecdotes as verified facts.",
		],
		parameters: Type.Object({
			topic: Type.String({ description: "Search topic, product, error string, repo URL/name, or comparison query." }),
			intent: Type.Optional(Type.String({ enum: [...intents], description: "Research intent. Default general." })),
			depth: Type.Optional(Type.String({ enum: [...depths], description: "How much evidence to collect: quick, normal, deep. Default normal." })),
			time: Type.Optional(Type.String({ enum: [...times], description: "Reddit time window. Default year." })),
			sort: Type.Optional(Type.String({ enum: [...sorts], description: "Reddit search sort. Default relevance." })),
			subreddits: Type.Optional(Type.String({ description: "Optional comma-separated subreddit names, for example: LocalLLaMA, LocalLLM, ClaudeCode. Do not pass a JSON list." })),
			max_posts: Type.Optional(Type.Number({ description: "Maximum posts to return. Capped by depth." })),
			comments_per_post: Type.Optional(Type.Number({ description: "Top comments per fetched thread. Default depends on depth." })),
			after: Type.Optional(Type.String({ description: "Pagination cursor from a previous reddit_pack/reddit_search result." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			return {
				topic: String(normalizeString(raw.topic) ?? ""),
				intent: enumValue(raw.intent, intents, "general"),
				depth: enumValue(raw.depth, depths, "normal"),
				time: enumValue(raw.time, times, "year"),
				sort: enumValue(raw.sort, sorts, "relevance"),
				subreddits: stringListParam(raw.subreddits),
				max_posts: optionalNumber(raw.max_posts),
				comments_per_post: optionalNumber(raw.comments_per_post),
				after: optionalString(raw.after),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await redditPack({
				topic: params.topic,
				intent: enumValue(params.intent, intents, "general"),
				depth: enumValue(params.depth, depths, "normal"),
				time: enumValue(params.time, times, "year"),
				sort: enumValue(params.sort, sorts, "relevance"),
				subreddits: stringList(params.subreddits),
				max_posts: optionalNumber(params.max_posts),
				comments_per_post: optionalNumber(params.comments_per_post),
				after: optionalString(params.after),
				signal,
			});
			return textResult(result.text, result.details, listingNavigation(result.details.cursors, "topic/sort/time"));
		},
	});

	pi.registerTool({
		name: "reddit_search",
		label: "Reddit Search",
		description: "Search Reddit posts and return a compact list without fetching comment threads.",
		promptSnippet: "Search Reddit posts by query, subreddit scope, sort, and time window",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			subreddits: Type.Optional(Type.String({ description: "Optional comma-separated subreddit names, for example: LocalLLaMA, LocalLLM, ClaudeCode. Do not pass a JSON list." })),
			sort: Type.Optional(Type.String({ enum: [...sorts], description: "Sort: relevance, hot, top, new, comments. Default relevance." })),
			time: Type.Optional(Type.String({ enum: [...times], description: "Time range. Default year." })),
			limit: Type.Optional(Type.Number({ description: "Maximum posts. Default 8, max 25." })),
			after: Type.Optional(Type.String({ description: "Pagination cursor from a previous reddit_search result." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			return {
				query: String(normalizeString(raw.query) ?? ""),
				subreddits: stringListParam(raw.subreddits),
				sort: enumValue(raw.sort, sorts, "relevance"),
				time: enumValue(raw.time, times, "year"),
				limit: clampInt(raw.limit, 8, 1, 25),
				after: optionalString(raw.after),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const { posts, cursors } = await searchPosts({
				query: params.query,
				subreddits: stringList(params.subreddits),
				sort: enumValue(params.sort, sorts, "relevance"),
				time: enumValue(params.time, times, "year"),
				limit: clampInt(params.limit, 8, 1, 25),
				after: optionalString(params.after),
				signal,
			});
			const scope = stringList(params.subreddits)?.map((s) => `r/${s}`).join(", ") ?? "all Reddit";
			return textResult(formatPosts(posts, `Reddit posts for "${params.query}" in ${scope}`),
				{ posts, cursors }, listingNavigation(cursors, "query/sort/time"));
		},
	});

	pi.registerTool({
		name: "reddit_thread",
		label: "Reddit Thread",
		description: "Fetch one Reddit thread by URL or post id and return compact post details plus top comments.",
		promptSnippet: "Read a specific Reddit thread and top comments by URL or post id",
		parameters: Type.Object({
			url_or_id: Type.String({ description: "Reddit post URL, permalink, or post id." }),
			sort: Type.Optional(Type.String({ enum: ["top", "new", "controversial", "confidence"], description: "Comment sort. Default top." })),
			comment_limit: Type.Optional(Type.Number({ description: "Comments requested from Reddit. Default 50, max 200." })),
			top_comments: Type.Optional(Type.Number({ description: "Top comments to show in compact output. Default 12, max 40." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			const sort = optionalString(raw.sort)?.toLowerCase();
			return {
				url_or_id: String(normalizeString(raw.url_or_id) ?? ""),
				sort: ["top", "new", "controversial", "confidence"].includes(sort ?? "") ? sort : "top",
				comment_limit: clampInt(raw.comment_limit, 50, 1, 200),
				top_comments: clampInt(raw.top_comments, 12, 1, 40),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const thread = await getThread(params.url_or_id, (params.sort as RedditSort) ?? "top", clampInt(params.comment_limit, 50, 1, 200), signal);
			if (!thread.post) return textResult("No Reddit thread found.");
			const lines = [formatPostLine(thread.post, 1), formatPostExcerpt(thread.post), formatComments(thread.comments, clampInt(params.top_comments, 12, 1, 40), "")];
			return textResult(lines.join("\n"), {
				post: thread.post,
				comments: topComments(thread.comments, clampInt(params.top_comments, 12, 1, 40)),
			});
		},
	});

	pi.registerTool({
		name: "reddit_user",
		label: "Reddit User",
		description: "Fetch a public Reddit account profile, recent posts, and recent comments to check source credibility or follow one author.",
		promptSnippet: "Check a Reddit account's age, karma, and other posts/comments",
		promptGuidelines: [
			"Use reddit_user when a claim's trustworthiness matters, when the user names a Reddit account, or when a URL points at a profile.",
			"After reddit_pack, if the strongest evidence comes from one or two accounts, use reddit_user on them before concluding what Reddit thinks.",
			"Account age and karma are weak signals: describe them as signals, never as proof of expertise or honesty.",
		],
		parameters: Type.Object({
			username: Type.String({ description: "Reddit username, for example spez, u/spez, or a reddit.com/user/... URL." }),
			sections: Type.Optional(Type.String({ description: "Comma-separated sections: about, posts, comments. Default about,posts." })),
			sort: Type.Optional(Type.String({ enum: [...userSorts], description: "Listing sort: new, top, hot, controversial. Default new." })),
			time: Type.Optional(Type.String({ enum: [...times], description: "Time window for top/controversial. Default year." })),
			limit: Type.Optional(Type.Number({ description: "Items per section. Default 10, max 25." })),
			after_posts: Type.Optional(Type.String({ description: "Post pagination cursor from a previous reddit_user result's `more posts` line (t3_...)." })),
			after_comments: Type.Optional(Type.String({ description: "Comment pagination cursor from a previous reddit_user result's `more comments` line (t1_...)." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			const sections = stringList(raw.sections)
				?.map((section) => section.toLowerCase())
				.filter((section): section is UserSection => userSections.has(section as UserSection));
			return {
				username: String(normalizeString(raw.username) ?? ""),
				sections: sections?.length ? [...new Set(sections)].join(",") : "about,posts",
				sort: enumValue(raw.sort, userSorts, "new"),
				time: enumValue(raw.time, times, "year"),
				limit: clampInt(raw.limit, 10, 1, 25),
				after_posts: optionalString(raw.after_posts),
				after_comments: optionalString(raw.after_comments),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const requested = (stringList(params.sections) ?? ["about", "posts"])
				.filter((section): section is UserSection => userSections.has(section as UserSection));
			const result = await redditUser({
				username: String(params.username ?? ""),
				sections: requested,
				sort: enumValue(params.sort, userSorts, "new"),
				time: enumValue(params.time, times, "year"),
				limit: clampInt(params.limit, 10, 1, 25),
				afterPosts: optionalString(params.after_posts),
				afterComments: optionalString(params.after_comments),
				signal,
			});
			const navigation = Object.entries(result.cursors).flatMap(([section, cursor]) =>
				cursor?.after ? [`more ${section}: pass after_${section}=${cursor.after} with the same username/sections/sort/time`] : []);
			if (result.errors.length) navigation.push(`fetch errors: ${result.errors.join("; ")}`);
			return textResult(formatRedditUser(result), {
				username: result.username,
				about: result.about,
				posts: result.posts.map((post) => ({ ...post, selftext: compactWhitespace(post.selftext, 500) })),
				comments: topComments(result.comments, result.limit, 1),
				cursors: result.cursors,
				errors: result.errors,
			}, navigation.join("\n"));
		},
	});

	pi.registerTool({
		name: "reddit_subreddits",
		label: "Reddit Subreddits",
		description: "Find subreddit candidates for a topic.",
		promptSnippet: "Find relevant subreddits for a topic before focused Reddit research",
		parameters: Type.Object({
			query: Type.String({ description: "Topic or community query." }),
			limit: Type.Optional(Type.Number({ description: "Maximum communities. Default 10, max 25." })),
			after: Type.Optional(Type.String({ description: "Pagination cursor from a previous reddit_subreddits result." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			return {
				query: String(normalizeString(raw.query) ?? ""),
				limit: clampInt(raw.limit, 10, 1, 25),
				after: optionalString(raw.after),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const limit = clampInt(params.limit, 10, 1, 25);
			const after = optionalString(params.after);
			const cursorParam = after ? `&after=${encodeURIComponent(after)}` : "";
			const data = await fetchRedditJson(`/subreddits/search.json?q=${encodeURIComponent(params.query)}&limit=${limit}${cursorParam}`, subredditTtlMs, signal);
			const cursors = listingCursor(data);
			const lines = [`Subreddits for "${params.query}":`];
			const subs = listingChildren(data)
				.map((child) => (child.data && typeof child.data === "object" ? (child.data as JsonObject) : undefined))
				.filter((item): item is JsonObject => !!item)
				.slice(0, limit);
			for (const item of subs) {
				lines.push(
					`- r/${item.display_name}: ${compactWhitespace(item.title, 120)}; subscribers ${item.subscribers ?? "?"}; ${compactWhitespace(item.public_description, 220)}`,
				);
			}
			if (!subs.length) lines.push("No subreddit candidates found.");
			return textResult(lines.join("\n"), { subreddits: subs, cursors }, listingNavigation(cursors, "query"));
		},
	});

	pi.registerTool({
		name: "reddit_trends",
		label: "Reddit Trends",
		description: "Get hot, top, or new posts from one or more subreddits.",
		promptSnippet: "Inspect hot/top/new posts in subreddits for recent Reddit trends",
		parameters: Type.Object({
			subreddits: Type.String({ description: "Subreddit or comma-separated subreddit names, for example: artificial, technology, ArtificialInteligence. Do not pass a JSON list." }),
			listing: Type.Optional(Type.String({ enum: ["hot", "top", "new"], description: "Listing type. Default hot." })),
			time: Type.Optional(Type.String({ enum: [...times], description: "Top time window. Used only for listing=top. Default week." })),
			limit: Type.Optional(Type.Number({ description: "Maximum total posts. Default 10, max 30." })),
			after: Type.Optional(Type.String({ description: "Pagination cursor from a previous reddit_trends result. Needs a single-subreddit scope." })),
		}),
		prepareArguments(args) {
			const raw = (args && typeof args === "object" ? args : {}) as JsonObject;
			const listing = optionalString(raw.listing)?.toLowerCase();
			return {
				subreddits: stringListParam(raw.subreddits) ?? "",
				listing: ["hot", "top", "new"].includes(listing ?? "") ? listing! : "hot",
				time: enumValue(raw.time, times, "week"),
				limit: clampInt(raw.limit, 10, 1, 30),
				after: optionalString(raw.after),
			};
		},
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const subreddits = stringList(params.subreddits) ?? [];
			if (!subreddits.length) return textResult("Provide at least one subreddit.");
			const listing = optionalString(params.listing)?.toLowerCase() ?? "hot";
			const limit = clampInt(params.limit, 10, 1, 30);
			const after = optionalString(params.after);
			const multiScope = subreddits.length > 1;
			// Cursors are per listing: Reddit ignores a cursor sent to a multi-subreddit scope by
			// returning the same page again, so drop it instead of pretending it was used.
			const effectiveAfter = multiScope ? undefined : after;
			const perSub = Math.max(1, Math.ceil(limit / subreddits.length));
			const entries = subreddits.map((subreddit) => {
				const t = listing === "top" ? `&t=${encodeURIComponent(enumValue(params.time, times, "week"))}` : "";
				const cursor = effectiveAfter ? `&after=${encodeURIComponent(effectiveAfter)}` : "";
				return {
					key: subreddit,
					path: `/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(listing)}.json?limit=${perSub}${t}${cursor}`,
				};
			});
			const { listings } = await fetchPagedListings(entries, defaultTtlMs, signal);
			const parsed: RedditPost[] = [];
			for (const { data } of listings) parsed.push(...parsePosts(data));
			const posts = parsed
				.map((post) => rankPost(post, subreddits.join(" ")))
				.sort((a, b) => (b.rankScore ?? 0) - (a.rankScore ?? 0))
				.slice(0, limit);
			store.savePosts(posts);
			const cursors = returnedListingCursors(listings, posts, Boolean(multiScope && after));
			return textResult(formatPosts(posts, `Reddit ${listing} trends in ${subreddits.map((s) => `r/${s}`).join(", ")}`),
				{ posts, cursors }, listingNavigation(cursors, "listing/time"));
		},
	});
}
