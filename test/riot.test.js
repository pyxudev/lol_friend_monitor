'use strict';
process.env.RIOT_API_KEY = 'test-key';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const test = require('node:test');
const assert = require('node:assert');
const { runRiotCheck } = require('../lib/riot');
const { DEFAULT_SETTINGS } = require('../lib/users');

let inGame = false;
const calls = [];
global.fetch = async (url) => {
  calls.push(String(url));
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });
  if (url.includes('/riot/account/v1/')) return json(200, { puuid: 'enc-puuid' });
  if (url.includes('/spectator/v5/')) return inGame ? json(200, { gameQueueConfigId: 420, gameStartTime: Date.now() }) : json(404, {});
  throw new Error(`unexpected ${url}`);
};

const cfg = { watched: [{ key: 'a#jp1', name: 'A', tag: 'JP1' }], settings: { ...DEFAULT_SETTINGS } };

test('Riot API: 初回は基準のみ → 試合開始で通知 → エージェント稼働中は何もしない', async () => {
  let t = 1_000_000;
  let riot = await runRiotCheck('u1', cfg, null, null, { now: t });
  assert.strictEqual(riot.alerts.length, 0);
  assert.strictEqual(riot.players['a#jp1'].inGame, false);
  assert.ok(calls[0].startsWith('https://asia.api.riotgames.com/riot/account/v1/accounts/by-riot-id/A/JP1'));
  assert.ok(calls[1].startsWith('https://jp1.api.riotgames.com/lol/spectator/v5/'));

  // 間隔が短いとスキップ
  assert.strictEqual(await runRiotCheck('u1', cfg, null, riot, { now: t + 10_000 }), null);

  inGame = true;
  t += 61_000;
  riot = await runRiotCheck('u1', cfg, null, riot, { now: t });
  assert.strictEqual(riot.alerts.length, 1);
  assert.strictEqual(riot.alerts[0].statusMessage, 'ランク（ソロ/デュオ）');
  assert.strictEqual(riot.alerts[0].source, 'riot');

  // PUUID はキャッシュされる
  assert.strictEqual(calls.filter((c) => c.includes('/account/')).length, 1);

  // エージェントが LCU に繋がっている間は Riot API を使わず、基準を捨てる
  const agent = { connected: true, lastPushAt: t + 61_000 };
  const r2 = await runRiotCheck('u1', cfg, agent, riot, { now: t + 62_000 });
  assert.deepStrictEqual(r2.players, {});
});
