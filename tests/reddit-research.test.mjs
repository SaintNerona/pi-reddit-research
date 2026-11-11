import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { loadTools, invoke, piDist } from './pi-harness.mjs';

const cache = mkdtempSync(join(tmpdir(), 'pi-reddit-mock-'));
process.env.PI_REDDIT_CACHE_DIR = cache;
process.env.PI_REDDIT_SQLITE_PATH = join(cache, 'reddit.sqlite');
process.env.PI_REDDIT_CONFIG_PATH = join(cache, 'no-config.json');
process.env.PI_REDDIT_COOKIE = 'synthetic-test-cookie';
process.env.PI_REDDIT_DELAY_MS = '250';
process.env.PI_REDDIT_MAX_OUTPUT_CHARS = '2000';
process.env.PI_REDDIT_STATUS_FOOTER = 'false';
const originalFetch = globalThis.fetch;
let respond;
const requests = [];
const realNow = Date.now;
let clockFloor = 0;
Date.now = () => Math.max(realNow(), clockFloor);
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  requests.push(url);
  if (options.signal?.aborted) throw options.signal.reason;
  return respond(url, options);
};
after(() => { Date.now = realNow; globalThis.fetch = originalFetch; db.close(); rmSync(cache, { recursive: true, force: true }); });
const extension = await loadTools();
const db = new DatabaseSync(process.env.PI_REDDIT_SQLITE_PATH);
const requestRow = (url) => db.prepare('SELECT * FROM requests WHERE url = ?').get(String(url));
const seedRequest = (url, data, expiresAt) => db.prepare(
  'INSERT OR REPLACE INTO requests (url, status, saved_at, expires_at, raw_json) VALUES (?, 200, ?, ?, ?)'
).run(String(url), Date.now(), expiresAt, JSON.stringify(data));
const listing = (children, after) => ({ kind: 'Listing', data: { children, after: after ?? null } });
const post = (id, subreddit = 'Alpha', score = 1, long = false) => ({ kind: 't3', data: {
  id, name: `t3_${id}`, subreddit, title: long ? 'large post '.repeat(120) : `source ${id}`,
  author: 'testuser', score, num_comments: 4, created_utc: 1700000000,
  permalink: `/r/${subreddit}/comments/${id}/source/`, selftext: 'body evidence '.repeat(long ? 100 : 3),
} });
const comment = (id, body = 'A useful fix: upgrade the configuration.', score = 1) => ({ kind: 't1', data: {
  id, name: `t1_${id}`, author: 'testuser', body, score, parent_id: 't3_abc123', subreddit: 'Alpha',
  permalink: `/r/Alpha/comments/abc123/source/${id}/`,
} });
const ok = (data) => Response.json(data);
const call = async (name, args) => {
  const result = await invoke(extension, name, args);
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.ok(result.content.every((item) => item.type === 'text'));
  assert.ok(result.content[0].text.length <= 2000);
  return result;
};
const text = (result) => result.content[0].text;

test('Pi loader registers eight tools and all prepared arguments validate', async () => {
  assert.equal(extension.tools.size, 8);
  const { validateToolArguments } = await import('@earendil-works/pi-ai');
  const examples = {
    reddit_url_extract: { url_or_id: 't3_abc123' }, reddit_resolve_subreddits: { topic: 'test' },
    reddit_pack: { topic: 'test', subreddits: ['r/Alpha', 'Beta'] },
    reddit_search: { query: 'test', subreddits: ['Alpha'] }, reddit_thread: { url_or_id: 'abc123' },
    reddit_user: { username: 'u/testuser', sections: 'comments' },
    reddit_subreddits: { query: 'test' }, reddit_trends: { subreddits: 'Alpha,Beta' },
  };
  for (const [name, args] of Object.entries(examples)) {
    const tool = extension.tools.get(name).definition;
    validateToolArguments(tool, { type: 'toolCall', id: name, name, arguments: tool.prepareArguments(args) });
    validateToolArguments(tool, { type: 'toolCall', id: name, name, arguments: tool.prepareArguments({}) });
  }
});

test('reddit_user comments-only and default sections execute through the Pi agent loop', async () => {
  respond = (url) => url.pathname.endsWith('/about')
    ? ok({ kind: 't2', data: { name: 'testuser', id: 'abc', created_utc: 1700000000, link_karma: 5, subreddit: null } })
    : url.pathname.endsWith('/comments') ? ok(listing([comment('comm01', 'yes'), comment('comm02')], 't1_comm02'))
      : ok(listing([post('abc123')], 't3_abc123'));
  const before = requests.length;
  const only = await call('reddit_user', { username: 'u/testuser', sections: 'comments', limit: 2 });
  assert.equal(only.details.posts.length, 0);
  assert.equal(only.details.about, undefined);
  assert.equal(only.details.comments.length, 2);
  assert.deepEqual(requests.slice(before).map((url) => url.pathname), ['/user/testuser/comments']);
  assert.match(text(only), /after_comments=t1_comm02/);
  const defaults = await call('reddit_user', { username: 'testuser' });
  assert.equal(defaults.details.about.username, 'testuser');
  assert.equal(defaults.details.about.profileVisible, false);
  assert.equal(defaults.details.posts.length, 1);
});

for (const name of ['reddit_search', 'reddit_trends', 'reddit_subreddits', 'reddit_user', 'reddit_pack']) {
  test(`${name} keeps continuation instructions when the body is truncated`, async () => {
    respond = (url) => {
      if (url.pathname.startsWith('/comments/')) return ok([listing([post('abc123')]), listing([comment('comm03')])]);
      if (url.pathname.startsWith('/subreddits/')) return ok(listing(Array.from({ length: 25 }, (_, i) => ({ kind: 't5', data: {
        display_name: `Sub${i}`, title: 'community '.repeat(100), public_description: 'description '.repeat(100),
      } })), 't5_nextpage'));
      return ok(listing(Array.from({ length: 14 }, (_, i) => post(`page${i}`, 'Alpha', i, true)), 't3_nextpage'));
    };
    const args = name === 'reddit_user' ? { username: 'longuser', sections: 'posts', limit: 14 }
      : name === 'reddit_trends' ? { subreddits: 'LongSub', limit: 14 }
        : name === 'reddit_pack' ? { topic: 'longpack', depth: 'deep' }
          : { query: `long-${name}`, limit: 25 };
    const result = await call(name, args);
    assert.match(text(result), /truncated/);
    assert.match(text(result), name === 'reddit_user' ? /after_posts=t3_nextpage/ : /after=t[35]_nextpage/);
  });
}

for (const name of ['reddit_search', 'reddit_pack', 'reddit_trends']) {
  test(`${name} multi-subreddit cursors never advance past an unreturned post`, async () => {
    respond = (url) => {
      if (url.pathname.startsWith('/comments/')) return ok([listing([post('alpha1')]), listing([comment('com004')])]);
      const alpha = url.pathname.includes('/Alpha/');
      // Lowest-ranked item comes first in Beta: an end-of-listing cursor would skip it.
      const children = alpha ? [post('alpha1', 'Alpha', 100000), post('alpha2', 'Alpha', 99999)]
        : [post('beta01', 'Beta', 0), post('beta02', 'Beta', 99998)];
      return ok(listing(children, alpha ? 't3_alpha2' : 't3_beta02'));
    };
    const args = name === 'reddit_pack' ? { topic: 'multi-pack', subreddits: 'Alpha,Beta', max_posts: 1 }
      : name === 'reddit_search' ? { query: 'multi-search', subreddits: 'Alpha,Beta', limit: 1 }
        : { subreddits: 'Alpha,Beta', limit: 1 };
    const result = await call(name, args);
    assert.equal(result.details.posts.length, 1);
    assert.equal(result.details.cursors.per_subreddit.Alpha.after, 't3_alpha1');
    assert.equal(result.details.cursors.per_subreddit.Beta.after, undefined);
    assert.equal(result.details.cursors.per_subreddit.Beta.restart, true);
    assert.match(text(result), /Beta.*without after/);
  });
}

test('single listing pages use distinct URLs/cache keys and have no overlapping ids', async () => {
  respond = (url) => ok(url.searchParams.has('after')
    ? listing([post('second1')]) : listing([post('first01')], 't3_first01'));
  const first = await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1 });
  const second = await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1, after: first.details.cursors.after });
  assert.deepEqual(first.details.posts.map((p) => p.id), ['first01']);
  assert.deepEqual(second.details.posts.map((p) => p.id), ['second1']);
  const before = requests.length;
  await call('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1 });
  assert.equal(requests.length, before, 'page one should now come from SQLite');
});

