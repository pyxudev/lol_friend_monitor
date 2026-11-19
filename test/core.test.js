'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyPush, STALE_MS } = require('../lib/core');
const { DEFAULT_SETTINGS } = require('../lib/users');

const cfg = (over = {}) => ({ watched: [{ key: 'p1', name: 'A', tag: 'JP1' }], settings: { ...DEFAULT_SETTINGS, ...over } });
const fr = (availability, gameStatus = 'outOfGame', productId = 'league_of_legends') =>
  ({ puuid: 'p1', gameName: 'A', tagLine: 'JP1', availability, productId, lol: { gameStatus } });
const push = (friends) => ({ connected: true, friends });

function run(c, steps) {
  let agent = null;
  const out = [];
  for (const [t, payload] of steps) {
    const r = applyPush(c, agent, null, payload, t);
    agent = r.agent;
    out.push(r.alerts.length);
  }
  return out;
}

test('初回は基準取得のみで通知しない', () => {
  assert.deepStrictEqual(run(cfg(), [[1000, push([fr('chat')])]]), [0]);
});

test('offline → LoL オンラインで通知', () => {
  assert.deepStrictEqual(run(cfg(), [[1000, push([fr('offline')])], [6000, push([fr('chat')])]]), [0, 1]);
});

test('offline → そのままゲーム中でも通知', () => {
  assert.deepStrictEqual(run(cfg(), [[1000, push([fr('offline')])], [6000, push([fr('dnd', 'inGame')])]]), [0, 1]);
});

test('離席中で見送り → ゲーム中で通知（notifyAwayAsOnline=false）', () => {
  const c = cfg({ notifyAwayAsOnline: false });
  assert.deepStrictEqual(run(c, [
    [1000, push([fr('offline')])], [6000, push([fr('away')])], [11000, push([fr('dnd', 'championSelect')])],
  ]), [0, 0, 1]);
});

test('VALORANT でのオンラインは通知しない', () => {
  assert.deepStrictEqual(run(cfg(), [[1000, push([fr('offline')])], [6000, push([fr('chat', '', 'valorant')])]]), [0, 0]);
});

test('短い切断中のオンライン化は復帰時に通知', () => {
  assert.deepStrictEqual(run(cfg(), [
    [1000, push([fr('offline')])], [6000, { connected: false, error: 'x' }], [30000, push([fr('chat')])],
  ]), [0, 0, 1]);
});

test('長い途切れの後は基準を取り直して通知しない', () => {
  assert.deepStrictEqual(run(cfg(), [
    [1000, push([fr('offline')])], [1000 + STALE_MS + 1, push([fr('chat')])],
  ]), [0, 0]);
});

test('再通知の抑制', () => {
  assert.deepStrictEqual(run(cfg(), [
    [1000, push([fr('offline')])], [6000, push([fr('chat')])], [11000, push([fr('offline')])], [16000, push([fr('chat')])],
  ]), [0, 1, 0, 0]);
});
