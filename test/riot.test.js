'use strict';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const test = require('node:test');
const assert = require('node:assert');
const { runRiotCheck, validateApiKey } = require('../lib/riot');
const { DEFAULT_SETTINGS } = require('../lib/users');

const KEY_A = 'RGAPI-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const KEY_B = 'RGAPI-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let inGame = false;
const calls = [];
global.fetch = async (url, opts) => {
  const key = opts.headers['X-Riot-Token'];
  calls.push({ url: String(url), key });
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });
  if (key !== KEY_A && key !== KEY_B) return json(403, {});
  if (url.includes('/lol/status/v4/')) return json(200, {});
  if (url.includes('/riot/account/v1/')) return json(200, { puuid: `enc-${key}` });
  if (url.includes('/spectator/v5/')) return inGame ? json(200, { gameQueueConfigId: 420, gameStartTime: Date.now() }) : json(404, {});
  throw new Error(`unexpected ${url}`);
};

const cfgWith = (riotApiKey) => ({
  watched: [{ key: 'a#jp1', name: 'A', tag: 'JP1' }],
  settings: { ...DEFAULT_SETTINGS, riotApiKey },
});

test('Riot API: キー未登録なら何もしない', async () => {
  assert.strictEqual(await runRiotCheck('u0', cfgWith(''), null, null, { now: 1 }), null);
  assert.strictEqual(calls.length, 0);
});

test('Riot API: 初回は基準のみ → 試合開始で通知 → エージェント稼働中は何もしない', async () => {
  const cfg = cfgWith(KEY_A);
  let t = 1_000_000;
  let riot = await runRiotCheck('u1', cfg, null, null, { now: t });
  assert.strictEqual(riot.alerts.length, 0);
  assert.strictEqual(riot.players['a#jp1'].inGame, false);
  assert.ok(calls[0].url.startsWith('https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/A/JP1'));
  assert.ok(calls[1].url.startsWith('https://jp1.api.riotgames.com/lol/spectator/v5/'));
  assert.ok(calls.every((c) => c.key === KEY_A), 'ユーザーが登録したキーで呼ぶ');

  // 間隔が短いとスキップ
  assert.strictEqual(await runRiotCheck('u1', cfg, null, riot, { now: t + 10_000 }), null);

  inGame = true;
  t += 61_000;
  riot = await runRiotCheck('u1', cfg, null, riot, { now: t });
  assert.strictEqual(riot.alerts.length, 1);
  assert.strictEqual(riot.alerts[0].statusMessage, 'ランク（ソロ/デュオ）');
  assert.strictEqual(riot.alerts[0].source, 'riot');

  // PUUID はキャッシュされる
  assert.strictEqual(calls.filter((c) => c.url.includes('/account/')).length, 1);

  // エージェントが LCU に繋がっている間は Riot API を使わず、基準を捨てる
  const agent = { connected: true, lastPushAt: t + 61_000 };
  const r2 = await runRiotCheck('u1', cfg, agent, riot, { now: t + 62_000 });
  assert.deepStrictEqual(r2.players, {});
  inGame = false;
});

test('Riot API: PUUID のキャッシュは API キーごとに分かれる', async () => {
  calls.length = 0;
  await runRiotCheck('u2', cfgWith(KEY_B), null, null, { now: 5_000_000 });
  const acc = calls.filter((c) => c.url.includes('/account/'));
  assert.strictEqual(acc.length, 1, '別のキーでは KEY_A のキャッシュを使わず取り直す');
  assert.strictEqual(acc[0].key, KEY_B);
});

test('Riot API: キーの検証', async () => {
  assert.deepStrictEqual(await validateApiKey(KEY_A, 'jp1'), { ok: true });
  const bad = await validateApiKey('RGAPI-00000000-0000-0000-0000-000000000000', 'jp1');
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /無効/);
});