test('multi-subreddit safe boundaries can recover every hidden result when narrowed', async () => {
  const pages = {
    RecoverA: [post('recova1', 'RecoverA', 100), post('recova2', 'RecoverA', 10), post('recova3', 'RecoverA', 2)],
    RecoverB: [post('recovb1', 'RecoverB', 0), post('recovb2', 'RecoverB', 99999), post('recovb3', 'RecoverB', 5)],
  };
  respond = (url) => {
    const subreddit = url.pathname.split('/')[2];
    const children = pages[subreddit];
    const after = url.searchParams.get('after');
    const start = after ? children.findIndex((p) => p.data.name === after) + 1 : 0;
    const end = start + Number(url.searchParams.get('limit'));
    return ok(listing(children.slice(start, end), end < children.length ? children[Math.min(end, children.length) - 1].data.name : undefined));
  };
  const scope = await call('reddit_search', { query: 'recover-hidden', subreddits: 'RecoverA,RecoverB', limit: 2 });
  const found = new Set(scope.details.posts.map((p) => p.id));
  for (const [subreddit, cursor] of Object.entries(scope.details.cursors.per_subreddit)) {
    let after = cursor.after;
    if (!cursor.restart && !after) continue;
    for (let page = 0; page < 4; page++) {
      const next = await call('reddit_search', { query: 'recover-hidden', subreddits: subreddit, limit: 2, after });
      next.details.posts.forEach((p) => found.add(p.id));
      after = next.details.cursors.after;
      if (!after) break;
    }
  }
  assert.deepEqual([...found].sort(), Object.values(pages).flat().map((p) => p.data.id).sort());
});

test('multi-subreddit after is ignored and reported, including under truncation', async () => {
  respond = () => ok(listing([post('ignored1', 'IgnoreA', 1, true)], 't3_ignored1'));
  const before = requests.length;
  const result = await call('reddit_search', { query: 'ignored-after', subreddits: 'IgnoreA,IgnoreB', after: 't3_previous', limit: 1 });
  assert.equal(result.details.cursors.after_ignored, true);
  assert.ok(requests.slice(before).every((url) => !url.searchParams.has('after')));
  assert.match(text(result), /after was ignored/);
});

test('user cursors are independent, wrong-prefix cursors are reported, partial failures survive', async () => {
  respond = (url) => {
    if (url.pathname.endsWith('/about')) return new Response('No such user', { status: 404 });
    if (url.pathname.endsWith('/comments')) return ok(listing([comment('part001')], 't1_part001'));
    return ok(listing([post('part001')], 't3_part001'));
  };
  const before = requests.length;
  const result = await call('reddit_user', { username: 'partialuser', sections: 'about,posts,comments',
    after_posts: 't1_wrong', after_comments: 't1_valid' });
  assert.equal(result.details.posts.length, 1);
  assert.equal(result.details.comments.length, 1);
  assert.equal(result.details.errors.length, 2);
  assert.match(text(result), /expected a t3_/);
  const calls = requests.slice(before);
  assert.equal(calls.find((url) => url.pathname.endsWith('/submitted')).searchParams.get('after'), null);
  assert.equal(calls.find((url) => url.pathname.endsWith('/comments')).searchParams.get('after'), 't1_valid');
});

test('malformed usernames fail before network access and bound echoed input', async () => {
  const before = requests.length;
  const result = await invoke(extension, 'reddit_user', { username: 'x'.repeat(10000) });
  assert.equal(result.isError, true);
  assert.match(text(result), /10000 characters/);
  assert.ok(text(result).length < 200);
  assert.equal(requests.length, before);
});

test('remaining tools, evidence packs, commands and default TUI rendering work on current Pi', async () => {
  respond = (url) => {
    if (url.pathname.startsWith('/comments/')) return ok([listing([post('smoke01')]), listing([comment('smokeco')])]);
    if (url.pathname.startsWith('/subreddits/')) return ok(listing([{ kind: 't5', data: { display_name: 'SmokeSub', title: 'smoke topic', subscribers: 42 } }]));
    return ok(listing([post('smoke01', 'SmokeSub')]));
  };
  const extracted = await call('reddit_url_extract', { url_or_id: 'https://www.reddit.com/user/testuser/m/example/' });
  assert.equal(extracted.details.multireddit, 'example');
  const thread = await call('reddit_thread', { url_or_id: 'smoke01', top_comments: 2 });
  assert.equal(thread.details.comments[0].parentId, 't3_abc123');
  const resolved = await call('reddit_resolve_subreddits', { topic: 'smoke topic', refresh: true });
  assert.equal(resolved.details.subreddits[0].subreddit, 'SmokeSub');
  const pack = await call('reddit_pack', { topic: 'smoke-pack', depth: 'quick' });
  assert.equal(pack.details.commented_post_count, 1);
  assert.ok(pack.details.evidence_items.some((item) => item.kind === 'comment'));
  assert.ok(Object.keys(pack.details.clusters).length > 0);

  const notifications = [];
  const ctx = { ui: { notify: (message, level) => notifications.push({ message, level }) } };
  const command = extension.commands.get('reddit');
  await command.handler('status', ctx);
  await command.handler('search smoke-command', ctx);
  await command.handler('search', ctx);
  await command.handler('unknown', ctx);
  assert.deepEqual(notifications.map((n) => n.level), ['info', 'info', 'warning', 'warning']);
  assert.match(notifications[0].message, /Cookies: set/);

  const { initTheme } = await import(pathToFileURL(join(piDist, 'modes/interactive/theme/theme.js')));
  const { ToolExecutionComponent } = await import(pathToFileURL(join(piDist, 'modes/interactive/components/tool-execution.js')));
  initTheme('dark', false);
  const component = new ToolExecutionComponent('reddit_pack', 'render-test', { topic: 'smoke-pack' }, {},
    extension.tools.get('reddit_pack').definition, { requestRender() {} }, process.cwd());
  component.updateResult(pack);
  assert.ok(component.render(100).length > 0);
  component.setExpanded(true);
  assert.match(component.render(100).join('\n'), /Reddit research pack/);
});

test('reddit_user respects cancellation instead of fetching remaining sections', async () => {
  const controller = new AbortController();
  respond = () => { controller.abort(new Error('cancelled-test')); throw controller.signal.reason; };
  const tool = extension.tools.get('reddit_user').definition;
  const before = requests.length;
  await assert.rejects(() => tool.execute('cancel-test', tool.prepareArguments({ username: 'canceluser', sections: 'about,posts,comments' }), controller.signal), /cancelled-test/);
  assert.equal(requests.length - before, 1);
});

test('all request families use api.reddit.com without changing public URLs', async () => {
  respond = (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, 'synthetic-test-cookie');
    assert.equal(url.searchParams.get('raw_json'), '1');
    if (url.pathname.startsWith('/comments/')) return ok([listing([post('host001')]), listing([comment('hostcom')])]);
    if (url.pathname.endsWith('/about')) return ok({ kind: 't2', data: { name: 'hostuser', subreddit: null } });
    if (url.pathname.startsWith('/subreddits/')) return ok(listing([{ kind: 't5', data: { display_name: 'HostSub' } }]));
    return ok(listing([post('host001')]));
  };
  const pathsFor = async (name, args) => {
    const before = requests.length;
    const result = await call(name, args);
    if (result.details.posts) result.details.posts.forEach((p) => assert.equal(new URL(p.url).host, 'www.reddit.com'));
    return requests.slice(before).map((u) => {
      assert.equal(u.origin, 'https://api.reddit.com');
      assert.ok(!u.pathname.endsWith('.json'));
      return u.pathname;
    });
  };
  assert.deepEqual(await pathsFor('reddit_search', { query: 'host-global' }), ['/search']);
  assert.deepEqual(await pathsFor('reddit_search', { query: 'host-sub', subreddits: 'HostSub' }), ['/r/HostSub/search']);
  assert.deepEqual(await pathsFor('reddit_trends', { subreddits: 'all', listing: 'hot' }), ['/r/all/hot']);
  assert.deepEqual(await pathsFor('reddit_trends', { subreddits: 'HostSub', listing: 'hot' }), ['/r/HostSub/hot']);
  assert.deepEqual(await pathsFor('reddit_user', { username: 'hostuser', sections: 'about,posts,comments' }),
    ['/user/hostuser/about', '/user/hostuser/submitted', '/user/hostuser/comments']);
  assert.deepEqual(await pathsFor('reddit_thread', { url_or_id: 'host001' }), ['/comments/host001']);
  const thread = await call('reddit_thread', { url_or_id: 'host001' });
  assert.equal(new URL(thread.details.comments[0].url).host, 'www.reddit.com');
  assert.deepEqual(await pathsFor('reddit_subreddits', { query: 'host-subs' }), ['/subreddits/search']);
  assert.deepEqual(await pathsFor('reddit_pack', { topic: 'host-pack', depth: 'quick' }), ['/search', '/comments/host001']);
  assert.deepEqual(await pathsFor('reddit_resolve_subreddits', { topic: 'host-resolver', refresh: true }), ['/subreddits/search', '/search']);
  const extracted = await call('reddit_url_extract', { url_or_id: 'https://old.reddit.com/r/Alpha/comments/host001/source/' });
  assert.equal(new URL(extracted.details.canonical_url).host, 'www.reddit.com');
});

