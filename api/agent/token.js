'use strict';
/** POST /api/agent/token  エージェントトークンを再発行する（古いトークンは無効になる） */

const { handler, send } = require('../../lib/http');
const { authenticate, rotateAgentToken } = require('../../lib/users');

module.exports = handler({
  async POST(req, res) {
    const { uid } = await authenticate(req, 'user');
    const agentToken = await rotateAgentToken(uid);
    send(res, 200, { agentToken });
  },
});
