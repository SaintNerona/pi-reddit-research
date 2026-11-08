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
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  requests.push(url);
  if (options.signal?.aborted) throw options.signal.reason;
  return respond(url, options);
};
after(() => { globalThis.fetch = originalFetch; db.close(); rmSync(cache, { recursive: true, force: true }); });
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