test('request normalization preserves encoded segments, query values, cursors and raw text', async () => {
  const title = 'Read <b>A & B</b> &amp; C.json';
  respond = () => { const item = post('rawtext'); item.data.title = title; return ok(listing([item])); };
  const query = 'routing.json & raw_json=0 <tag>';
  const result = await call('reddit_search', { query, subreddits: 'Route.json/Inner', sort: 'new', time: 'month', limit: 3, after: 't3_prev.json' });
  const url = requests.at(-1);
  assert.equal(url.pathname, '/r/Route.json%2FInner/search');
  assert.equal(url.searchParams.get('q'), query);
  assert.equal(url.searchParams.get('after'), 't3_prev.json');
  assert.equal(url.searchParams.get('sort'), 'new');
  assert.equal(url.searchParams.get('t'), 'month');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(url.searchParams.get('restrict_sr'), '1');
  assert.deepEqual(url.searchParams.getAll('raw_json'), ['1']);
  assert.deepEqual([...url.searchParams.keys()], ['after', 'limit', 'q', 'raw_json', 'restrict_sr', 'sort', 't']);
  assert.equal(result.details.posts[0].title, title);
});

test('empty Listings and threads with no comments are valid and cached', async () => {
  respond = (url) => ok(url.pathname.startsWith('/comments/') ? [listing([post('empty01')]), listing([])] : listing([]));
  const empty = await call('reddit_search', { query: 'empty-listing' });
  assert.deepEqual(empty.details.posts, []);
  assert.ok(requestRow(requests.at(-1)).raw_json);
  const user = await call('reddit_user', { username: 'emptyuser', sections: 'posts,comments' });
  assert.deepEqual(user.details.errors, []);
  const thread = await call('reddit_thread', { url_or_id: 'empty01' });
  assert.deepEqual(thread.details.comments, []);
});

test('invalid successful responses never become cached/indexed empty successes', async () => {
  const invalid = [
    () => new Response('<html>secret-body</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{ secret-body'),
    () => ok({ error: 403, message: 'secret-body' }),
    () => ok({ kind: 'Listing', data: {} }),
    () => ok({ kind: 'Listing', data: { children: null } }),
    () => ok(null),
  ];
  for (const [i, response] of invalid.entries()) {
    respond = response;
    const args = { query: `invalid-${i}-private-query` };
    const result = await invoke(extension, 'reddit_search', args);
    assert.equal(result.isError, true);
    assert.match(text(result), /REDDIT_API_INVALID_RESPONSE: api\.reddit\.com\/search.*HTTP 200.*Listing/);
    assert.doesNotMatch(text(result), /private-query|secret-body|synthetic-test-cookie|raw_json|\?/);
    assert.equal(requestRow(requests.at(-1)), undefined);
    const before = requests.length;
    respond = () => ok(listing([]));
    await call('reddit_search', args);
    assert.equal(requests.length, before + 1, 'invalid responses must not poison cache');
  }
  for (const [i, payload] of [[], [listing([])], [listing([]), listing([])], [listing([post('noindex')]), {}]].entries()) {
    respond = () => ok(payload);
    const result = await invoke(extension, 'reddit_thread', { url_or_id: `badthr${i}` });
    assert.equal(result.isError, true);
    assert.match(text(result), /REDDIT_API_INVALID_RESPONSE.*thread/);
    assert.equal(requestRow(requests.at(-1)), undefined);
  }
  assert.equal(db.prepare('SELECT id FROM posts WHERE id = ?').get('noindex'), undefined);
  for (const [i, payload] of [{ data: { name: 'missingkind' } }, { kind: 't2', data: {} }, { kind: 't2', data: { name: 123 } }].entries()) {
    respond = () => ok(payload);
    const result = await call('reddit_user', { username: `baduser${i}`, sections: 'about' });
    assert.equal(result.details.errors.length, 1);
    assert.match(text(result), /fetch errors: about: REDDIT_API_INVALID_RESPONSE/);
    assert.equal(requestRow(requests.at(-1)), undefined);
  }
});

test('malformed cached payloads are ignored before fetch and on stale fallback', async () => {
  const url = 'https://api.reddit.com/search?limit=8&q=bad-cache&raw_json=1&sort=relevance&t=year';
  seedRequest(url, { kind: 'Listing', data: {} }, Date.now() + 60000);
  const before = requests.length;
  respond = () => ok(listing([post('cacheok')]));
  await call('reddit_search', { query: 'bad-cache' });
  assert.equal(requests.length, before + 1);
  assert.deepEqual(JSON.parse(requestRow(url).raw_json), listing([post('cacheok')]));
  seedRequest(url, { error: 'bad stale cache' }, Date.now() - 1);
  respond = () => new Response('secret-body', { status: 503 });
  const failed = await invoke(extension, 'reddit_search', { query: 'bad-cache' });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /HTTP 503/);
});

test('endpoint errors bypass stale data and sanitize transport and redirect details', async () => {
  const cases = [
    ['REDDIT_API_REDIRECT', () => new Response(null, { status: 301, headers: { location: 'https://api.reddit.com/login?secret-target' } })],
    ['REDDIT_API_REDIRECT', () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/?secret-target' } })],
    ['REDDIT_API_ENDPOINT_GONE', () => new Response('secret-body', { status: 410 })],
    ['REDDIT_API_UNAVAILABLE', () => { throw new TypeError('synthetic-test-cookie secret-network'); }],
    ['REDDIT_API_INVALID_RESPONSE', () => ok({ error: 'secret-body' })],
    ['REDDIT_API_INVALID_RESPONSE', () => new Response('secret-body')],
  ];
  for (const [i, [code, response]] of cases.entries()) {
    const query = `stale-private-${i}`;
    respond = () => ok(listing([post(`stale${i}`)]));
    await call('reddit_search', { query });
    const url = requests.at(-1);
    db.prepare('UPDATE requests SET expires_at = 0 WHERE url = ?').run(String(url));
    const before = requests.length;
    respond = (_url, options) => { assert.equal(options.redirect, 'manual'); return response(); };
    const result = await invoke(extension, 'reddit_search', { query });
    assert.equal(result.isError, true, 'stale evidence must not conceal endpoint failures');
    assert.match(text(result), new RegExp(code));
    assert.doesNotMatch(text(result), /private|secret-|synthetic-test-cookie|evil\.invalid|\?/);
    assert.equal(requests.length, before + 1, 'must not follow redirects or retry');
    assert.equal(requestRow(url).expires_at, 0, 'failed response must not overwrite stale valid payload');
  }
});

test('HTTP authentication, missing routes and server errors preserve status and stale fallback', async () => {
  for (const status of [401, 404, 503]) {
    respond = () => new Response('secret-body', { status });
    const result = await invoke(extension, 'reddit_search', { query: `http-${status}` });
    assert.equal(result.isError, true);
    assert.equal(text(result), `Reddit JSON HTTP ${status}`);
    assert.doesNotMatch(text(result), /REDDIT_API_|secret-body/);
    const url = requests.at(-1);
    seedRequest(url, listing([post(`http${status}`)]), Date.now() - 1);
    const stale = await call('reddit_search', { query: `http-${status}` });
    assert.equal(stale.details.posts[0].id, `http${status}`);
  }
});

test('pack and user partial failures are visible even under output truncation', async () => {
  respond = (url) => url.pathname.startsWith('/comments/') || url.pathname.endsWith('/about')
    ? ok({ error: 'changed' }) : ok(listing([post('partialpack', 'Alpha', 1, true)]));
  const pack = await call('reddit_pack', { topic: 'partial-pack-errors', depth: 'quick' });
  assert.equal(pack.details.posts.length, 1);
  assert.equal(pack.details.commented_post_count, 0);
  assert.match(pack.details.errors[0], /REDDIT_API_INVALID_RESPONSE/);
  assert.match(text(pack), /fetch errors: thread partialpack: REDDIT_API_INVALID_RESPONSE/);
  const user = await call('reddit_user', { username: 'contractuser', sections: 'about,posts' });
  assert.equal(user.details.posts.length, 1);
  assert.match(text(user), /fetch errors: about: REDDIT_API_INVALID_RESPONSE/);
  respond = () => ok({ error: 'changed' });
  const resolver = await invoke(extension, 'reddit_resolve_subreddits', { topic: 'contract-resolver', refresh: true });
  assert.equal(resolver.isError, true);
  assert.match(text(resolver), /REDDIT_API_INVALID_RESPONSE/);
});

test('cancellation before cache, during body parsing and in pack threads is preserved', async () => {
  const execute = (name, args, signal) => {
    const tool = extension.tools.get(name).definition;
    return tool.execute('abort-test', tool.prepareArguments(args), signal);
  };
  const pre = new AbortController();
  pre.abort(new Error('cancel-before-fetch'));
  const before = requests.length;
  await assert.rejects(() => execute('reddit_search', { query: 'cache-pagination', subreddits: 'PageSub', limit: 1 }, pre.signal), /cancel-before-fetch/);
  assert.equal(requests.length, before);
  const body = new AbortController();
  respond = () => ({ status: 200, ok: true, json: async () => { body.abort(new Error('cancel-body')); throw body.signal.reason; } });
  await assert.rejects(() => execute('reddit_search', { query: 'abort-body' }, body.signal), /cancel-body/);
  const pack = new AbortController();
  respond = (url) => {
    if (url.pathname.startsWith('/comments/')) { pack.abort(new Error('cancel-pack')); throw pack.signal.reason; }
    return ok(listing([post('abortpack')]));
  };
  await assert.rejects(() => execute('reddit_pack', { topic: 'abort-pack', depth: 'quick' }, pack.signal), /cancel-pack/);
  respond = () => { throw new DOMException('cancel-fetch', 'AbortError'); };
  await assert.rejects(() => execute('reddit_search', { query: 'abort-without-signal' }), /cancel-fetch/);
});

test('multiple long thread errors cannot push the visible error summary out of the output budget', async () => {
  respond = (url) => url.pathname.startsWith('/comments/')
    ? new Response(null, { status: 410 })
    : ok(listing(Array.from({ length: 12 }, (_, i) => post(`manyerrors${i}`, 'Alpha', i, true)), 't3_next'));
  const result = await call('reddit_pack', { topic: 'many-thread-failures', depth: 'deep' });
  assert.ok(result.details.errors.join('; ').length > 1000);
  assert.match(text(result), /fetch errors:.*REDDIT_API_ENDPOINT_GONE/);
  assert.match(text(result), /after=t3_next/);
});

test('live smoke stops on observed HTTP 429 and restores fetch (synthetic HTTP)', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    let requests = 0;
    const fakeFetch = globalThis.fetch = async () => {
      requests++;
      return new Response(null, { status: 429 });
    };
    await import('./scripts/smoke-live.mjs');
    assert.equal(requests, 1);
    assert.equal(globalThis.fetch, fakeFetch);
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stderr, /HTTP 429: validation blocked/);
  assert.doesNotMatch(child.stdout, /Live Reddit smoke checks passed/);
});

