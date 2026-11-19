'use strict';
/** ユーザー 1 人分の状態の読み込みと、ブラウザへ返す形への整形 */

const { redis } = require('./redis');
const { k, publicSettings, normalizeCfg } = require('./users');
const { HttpError } = require('./http');
const { agentAlive, agentLive, emptyAgentState } = require('./core');
const { riotAvailable, emptyRiotState } = require('./riot');

/** cfg / agent / riot を 1 コマンド（MGET）でまとめて読む */
async function loadAll(uid) {
  const [cfg, agent, riot] = await redis.mgetJson(k.cfg(uid), k.agent(uid), k.riot(uid));
  if (!cfg) throw new HttpError(401, 'アカウントが見つかりません');
  return {
    cfg: normalizeCfg(cfg),
    agent: { ...emptyAgentState(), ...(agent || {}) },
    riot: { ...emptyRiotState(), ...(riot || {}) },
  };
}

function publicState({ cfg, agent, riot }, now = Date.now()) {
  const alive = agentAlive(agent, now);
  const live = agentLive(agent, now);
  const alerts = [...(agent.alerts || []), ...(riot.alerts || [])]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 50);
  return {
    now: new Date(now).toISOString(),
    agent: {
      alive,                       // エージェントのプロセスが動いている
      connected: live,             // League クライアントに繋がっている
      mock: alive && !!agent.mock,
      error: alive ? agent.error : null,
      lastPushAt: agent.lastPushAt ? new Date(agent.lastPushAt).toISOString() : null,
    },
    riot: {
      available: riotAvailable(),
      enabled: !!cfg.settings.riotEnabled,
      active: riotAvailable() && !!cfg.settings.riotEnabled && !live,
      lastRunAt: riot.lastRunAt ? new Date(riot.lastRunAt).toISOString() : null,
      lastError: riot.lastError,
      players: riot.players,
    },
    me: live ? agent.me : null,
    friends: live ? agent.friends : [],
    watched: cfg.watched,
    settings: publicSettings(cfg.settings),
    alerts,
  };
}

module.exports = { loadAll, publicState };
