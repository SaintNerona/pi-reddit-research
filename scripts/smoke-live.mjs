// Real Reddit HTTP, real Pi loader and tool loop, synthetic model stream. No LLM provider calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTools, invoke } from '../tests/pi-harness.mjs';

const cache = mkdtempSync(join(tmpdir(), 'pi-reddit-live-'));
process.env.PI_REDDIT_CACHE_DIR = cache;
process.env.PI_REDDIT_SQLITE_PATH = join(cache, 'reddit.sqlite');
process.env.PI_REDDIT_STATUS_FOOTER = 'false';
const delay = Number(process.env.PI_REDDIT_DELAY_MS);
process.env.PI_REDDIT_DELAY_MS = String(Number.isFinite(delay) ? Math.max(2000, delay) : 2000);
const originalFetch = globalThis.fetch;
const rawTitles = new Map();
let rateLimited = false;
globalThis.fetch = async (input, options) => {
  if (rateLimited) throw new Error('Live smoke stopped after HTTP 429; no further network requests allowed.');
  const url = new URL(input);
  assert.equal(url.origin, 'https://api.reddit.com');
  assert.ok(!url.pathname.endsWith('.json'));
  assert.equal(url.searchParams.get('raw_json'), '1');
  assert.equal(options.redirect, 'manual');
  const response = await originalFetch(input, options);
  if (response.status === 429) rateLimited = true;
  // Compare tool post titles to actual raw_json text, without logging response data.
  if (response.ok) {
    try {
      const payload = await response.clone().json();
      const listings = Array.isArray(payload) ? payload : [payload];
      for (const listing of listings) {
        for (const child of listing?.data?.children ?? []) {
          if (child?.kind === 't3') rawTitles.set(child.data.id, child.data.title);
        }
      }
    } catch { /* The extension must diagnose invalid API responses itself. */ }
  }
  return response;
};
let extension;
const call = async (name, args) => {
  if (rateLimited) throw new Error('HTTP 429: validation blocked; no further requests attempted.');
  const result = await invoke(extension, name, args);
  if (rateLimited) throw new Error('HTTP 429: validation blocked, even if stale evidence was returned.');
  if (result.isError) throw new Error(result.content.map((c) => c.text ?? '').join('\n'));
  if (result.details?.errors?.length) throw new Error(result.details.errors.join('; '));
  if (result.details?.expansion_stopped) throw new Error(result.details.expansion_stopped);
  const posts = result.details?.posts ?? (result.details?.post ? [result.details.post] : []);
  for (const post of posts) {
    assert.equal(new URL(post.url).origin, 'https://www.reddit.com');
    assert.ok(rawTitles.has(post.id), `${name}: missing raw title fixture`);
    assert.equal(post.title, rawTitles.get(post.id), `${name}: raw_json title changed`);
  }
  for (const comment of result.details?.comments ?? []) {
    if (comment.url) assert.equal(new URL(comment.url).origin, 'https://www.reddit.com');
  }
  console.log(`${name}: OK`);
  return result;
};
const pages = async (name, args, key = 'after') => {
  const first = await call(name, args);
  const items = key === 'after_comments' ? 'comments' : 'posts';
  assert.ok(first.details[items].length > 0, `${name}: empty first page`);
  if (args.sections?.includes('about')) assert.ok(first.details.about?.username, `${name}: missing profile`);
  const cursor = key === 'after' ? first.details.cursors.after : first.details.cursors[key === 'after_posts' ? 'posts' : 'comments']?.after;
  if (!cursor) { console.log(`${name}: no next cursor; page-two check unavailable`); return; }
  const second = await call(name, { ...args, [key]: cursor });
  const ids = new Set(first.details[items].map((p) => p.id));
  assert.ok(second.details[items].length > 0, `${name}: empty second page`);
  assert.ok(second.details[items].every((p) => !ids.has(p.id)), `${name}: overlapping page ids`);
  console.log(`${name}: page-two ids do not overlap page one`);
};
try {
  extension = await loadTools();
  console.log(`Live request delay: ${process.env.PI_REDDIT_DELAY_MS}ms; User-Agent: ${process.env.PI_REDDIT_USER_AGENT ? 'configured override' : 'shipped default'}`);
  const extracted = await call('reddit_url_extract', { url_or_id: 'https://www.reddit.com/user/spez/comments/' });
  assert.equal(new URL(extracted.details.canonical_url).origin, 'https://www.reddit.com');
  const global = await call('reddit_search', { query: 'python', sort: 'new', limit: 2 });
  assert.ok(global.details.posts.length > 0);
  await pages('reddit_search', { query: 'python', subreddits: 'learnpython', sort: 'new', limit: 2, format: 'compact' });
  await pages('reddit_trends', { subreddits: 'learnpython', listing: 'new', limit: 2, format: 'compact' });
  for (const mode of ['rising', 'controversial']) {
    const result = await call('reddit_trends', { subreddits: 'learnpython', listing: mode, time: 'week', limit: 2 });
    assert.equal(result.details.order, 'reddit');
    // An empty rising/controversial listing is valid; offline fixtures assert ordering.
  }
  for (const sub of ['all', 'popular']) {
    const result = await call('reddit_trends', { subreddits: sub, listing: 'hot', order: 'reddit', limit: 2 });
    assert.equal(result.details.order, 'reddit');
    assert.ok(result.details.posts.length > 0, `r/${sub}: no posts returned`);
  }
  for (const [name, args] of [
    ['reddit_search', { query: 'python', subreddits: 'learnpython', sort: 'new', limit: 100 }],
    ['reddit_trends', { subreddits: 'all', listing: 'hot', order: 'reddit', limit: 100 }],
  ]) {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (...args) => { fetches++; return originalFetch(...args); };
    try {
      const full = await call(name, args);
      const compact = await call(name, { ...args, format: 'compact' });
      assert.equal(fetches, 1, `${name}: format-only change should reuse the cached listing`);
      assert.equal(full.details.format, 'full');
      assert.equal(compact.details.format, 'compact');
      assert.ok(full.details.posts.length > 0 && full.details.posts.length <= 100);
      assert.equal(new Set(full.details.posts.map((post) => post.id)).size, full.details.posts.length);
      assert.deepEqual(compact.details.posts.map((post) => post.id), full.details.posts.map((post) => post.id));
      assert.deepEqual(compact.details.cursors, full.details.cursors);
      assert.ok(compact.details.posts_shown >= full.details.posts_shown);
      for (const post of compact.details.posts) {
        for (const key of ['isSelf', 'stickied', 'isVideo']) assert.equal(typeof post[key], 'boolean');
        assert.equal(new URL(post.url).hostname, 'www.reddit.com');
        if (post.externalUrl) {
          const destination = new URL(post.externalUrl);
          assert.ok(['http:', 'https:'].includes(destination.protocol));
          assert.equal(post.isSelf, false);
          assert.ok(destination.hostname !== 'reddit.com' && !destination.hostname.endsWith('.reddit.com'));
          assert.equal(destination.username + destination.password, '');
        }
      }
      console.log(`${name}: ${full.details.posts.length} selected, ${full.details.posts_shown} full / ${compact.details.posts_shown} compact entries shown; format-only reuse made no extra HTTP request`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
  await pages('reddit_user', { username: 'spez', sections: 'about,posts', limit: 2 }, 'after_posts');
  await pages('reddit_user', { username: 'spez', sections: 'comments', limit: 2 }, 'after_comments');
  const candidates = await call('reddit_search', { query: 'python', subreddits: 'learnpython', limit: 2 });
  assert.ok(candidates.details.posts.length > 0);
  await call('reddit_thread', { url_or_id: candidates.details.posts[0].id, top_comments: 2, comment_limit: 10 });
  const discussions = await call('reddit_trends', { subreddits: 'LocalLLaMA', listing: 'top', time: 'month', limit: 3, order: 'reddit' });
  const discussion = [...discussions.details.posts].sort((a, b) => b.numComments - a.numComments)[0];
  assert.ok(discussion, 'No discussion available for expansion smoke check');
  const threadArgs = { url_or_id: discussion.id, comment_limit: 5, top_comments: 40 };
  const initial = await call('reddit_thread', threadArgs);
  assert.ok(initial.details.more.hiddenIds > 0, 'No collapsed ids available; expansion smoke not exercised');
  const originalFetch = globalThis.fetch;
  let expansionHttp = 0;
  const batches = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/morechildren') {
      expansionHttp++;
      const ids = url.searchParams.get('children').split(',');
      assert.ok(ids.length <= 100, 'Expansion exceeded 100 ids per request');
      batches.push(ids.length);
    } else if (url.pathname.includes('/_/')) {
      expansionHttp++;
      assert.equal(url.searchParams.get('limit'), '200');
    }
    return originalFetch(input, options);
  };
  let expanded;
  try {
    expanded = await call('reddit_thread', { ...threadArgs, expand_more: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(expansionHttp > 0 && expansionHttp <= 2);
  assert.equal(expanded.details.expansion.requests, expansionHttp);
  assert.ok(expanded.details.comments_fetched >= initial.details.comments_fetched);
  assert.equal(new Set(expanded.details.comments.map((c) => c.id)).size, expanded.details.comments.length);
  assert.ok(expanded.details.expansion.pending_ids.every((id) => !expanded.details.expansion.unresolved_ids.includes(id)));
  console.log(`thread expansion: ${initial.details.comments_fetched} -> ${expanded.details.comments_fetched} fetched comments; ${expansionHttp} HTTP requests; batch sizes ${batches.join(',')}; pending ${expanded.details.expansion.pending_ids.length}; unresolved ${expanded.details.expansion.unresolved_ids.length}; stubs ${expanded.details.more.stubs}`);
  const largeThread = await call('reddit_thread', { url_or_id: discussion.id, comment_limit: 500, top_comments: 2 });
  assert.ok(largeThread.details.comments_fetched > 0);
  console.log(`500-comment fetch: ${largeThread.details.comments_fetched} visible comments parsed`);
  for (const sort of ['old', 'qa']) {
    const sorted = await call('reddit_thread', { url_or_id: discussion.id, sort, comment_limit: 30, top_comments: 2 });
    assert.equal(sorted.details.post.id, discussion.id);
    assert.ok(sorted.details.comments_fetched >= 0);
    console.log(`comment sort ${sort}: ${sorted.details.comments_fetched} visible comments parsed`);
  }
  // A real depth-limited response exposes continuation stubs without inventing fixture data.
  // This depth parameter is smoke-only; it is not a new public tool argument.
  const continuationFetch = globalThis.fetch;
  let continuationHttp = 0, continuationExtras = 0;
  globalThis.fetch = (input, options) => {
    const url = new URL(input);
    if (url.pathname === `/comments/${discussion.id}`) url.searchParams.set('depth', '1');
    if (url.pathname.includes('/_/')) { continuationHttp++; continuationExtras++; }
    else if (url.pathname === '/api/morechildren') continuationExtras++;
    return continuationFetch(url, options);
  };
  try {
    const args = { url_or_id: discussion.id, sort: 'old', comment_limit: 500, top_comments: 40 };
    const shallow = await call('reddit_thread', args);
    if (shallow.details.more.stubs) {
      const continued = await call('reddit_thread', { ...args, expand_more: 5 });
      assert.ok(continuationExtras > 0 && continuationExtras <= 5);
      assert.equal(continued.details.expansion.requests, continuationExtras);
      assert.ok(continued.details.comments_fetched >= shallow.details.comments_fetched);
      assert.equal(new Set(continued.details.comments.map((c) => c.id)).size, continued.details.comments.length);
      if (continuationHttp) {
        console.log(`continue-thread: ${continuationHttp} lookups in ${continuationExtras} shared extra HTTP requests; ${continued.details.expansion.stubs_resolved} resolved; ${continued.details.more.stubs} remain`);
      } else console.log('Continuation lookups unavailable in live budget: ordinary hidden ids consumed it; fixtures cover stub fetching.');
    } else console.log('No continuation stubs in the live depth-limited response; fixtures cover stub fetching.');
  } finally {
    globalThis.fetch = continuationFetch;
  }
  const pack = await call('reddit_pack', { topic: 'python', subreddits: 'learnpython', depth: 'quick', max_posts: 2, comments_per_post: 2 });
  assert.ok(pack.details.posts.length > 0);
  assert.ok(pack.details.commented_post_count > 0);
  const subreddits = await call('reddit_subreddits', { query: 'python', limit: 2 });
  assert.ok(subreddits.details.subreddits.length > 0);
  const resolved = await call('reddit_resolve_subreddits', { topic: 'python', limit: 2, refresh: true });
  assert.ok(resolved.details.subreddits.length > 0);
  console.log('Live Reddit smoke checks passed (including raw_json title preservation).');
} catch (error) {
  console.error(`Live Reddit smoke blocked/failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  rmSync(cache, { recursive: true, force: true });
}