// Last: virtual time isolates module-global cooldown without a production reset API.
// Every post-cooldown case asserts that it actually reaches fetch.
test('403/429 cooldowns respect Retry-After, allow valid stale data and reject invalid stale data', async (t) => {
  let now = Date.now() + 1000;
  t.after(() => { clockFloor = now; });
  t.mock.method(Date, 'now', () => now);
  for (const status of [403, 429]) {
    const query = `cooldown-${status}`;
    respond = () => new Response('secret-body', { status, headers: { 'retry-after': '2' } });
    const before = requests.length;
    const result = await invoke(extension, 'reddit_search', { query });
    assert.equal(requests.length, before + 1);
    assert.equal(result.isError, true);
    assert.match(text(result), new RegExp(`HTTP ${status}; cooldown started`));
    assert.doesNotMatch(text(result), /REDDIT_API_|secret-body/);
    const url = requests.at(-1);
    now += 1000;
    seedRequest(url, listing([post(`stale${status}`)]), now - 1);
    const stale = await call('reddit_search', { query });
    assert.equal(stale.details.posts[0].id, `stale${status}`);
    assert.equal(requests.length, before + 1, 'cooldown stale hit must not fetch');
    seedRequest(url, { error: 'invalid cached payload' }, now - 1);
    const blocked = await invoke(extension, 'reddit_search', { query });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /cooling down for 1s/);
    now += 1001;
    respond = () => new Response('secret-body', { status, headers: { 'retry-after': '2' } });
    seedRequest(url, listing([post(`stale${status}`)]), now - 1);
    const fallback = await call('reddit_search', { query });
    assert.equal(fallback.details.posts[0].id, `stale${status}`);
    assert.equal(requests.length, before + 2, 'expired cooldown must fetch, then allow stale fallback');
    now += 2001;
  }
  respond = () => new Response(null, { status: 429 });
  const before = requests.length;
  await invoke(extension, 'reddit_search', { query: 'default-cooldown' });
  const blocked = await invoke(extension, 'reddit_search', { query: 'after-default-cooldown' });
  assert.match(text(blocked), /cooling down for 300s/);
  assert.equal(requests.length, before + 1);
  now += 300001;
  respond = () => ok(listing([]));
  await call('reddit_search', { query: 'after-default-cooldown' });
  assert.equal(requests.length, before + 2);
});

for (const mode of ['rising', 'controversial']) {
  test(`${mode} defaults to Reddit order and only controversial sends the time window`, async () => {
    respond = () => ok(listing([post('native1', mode, 0), post('native2', mode, 100000)], 't3_native2'));
    const before = requests.length;
    const result = await call('reddit_trends', { subreddits: `Native${mode}`, listing: mode, time: 'month', limit: 2 });
    assert.deepEqual(result.details.posts.map((p) => p.id), ['native1', 'native2']);
    assert.equal(result.details.order, 'reddit');
    assert.equal(result.details.cursors.after, 't3_native2');
    const [url] = requests.slice(before);
    assert.equal(url.pathname, `/r/Native${mode}/${mode}`);
    assert.equal(url.searchParams.get('t'), mode === 'controversial' ? 'month' : null);
    const ranked = await call('reddit_trends', { subreddits: `Native${mode}`, listing: mode, time: 'month', limit: 2, order: 'ranked' });
    assert.deepEqual(ranked.details.posts.map((p) => p.id), ['native2', 'native1']);
    assert.equal(requests.length - before, 1, 'order changes reuse the same cached listing');
  });
}

for (const mode of ['hot', 'top', 'new']) {
  test(`${mode} keeps ranked defaults and supports explicit Reddit order`, async () => {
    respond = () => ok(listing([post('legacy1', 'Legacy', 0), post('legacy2', 'Legacy', 100000)]));
    const before = requests.length;
    const args = { subreddits: `Legacy${mode}`, listing: mode, time: 'day', limit: 2 };
    const ranked = await call('reddit_trends', args);
    assert.deepEqual(ranked.details.posts.map((p) => p.id), ['legacy2', 'legacy1']);
    assert.equal(ranked.details.order, 'ranked');
    assert.equal(requests[before].searchParams.get('t'), mode === 'top' ? 'day' : null);
    const native = await call('reddit_trends', { ...args, order: 'reddit' });
    assert.deepEqual(native.details.posts.map((p) => p.id), ['legacy1', 'legacy2']);
  });
}

test('native multi-subreddit ordering interleaves positions and preserves safe cursor boundaries', async () => {
  respond = (url) => {
    const sub = url.pathname.split('/')[2];
    const isAlpha = sub === 'NativeA';
    return ok(listing([post(isAlpha ? 'intera1' : 'interb1', sub, 0), post(isAlpha ? 'intera2' : 'interb2', sub, 100000)], isAlpha ? 't3_intera2' : 't3_interb2'));
  };
  const before = requests.length;
  const result = await call('reddit_trends', { subreddits: 'NativeA,NativeB', listing: 'rising', limit: 3, after: 't3_ignored' });
  assert.deepEqual(result.details.posts.map((p) => p.id), ['intera1', 'interb1', 'intera2']);
  assert.equal(result.details.cursors.after_ignored, true);
  assert.equal(result.details.cursors.per_subreddit.NativeA.after, 't3_intera2');
  assert.equal(result.details.cursors.per_subreddit.NativeB.after, 't3_interb1');
  assert.ok(requests.slice(before).every((url) => !url.searchParams.has('after')));
  assert.match(text(result), /after was ignored/);
  assert.match(text(result), /listing\/time\/order/);
});

