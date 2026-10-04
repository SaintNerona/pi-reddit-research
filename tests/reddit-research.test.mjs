import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
after(() => { globalThis.fetch = originalFetch; rmSync(cache, { recursive: true, force: true }); });
const extension = await loadTools();
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
  respond = (url) => url.pathname.endsWith('about.json')
    ? ok({ data: { name: 'testuser', id: 'abc', created_utc: 1700000000, link_karma: 5, subreddit: {} } })
    : url.pathname.endsWith('comments.json') ? ok(listing([comment('comm01', 'yes'), comment('comm02')], 't1_comm02'))
      : ok(listing([post('abc123')], 't3_abc123'));
  const before = requests.length;
  const only = await call('reddit_user', { username: 'u/testuser', sections: 'comments', limit: 2 });
  assert.equal(only.details.posts.length, 0);
  assert.equal(only.details.about, undefined);
  assert.equal(only.details.comments.length, 2);
  assert.deepEqual(requests.slice(before).map((url) => url.pathname), ['/user/testuser/comments.json']);
  assert.match(text(only), /after_comments=t1_comm02/);
  const defaults = await call('reddit_user', { username: 'testuser' });
  assert.equal(defaults.details.about.username, 'testuser');
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
    if (url.pathname.endsWith('about.json')) return new Response('No such user', { status: 404 });
    if (url.pathname.endsWith('comments.json')) return ok(listing([comment('part001')], 't1_part001'));
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
  assert.equal(calls.find((url) => url.pathname.endsWith('submitted.json')).searchParams.get('after'), null);
  assert.equal(calls.find((url) => url.pathname.endsWith('comments.json')).searchParams.get('after'), 't1_valid');
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