test('native ordering handles uneven and empty subreddit listings', async () => {
  respond = (url) => ok(listing(url.pathname.includes('/EmptyNative/') ? []
    : [post('uneven1'), post('uneven2'), post('uneven3')]));
  const result = await call('reddit_trends', { subreddits: 'EmptyNative,UnevenNative', listing: 'new', order: 'reddit', limit: 5 });
  assert.deepEqual(result.details.posts.map((p) => p.id), ['uneven1', 'uneven2', 'uneven3']);
});

for (const sub of ['all', 'popular']) {
  test(`r/${sub} uses the existing trends listing path and cursor`, async () => {
    respond = (url) => ok(url.searchParams.has('after')
      ? listing([post('feed002', 'ActualCommunity')])
      : listing([post('feed001', 'ActualCommunity')], 't3_feed001'));
    const before = requests.length;
    const args = { subreddits: sub, listing: 'hot', order: 'reddit', limit: 1 };
    const first = await call('reddit_trends', args);
    const second = await call('reddit_trends', { ...args, after: first.details.cursors.after });
    assert.deepEqual(first.details.posts.map((p) => p.id), ['feed001']);
    assert.deepEqual(second.details.posts.map((p) => p.id), ['feed002']);
    assert.ok(requests.slice(before).every((url) => url.pathname === `/r/${sub}/hot`));
    assert.equal(requests[before + 1].searchParams.get('after'), 't3_feed001');
  });
}

test('trends preparation normalizes listing/order and defaults invalid values safely', () => {
  const tool = extension.tools.get('reddit_trends').definition;
  assert.equal(tool.prepareArguments({ listing: ' RISING ', order: ' REDDIT ' }).order, 'reddit');
  assert.equal(tool.prepareArguments({ listing: 'controversial', order: 'invalid' }).order, 'reddit');
  assert.equal(tool.prepareArguments({ listing: 'hot', order: 'invalid' }).order, 'ranked');
  assert.equal(tool.prepareArguments({ listing: 'best' }).listing, 'hot');
});

const more = (children, parent = 't3_abc123', depth = 0, count = children.length) => ({ kind: 'more', data: {
  id: children.length ? children[0] : '_', parent_id: parent, depth, count, children,
} });
let expansionPostId;
const expansionParents = (things) => things.map((thing) => {
  if (thing?.data?.parent_id === 't3_abc123') thing.data.parent_id = `t3_${expansionPostId}`;
  return thing;
});
const threadPayload = (id, children, long = false) => {
  expansionPostId = id;
  return [listing([post(id, 'Alpha', 1, long)]), listing(expansionParents(children))];
};
const morePayload = (things) => ({ json: { errors: [], data: { things: expansionParents(things) } } });
const expansionRequests = (before) => requests.slice(before).filter((url) => url.pathname === '/api/morechildren');

test('reddit_thread fetch cap is 500, default remains 50, and expansion is opt-in', async () => {
  respond = (url) => ok(threadPayload(url.pathname.split('/')[2].replace('.json', ''), [comment('cap001'), more(['cap002'])]));
  const before = requests.length;
  const large = await call('reddit_thread', { url_or_id: 'cap500', comment_limit: 9999 });
  assert.equal(requests[before].searchParams.get('limit'), '500');
  assert.equal(large.details.more.hiddenIds, 1);
  assert.equal(large.details.expansion, undefined);
  assert.match(text(large), /not loaded: 1 known hidden comment ids/);
  await call('reddit_thread', { url_or_id: 'cap050' });
  assert.equal(requests[before + 1].searchParams.get('limit'), '50');
  assert.equal(expansionRequests(before).length, 0);
  const prepare = extension.tools.get('reddit_thread').definition.prepareArguments;
  assert.equal(prepare({ expand_more: 999 }).expand_more, 5);
  assert.equal(prepare({ expand_more: -1 }).expand_more, 0);
  assert.equal(prepare({ expand_more: '2' }).expand_more, 2);
});

test('collapsed branches, nested deleted parents and continue-thread stubs are reported under truncation', async () => {
  const removed = comment('gone00', '[removed]');
  removed.data.replies = listing([comment('kept00'), more(['hidden1', 'hidden1'], 't1_gone00', 1, 9)]);
  respond = () => ok(threadPayload('tree001', [removed, more([], 't1_kept00', 3, 0)], true));
  const before = requests.length;
  const result = await call('reddit_thread', { url_or_id: 'tree001', expand_more: 0 });
  assert.equal(requests.length - before, 1);
  assert.equal(result.details.comments.length, 1);
  assert.equal(result.details.comments[0].depth, 1);
  assert.equal(result.details.more.hiddenIds, 1, 'count is unique known ids, not Reddit count=9');
  assert.equal(result.details.more.stubs, 1);
  assert.equal(result.details.more.nodes[0].parentId, 't1_gone00');
  assert.deepEqual(result.details.more.nodes[0].children, ['hidden1']);
  assert.match(text(result), /truncated/);
  assert.match(text(result), /not loaded:/);
  assert.match(text(result), /continue-thread stubs: 1 \(not expanded\)/);
});

test('expansion chunks at 100 and spends at most its actual HTTP budget', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `wide${String(i).padStart(3, '0')}`);
  respond = (url) => url.pathname === '/api/morechildren'
    ? ok(morePayload(url.searchParams.get('children').split(',').map((id) => comment(id))))
    : ok(threadPayload('wide001', [comment('start01'), more(ids, 't3_wide001')]));
  const before = requests.length;
  const result = await call('reddit_thread', { url_or_id: 'wide001', expand_more: 2, top_comments: 40 });
  const calls = expansionRequests(before);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.searchParams.get('children').split(',').length <= 100));
  assert.equal(calls[0].searchParams.get('api_type'), 'json');
  assert.equal(calls[0].searchParams.get('link_id'), 't3_wide001');
  assert.equal(calls[0].searchParams.get('raw_json'), '1');
  assert.equal(calls[0].searchParams.has('limit_children'), false);
  assert.equal(result.details.comments_fetched, 201);
  assert.equal(result.details.expansion.comments_added, 200);
  assert.equal(result.details.expansion.requests, calls.length);
  assert.equal(result.details.expansion.pending_ids.length, 50);
  assert.deepEqual(result.details.expansion.unresolved_ids, []);
  assert.equal(result.details.more.hiddenIds, 50);
  assert.match(text(result), /loaded \+200 comments in 2 HTTP requests/);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(cache, 'reddit.sqlite'));
  try { assert.equal(db.prepare('SELECT post_id FROM comments WHERE id = ?').get('wide199').post_id, 'wide001'); }
  finally { db.close(); }
});

test('expand_more cannot exceed five HTTP requests even when every response reveals another branch', async () => {
  let step = 0;
  respond = (url) => {
    if (url.pathname !== '/api/morechildren') return ok(threadPayload('budget5', [more(['step000'])]));
    const id = `step${String(step++).padStart(3, '0')}`;
    return ok(morePayload([comment(id), more([`step${String(step).padStart(3, '0')}`])]));
  };
  const before = requests.length;
  const result = await call('reddit_thread', { url_or_id: 'budget5', expand_more: 999 });
  assert.equal(expansionRequests(before).length, 5);
  assert.equal(result.details.expansion.requests, 5);
  assert.equal(result.details.expansion.comments_added, 5);
  assert.deepEqual(result.details.expansion.pending_ids, ['step005']);
});

test('expansion follows nested more, deduplicates overlap/descendants, preserves depth and reports unresolved ids', async () => {
  let batch = 0;
  respond = (url) => {
    if (url.pathname !== '/api/morechildren') return ok(threadPayload('nested1', [comment('root001'), more(['childa', 'gone01']), more([], 't1_childb', 3)]));
    if (batch++ === 0) {
      const a = comment('childa'); Object.assign(a.data, { parent_id: 't1_root001', depth: 1, score: 10 });
      const b = comment('childb'); Object.assign(b.data, { parent_id: 't1_childa', depth: 2, score: 9 });
      return ok(morePayload([a, b, comment('root001'), comment('gone01', '[deleted]'), more(['childb', 'childc', 'childa']), more([], 't1_childb', 3)]));
    }
    assert.equal(url.searchParams.get('children'), 'childc');
    return ok(morePayload([comment('childa'), comment('childc'), more(['childa', 'gone01'])]));
  };
  const before = requests.length;
  const result = await call('reddit_thread', { url_or_id: 'nested1', expand_more: 5, top_comments: 40 });
  assert.equal(expansionRequests(before).length, 2);
  assert.equal(result.details.comments_fetched, 4);
  assert.equal(new Set(result.details.comments.map((c) => c.id)).size, 4);
  assert.equal(result.details.comments.find((c) => c.id === 'childb').depth, 2);
  assert.equal(result.details.comments.find((c) => c.id === 'childb').parentId, 't1_childa');
  assert.equal(result.details.expansion.comments_added, 3);
  assert.deepEqual(result.details.expansion.pending_ids, []);
  assert.deepEqual(result.details.expansion.unresolved_ids, ['gone01']);
  assert.equal(result.details.more.hiddenIds, 1);
  assert.equal(result.details.more.stubs, 1, 'same stub is not counted twice');
  assert.equal(result.details.expansion_stopped, undefined);
});

test('expansion prioritizes shallow branches, then larger branches, and keeps sort mapping', async () => {
  respond = (url) => url.pathname === '/api/morechildren' ? ok(morePayload([])) : ok(threadPayload('prior01', [
    more(['deep001'], 't1_deep', 3, 100), more(['small01'], 't3_prior01', 0, 1), more(['large01'], 't3_prior01', 0, 9),
  ]));
  const before = requests.length;
  const result = await call('reddit_thread', { url_or_id: 'prior01', sort: 'confidence', expand_more: 5 });
  const calls = expansionRequests(before);
  assert.equal(calls.length, 1, 'empty responses do not cause repeated attempts');
  assert.equal(calls[0].searchParams.get('children'), 'large01,small01,deep001');
  assert.equal(calls[0].searchParams.get('sort'), 'confidence');
  assert.equal(requests[before].searchParams.get('sort'), 'confidence');
  assert.equal(result.details.expansion.unresolved_ids.length, 3);
  assert.equal(result.details.expansion.pending_ids.length, 0);
});

test('cached expansions spend no HTTP budget and can continue to the next uncached batch', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `cache${String(i).padStart(3, '0')}`);
  respond = (url) => url.pathname === '/api/morechildren'
    ? ok(morePayload(url.searchParams.get('children').split(',').map((id) => comment(id))))
    : ok(threadPayload('cache01', [more(ids)]));
  const first = await call('reddit_thread', { url_or_id: 'cache01', expand_more: 1 });
  assert.equal(first.details.expansion.requests, 1);
  assert.equal(first.details.expansion.pending_ids.length, 50);
  const before = requests.length;
  const second = await call('reddit_thread', { url_or_id: 'cache01', expand_more: 1 });
  assert.equal(second.details.comments_fetched, 150);
  assert.equal(expansionRequests(before).length, 1);
  assert.equal(second.details.expansion.requests, 1);
  assert.equal(second.details.expansion.pending_ids.length, 0);
  const cached = await call('reddit_thread', { url_or_id: 'cache01', expand_more: 1 });
  assert.equal(cached.details.expansion.requests, 0);
  assert.equal(cached.details.comments_fetched, 150);
});

for (const kind of ['network', 'http', 'json-errors', 'malformed', 'invalid-json', 'invalid-node']) {
  test(`mid-expansion ${kind} failure preserves loaded evidence and reports why it stopped`, async () => {
    const id = `fail${['network', 'http', 'json-errors', 'malformed', 'invalid-json', 'invalid-node'].indexOf(kind)}00`;
    let batch = 0;
    respond = (url) => {
      if (url.pathname !== '/api/morechildren') return ok(threadPayload(id, [comment('before1'), more(['first01'])]));
      if (batch++ === 0) return ok(morePayload([comment('first01'), more(['second1'])]));
      if (kind === 'network') throw new Error('Synthetic network failure.');
      if (kind === 'http') return new Response('Synthetic server failure.', { status: 503 });
      if (kind === 'json-errors') return ok({ json: { errors: [['BAD_THING_ID', 'bad id', 'children']] } });
      if (kind === 'invalid-json') return new Response('{not json');
      if (kind === 'invalid-node') return ok(morePayload([{ kind: 't1', data: {} }]));
      return ok({ json: { errors: [], data: { things: 'not an array' } } });
    };
    const before = requests.length;
    const result = await call('reddit_thread', { url_or_id: id, expand_more: 5 });
    assert.equal(result.details.comments_fetched, 2);
    assert.deepEqual(result.details.comments.map((c) => c.id).sort(), ['before1', 'first01']);
    assert.equal(expansionRequests(before).length, 2);
    assert.equal(result.details.expansion.requests, 2);
    assert.equal(result.details.expansion.comments_added, 1);
    assert.deepEqual(result.details.expansion.unresolved_ids, ['second1']);
    assert.ok(result.details.expansion_stopped);
    assert.match(text(result), /expansion_stopped:/);
  });
}

test('continue-thread-only and fully loaded threads do not spend an expansion budget', async () => {
  respond = (url) => ok(threadPayload(url.pathname.split('/')[2].replace('.json', ''), url.pathname.includes('stub001') ? [more([], 't1_root', 4)] : [comment('full001')]));
  const before = requests.length;
  const stub = await call('reddit_thread', { url_or_id: 'stub001', expand_more: 5 });
  assert.equal(stub.details.more.stubs, 1);
  assert.equal(stub.details.expansion.requests, 0);
  assert.equal(stub.details.more.hiddenIds, 0);
  assert.doesNotMatch(text(stub), /Pass expand_more/);
  const full = await call('reddit_thread', { url_or_id: 'full001', expand_more: 5 });
  assert.equal(full.details.expansion.requests, 0);
  assert.equal(full.details.more.nodes.length, 0);
  assert.equal(expansionRequests(before).length, 0);
});

test('malformed child batches cannot overwrite indexed ownership before rejection', async () => {
  respond = (url) => url.pathname === '/api/morechildren'
    ? ok(threadPayload('wrongidx', [comment('indexpar'), comment('foreignxx')]))
    : ok(threadPayload('indexok', [comment('indexpar'), more(['indexkid'])]));
  const result = await call('reddit_thread', { url_or_id: 'indexok', expand_more: 1 });
  assert.ok(result.details.expansion_stopped);
  assert.equal(result.details.comments_fetched, 1);
  assert.equal(result.details.expansion.requests, 1);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(cache, 'reddit.sqlite'));
  try {
    assert.equal(db.prepare('SELECT post_id FROM comments WHERE id = ?').get('indexpar').post_id, 'indexok');
    assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get('foreignxx'), undefined);
    assert.equal(db.prepare('SELECT id FROM posts WHERE id = ?').get('wrongidx'), undefined);
  } finally { db.close(); }
});

for (const mismatch of ['post', 'parent', 'branch', 'nested']) {
  test(`expansion rejects ${mismatch} ownership mismatches before changing evidence`, async () => {
    const source = `own${mismatch}`;
    const foreign = comment('foreignown');
    Object.assign(foreign.data, { parent_id: 't3_otherown', link_id: 't3_otherown' });
    respond = () => ok(threadPayload('otherown', [foreign]));
    await call('reddit_thread', { url_or_id: 'otherown' });
    respond = (url) => {
      if (url.pathname !== '/api/morechildren') return ok(threadPayload(source, [comment('ownedroot'), more(['wantedown'])]));
      const good = comment('wantedown'); good.data.parent_id = `t3_${source}`;
      const bad = structuredClone(foreign);
      if (mismatch === 'post') bad.data.parent_id = `t3_${source}`;
      if (mismatch === 'parent') delete bad.data.link_id;
      if (mismatch === 'branch') { delete bad.data.link_id; bad.data.parent_id = 't1_unrelated'; }
      if (mismatch === 'nested') { good.data.replies = listing([bad]); return ok(morePayload([good])); }
      return ok(morePayload([good, bad]));
    };
    const result = await call('reddit_thread', { url_or_id: source, expand_more: 1 });
    assert.match(result.details.expansion_stopped, /another post|unrelated branch/);
    assert.equal(result.details.expansion.comments_added, 0);
    assert.deepEqual(result.details.comments.map((c) => c.id), ['ownedroot']);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(cache, 'reddit.sqlite'));
    try {
      assert.equal(db.prepare('SELECT post_id FROM comments WHERE id = ?').get('foreignown').post_id, 'otherown');
      assert.equal(db.prepare('SELECT id FROM comments WHERE id = ?').get('wantedown'), undefined);
    } finally { db.close(); }
  });
}

test('cancelling expansion keeps the fetched thread and does not fetch another batch', async () => {
  const controller = new AbortController();
  respond = (url) => {
    assert.notEqual(url.pathname, '/api/morechildren');
    controller.abort(new Error('Synthetic cancellation.'));
    return ok(threadPayload('cancel1', [comment('kept001'), more(['hidden2'])]));
  };
  const tool = extension.tools.get('reddit_thread').definition;
  const before = requests.length;
  const result = await tool.execute('cancel-expansion', tool.prepareArguments({ url_or_id: 'cancel1', expand_more: 5 }), controller.signal, undefined, {});
  assert.equal(requests.length - before, 1);
  assert.equal(result.details.comments_fetched, 1);
  assert.equal(result.details.expansion.requests, 0);
  assert.equal(result.details.expansion_stopped, 'Expansion cancelled.');
});

for (const [name, fallback] of [['reddit_search', 8], ['reddit_trends', 10]]) {
  test(`${name} keeps default limits, caps at 100 and normalizes output format`, async () => {
    const tool = extension.tools.get(name).definition;
    assert.equal(tool.prepareArguments({}).limit, fallback);
    assert.equal(tool.prepareArguments({}).format, 'full');
    assert.equal(tool.prepareArguments({ limit: 101, format: ' COMPACT ' }).limit, 100);
    assert.equal(tool.prepareArguments({ format: ' COMPACT ' }).format, 'compact');
    assert.equal(tool.prepareArguments({ limit: 0, format: 'invalid' }).limit, 1);
    assert.equal(tool.prepareArguments({ format: 'invalid' }).format, 'full');
    respond = (url) => ok(listing(Array.from({ length: Number(url.searchParams.get('limit')) }, (_, i) => post(`wide${i}`, 'Wide')), 't3_wide99'));
    const before = requests.length;
    const result = await call(name, { query: `volume-${name}`, subreddits: `Volume${fallback}`, limit: 100, format: 'full' });
    const compact = await call(name, { query: `volume-${name}`, subreddits: `Volume${fallback}`, limit: 100, format: 'compact' });
    assert.equal(requests[before].searchParams.get('limit'), '100');
    assert.equal(requests.length - before, 1, 'format changes reuse the same request cache');
    assert.equal(result.details.posts.length, 100);
    assert.equal(compact.details.posts.length, 100);
    assert.deepEqual(compact.details.posts, result.details.posts);
    assert.deepEqual(compact.details.cursors, result.details.cursors);
    assert.equal(result.details.format, 'full');
    assert.equal(compact.details.format, 'compact');
    assert.ok(compact.details.posts_shown > result.details.posts_shown);
    assert.match(text(result), /showing \d+ of 100; use format=compact or lower limit before paginating/);
    assert.match(text(compact), /Full results remain in details.posts/);
    assert.match(text(compact), /after=t3_wide99/);
  });

  for (const format of ['full', 'compact']) {
    test(`${name} ${format} truncates only between complete entries`, async () => {
      respond = () => ok(listing(Array.from({ length: 30 }, (_, i) => post(`whole${i}`, 'Whole')), 't3_whole29'));
      const result = await call(name, { query: `whole-${name}-${format}`, subreddits: `Whole${name}${format}`, limit: 30, format });
      const evidence = text(result).split('\n\n[truncated:')[0];
      const entries = evidence.split(/\n(?=\d+\. r\/)/).slice(1);
      assert.equal(entries.length, result.details.posts_shown);
      assert.ok(entries.length > 0 && entries.length < 30);
      assert.equal(result.details.posts.length, 30);
      for (const entry of entries) {
        if (format === 'full') {
          assert.equal(entry.split('\n').length, 4);
          assert.match(entry.split('\n').at(-1), /^   post excerpt: /);
        } else {
          assert.equal(entry.split('\n').length, 1);
          assert.match(entry, /score \d+, comments 4, age .+ \| source whole\d+ \| https:\/\/www\.reddit\.com\//);
        }
      }
      assert.doesNotMatch(text(result), /truncated to 2000/);
      assert.match(text(result), /after=t3_whole29/);
    });
  }

  test(`${name} reports zero displayed entries for an oversized full post without hiding structured data`, async () => {
    const child = post('oversize', 'Oversize');
    child.data.title = 'very large title '.repeat(1000);
    respond = () => ok(listing([child], 't3_oversize'));
    const args = { query: `oversize-${name}`, subreddits: `Oversize${name}`, limit: 1 };
    const full = await call(name, args);
    assert.equal(full.details.posts_shown, 0);
    assert.equal(full.details.posts.length, 1);
    assert.match(text(full), /showing 0 of 1/);
    assert.doesNotMatch(text(full), /^1\. r\//m);
    const compact = await call(name, { ...args, format: 'compact' });
    assert.equal(compact.details.posts_shown, 1);
    assert.deepEqual(compact.details.posts, full.details.posts);
  });

  test(`${name} paginates 100-result compact pages without overlapping ids`, async () => {
    respond = (url) => {
      const start = url.searchParams.has('after') ? 100 : 0;
      return ok(listing(Array.from({ length: 100 }, (_, i) => post(`bulk${start + i}`, 'Bulk')), start === 0 ? 't3_bulk99' : undefined));
    };
    const args = { query: `bulk-pages-${name}`, subreddits: `Bulk${name}`, limit: 100, format: 'compact' };
    const before = requests.length;
    const first = await call(name, args);
    const second = await call(name, { ...args, after: first.details.cursors.after });
    assert.equal(first.details.posts.length, 100);
    assert.equal(second.details.posts.length, 100);
    assert.equal(first.details.cursors.after, 't3_bulk99');
    assert.equal(second.details.cursors.after, undefined);
    const seen = new Set(first.details.posts.map((post) => post.id));
    assert.ok(second.details.posts.every((post) => !seen.has(post.id)));
    assert.equal(requests.length - before, 2);
    assert.equal(requests[before + 1].searchParams.get('after'), 't3_bulk99');
  });

  test(`${name} handles empty compact results and preserves default full output`, async () => {
    respond = () => ok(listing([]));
    const empty = await call(name, { query: `empty-format-${name}`, subreddits: `EmptyFormat${name}`, format: 'compact' });
    assert.equal(empty.details.posts_shown, 0);
    assert.deepEqual(empty.details.posts, []);
    assert.match(text(empty), /No Reddit posts found/);
    respond = () => ok(listing([post('legacyformat')]));
    const before = requests.length;
    const full = await call(name, { query: `legacy-format-${name}`, subreddits: `LegacyFormat${name}` });
    assert.equal(requests[before].searchParams.get('limit'), String(fallback));
    assert.equal(full.details.format, 'full');
    assert.match(text(full), /by u\/testuser/);
    assert.match(text(full), /post excerpt: body evidence/);
  });
}

for (const order of ['reddit', 'ranked']) {
  test(`trends ${order} deduplicates ids before applying the result cap and keeps safe cursors`, async () => {
    respond = (url) => {
      const first = url.pathname.includes('/DupA/');
      return ok(listing(first ? [post('sharedid', 'Actual', 1), post('uniquea', 'Actual', 10), post('uniquea', 'Actual', 10)]
        : [post('sharedid', 'Actual', 1), post('uniqueb', 'Actual', 9)], first ? 't3_uniquea' : 't3_uniqueb'));
    };
    const result = await call('reddit_trends', { subreddits: 'DupA,DupB', listing: 'hot', order, limit: 3, format: 'compact' });
    assert.equal(result.details.posts.length, 3);
    assert.deepEqual(result.details.posts.map((p) => p.id), order === 'reddit' ? ['sharedid', 'uniquea', 'uniqueb'] : ['uniquea', 'uniqueb', 'sharedid']);
    assert.equal(result.details.cursors.per_subreddit.DupA.after, 't3_uniquea');
    assert.equal(result.details.cursors.per_subreddit.DupB.after, 't3_uniqueb');
  });
}

test('compact multi-subreddit searches retain unreturned-prefix cursors and formatting does not change them', async () => {
  respond = (url) => ok(listing(url.pathname.includes('/FormatA/')
    ? [post('fmta1', 'FormatA', 100000), post('fmta2', 'FormatA', 99999)]
    : [post('fmtb1', 'FormatB', 0), post('fmtb2', 'FormatB', 99998)], 't3_pageend'));
  const args = { query: 'format-safe-multi', subreddits: 'FormatA,FormatB', limit: 1, after: 't3_ignored' };
  const full = await call('reddit_search', args);
  const compact = await call('reddit_search', { ...args, format: 'compact' });
  assert.deepEqual(compact.details.cursors, full.details.cursors);
  assert.equal(compact.details.cursors.per_subreddit.FormatA.after, 't3_fmta1');
  assert.equal(compact.details.cursors.per_subreddit.FormatB.restart, true);
  assert.match(text(compact), /after was ignored/);
});

test('post context preserves Reddit permalinks and only valid non-reddit.com destinations', async () => {
  const cases = [
    ['external', { url: 'https://example.com/article?q=1', stickied: true, is_video: true }, 'https://example.com/article?q=1'],
    ['selfpost', { is_self: true, url: 'https://example.com/not-a-destination' }],
    ['redditroot', { url: 'https://reddit.com/comments/abc' }],
    ['redditsub', { url: 'https://old.reddit.com/comments/abc' }],
    ['redditdot', { url: 'https://REDDIT.COM./comments/abc' }],
    ['lookalike', { url: 'https://reddit.com.example.org/article' }, 'https://reddit.com.example.org/article'],
    ['cdnlink', { url: 'https://i.redd.it/example.png' }, 'https://i.redd.it/example.png'],
    ['invalid', { url: 'not an absolute URL' }],
    ['relative', { url: '/relative/path' }],
    ['scripturl', { url: 'javascript:alert(1)' }],
    ['userinfo', { url: 'https://user:example@example.com/article' }],
    ['missing', {}],
    ['malformedflags', { is_self: 'false', stickied: 'true', is_video: 1 }],
  ];
  respond = () => ok(listing(cases.map(([id, fields]) => {
    const child = post(id, 'Context');
    Object.assign(child.data, fields);
    return child;
  })));
  const result = await call('reddit_search', { query: 'post-context', limit: 25, format: 'compact' });
  for (const [id, fields, destination] of cases) {
    const parsed = result.details.posts.find((p) => p.id === id);
    assert.equal(parsed.externalUrl, destination, id);
    assert.equal(parsed.url, `https://www.reddit.com/r/Context/comments/${id}/source/`, id);
    assert.equal(parsed.permalink, `/r/Context/comments/${id}/source/`, id);
    assert.equal(parsed.isSelf, fields.is_self === true, id);
    assert.equal(parsed.stickied, fields.stickied === true, id);
    assert.equal(parsed.isVideo, fields.is_video === true, id);
  }
  assert.match(text(result), /\[sticky\]/);
  assert.match(text(result), /destination https:\/\/example.com\/article\?q=1/);
});

test('external destinations and sticky markers render in full, compact, thread and user output', async () => {
  const child = post('linkrender', 'LinkRender');
  Object.assign(child.data, { url: 'https://example.org/guide', is_self: false, stickied: true, is_video: true, title: 'Guide\nwith\tspacing' });
  respond = (url) => ok(url.pathname.startsWith('/comments/') ? [listing([child]), listing([])] : listing([child]));
  const full = await call('reddit_search', { query: 'link-rendering' });
  const compact = await call('reddit_search', { query: 'link-rendering', format: 'compact' });
  const thread = await call('reddit_thread', { url_or_id: 'linkrender' });
  const user = await call('reddit_user', { username: 'linkauthor', sections: 'posts' });
  for (const result of [full, compact, thread, user]) {
    assert.match(text(result), /\[sticky\]/);
    assert.match(text(result), /destination[: ]+https:\/\/example.org\/guide/);
    assert.match(text(result), /https:\/\/www.reddit.com\/r\/LinkRender\/comments\/linkrender\/source\//);
  }
  assert.match(text(compact), /Guide with spacing/);
  assert.equal(text(compact).split('\n').filter((line) => /^\d+\. r\//.test(line)).length, 1);
  const { initTheme } = await import(pathToFileURL(join(piDist, 'modes/interactive/theme/theme.js')));
  const { ToolExecutionComponent } = await import(pathToFileURL(join(piDist, 'modes/interactive/components/tool-execution.js')));
  initTheme('dark', false);
  for (const result of [full, compact]) {
    const component = new ToolExecutionComponent('reddit_search', 'link-render', { query: 'link-rendering', format: result.details.format }, {},
      extension.tools.get('reddit_search').definition, { requestRender() {} }, process.cwd());
    component.updateResult(result);
    assert.ok(component.render(100).length > 0);
    component.setExpanded(true);
    assert.ok(component.render(100).length > 0);
  }
});

test('oversized compact destinations never produce partial entries or exceed the output budget', async () => {
  const child = post('hugeurl', 'HugeUrl');
  child.data.url = `https://example.com/${'x'.repeat(5000)}`;
  respond = () => ok(listing([child]));
  const result = await call('reddit_search', { query: 'oversized-destination', format: 'compact' });
  assert.equal(result.details.posts_shown, 0);
  assert.equal(result.details.posts[0].externalUrl.length > 5000, true);
  assert.match(text(result), /showing 0 of 1/);
  assert.doesNotMatch(text(result), /^1\. r\//m);
});

test('403 resource denials do not block unrelated uncached requests; block/rate-limit behavior is preserved', async (t) => {
  // All requests below are synthetic. A controlled clock expires each case's cooldown
  // without waiting five real minutes or letting one case contaminate the next.
  let now = Date.now() + 600000;
  t.after(() => { clockFloor = now; });
  t.mock.method(Date, 'now', () => now);
  let caseId = 0;
  const runCase = async (name, status, body, headers = {}, denial = false, refresh = false) => {
    now += 600000;
    const key = `status-case-${caseId++}`;
    const previousCookie = process.env.PI_REDDIT_COOKIE;
    const before = requests.length;
    respond = (url) => {
      now += 251;
      if (url.searchParams.get('q') === key) {
        if (refresh) process.env.PI_REDDIT_COOKIE = 'synthetic-refreshed-cookie';
        return new Response(body, { status, headers });
      }
      return ok(listing([post('after01')]));
    };
    try {
      const rejected = await invoke(extension, 'reddit_search', { query: key });
      assert.equal(rejected.isError, true, name);
      assert.match(text(rejected), denial ? /Reddit denied access:/ : refresh ? /cookie refreshed/ : /cooldown started/, name);
      if (denial) assert.doesNotMatch(text(rejected), /cookie may be expired|cooldown started/, name);
      const next = await invoke(extension, 'reddit_search', { query: `${key}-uncached` });
      assert.equal(next.isError, !denial && !refresh, name);
      assert.equal(requests.length - before, denial || refresh ? 2 : 1, `${name}: actual fetch count, not a cached success`);
      if (!denial && !refresh) {
        assert.match(text(next), /cooling down/, name);
        const seconds = Number(headers['retry-after']) > 0 ? Number(headers['retry-after']) : 300;
        now += seconds * 1000 + 1;
        const recovered = await call('reddit_search', { query: `${key}-uncached` });
        assert.equal(recovered.details.posts.length, 1);
        assert.equal(requests.length - before, 2, `${name}: network resumes after cooldown`);
      }
    } finally {
      process.env.PI_REDDIT_COOKIE = previousCookie;
    }
  };
  for (const reason of ['gold_only', 'private', 'banned', 'quarantined', 'unknown_resource_reason']) {
    await runCase(reason, 403, JSON.stringify({ reason }), {}, true);
  }
  await runCase('JSON reason with changed cookie', 403, '{"reason":"private"}', {}, true, true);
  for (const [name, body] of Object.entries({ html: '<html>blocked</html>', empty: '', malformed: '{bad', no_reason: '{}', numeric: '{"reason":42}', blank: '{"reason":"  "}', null: 'null' })) {
    await runCase(name, 403, body);
  }
  await runCase('403 Retry-After', 403, '<html>blocked</html>', { 'retry-after': '17' });
  await runCase('invalid Retry-After', 403, '', { 'retry-after': 'invalid' });
  await runCase('429 reason still rate limited', 429, '{"reason":"private"}', { 'retry-after': '30' });
  await runCase('cookie refreshed', 403, '<html>blocked</html>', {}, false, true);

  now += 600000;
  const staleIds = Array.from({ length: 150 }, (_, i) => `stale${String(i).padStart(3, '0')}`);
  respond = (url) => {
    now += 251;
    if (url.searchParams.get('q') === 'expansion-rate-limit') return new Response('', { status: 429 });
    return ok(url.pathname === '/api/morechildren'
      ? morePayload(url.searchParams.get('children').split(',').map((id) => comment(id)))
      : threadPayload('stale01', [more(staleIds)]));
  };
  const seeded = await call('reddit_thread', { url_or_id: 'stale01', expand_more: 1 });
  assert.equal(seeded.details.expansion.comments_added, 100);
  now += 21600001; // Expire the default six-hour thread/expansion cache.
  const blocked = await invoke(extension, 'reddit_search', { query: 'expansion-rate-limit' });
  assert.equal(blocked.isError, true);
  const beforeStale = requests.length;
  const stale = await call('reddit_thread', { url_or_id: 'stale01', expand_more: 2 });
  assert.equal(requests.length, beforeStale, 'stale initial/expansion data is served during cooldown; uncached batch cannot fetch');
  assert.equal(stale.details.comments_fetched, 100);
  assert.equal(stale.details.expansion.requests, 0, 'stale helper successes are not fresh HTTP calls');
  assert.equal(stale.details.expansion.unresolved_ids.length, 50);
  assert.match(stale.details.expansion_stopped, /cooling down/);
});
