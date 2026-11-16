'use strict';
/**
 * LCU (League Client Update) API クライアント。
 *
 * Riot の公開 Web API にはフレンドリストを取得する手段が無いため、
 * ローカルで動作している League クライアントが提供している
 * https://127.0.0.1:<port>/ のローカル REST API を利用する。
 *
 * 認証情報はクライアントが起動時に書き出す lockfile から取得する。
 *   lockfile 形式: LeagueClient:<pid>:<port>:<password>:https
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

/** 自己署名証明書なので検証を無効化した agent を使う（接続先は 127.0.0.1 固定） */
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/** lockfile の候補パスを列挙する */
function lockfileCandidates() {
  const out = [];
  if (process.env.LCU_LOCKFILE) out.push(process.env.LCU_LOCKFILE);

  if (process.platform === 'win32') {
    const drives = ['C:', 'D:', 'E:'];
    for (const d of drives) {
      out.push(`${d}\\Riot Games\\League of Legends\\lockfile`);
      out.push(`${d}\\Program Files\\Riot Games\\League of Legends\\lockfile`);
      out.push(`${d}\\Games\\Riot Games\\League of Legends\\lockfile`);
    }
    if (process.env.LOCALAPPDATA) {
      out.push(path.join(process.env.LOCALAPPDATA, 'Riot Games', 'League of Legends', 'lockfile'));
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/League of Legends.app/Contents/LoL/lockfile');
    out.push(path.join(os.homedir(), 'Applications/League of Legends.app/Contents/LoL/lockfile'));
  } else {
    // Linux (Lutris / Wine など) — prefix 配下を一応見る
    out.push(path.join(os.homedir(), 'Games/league-of-legends/drive_c/Riot Games/League of Legends/lockfile'));
    out.push(path.join(os.homedir(), '.wine/drive_c/Riot Games/League of Legends/lockfile'));
  }
  return out;
}

/** lockfile を読んで認証情報を返す */
function readLockfile() {
  for (const p of lockfileCandidates()) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      const parts = raw.split(':');
      if (parts.length >= 5) {
        return {
          source: p,
          pid: Number(parts[1]),
          port: Number(parts[2]),
          password: parts[3],
          protocol: parts[4],
        };
      }
    } catch (_) { /* 次の候補へ */ }
  }
  return null;
}

/**
 * lockfile が見つからない場合のフォールバック。
 * 起動中の LeagueClientUx プロセスのコマンドライン引数から
 * --app-port と --remoting-auth-token を取り出す。
 */
function readFromProcess() {
  return new Promise((resolve) => {
    const done = (v) => resolve(v);

    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process -Filter "name=\'LeagueClientUx.exe\'" | Select-Object -ExpandProperty CommandLine';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) return done(null);
        done(parseCommandLine(stdout));
      });
    } else {
      execFile('/bin/sh', ['-c', "ps -A -o args= 2>/dev/null | grep -i 'LeagueClientUx' | grep -v grep"], { timeout: 8000 }, (err, stdout) => {
        if (err || !stdout) return done(null);
        done(parseCommandLine(stdout));
      });
    }
  });
}

function parseCommandLine(text) {
  const port = /--app-port=["']?(\d+)/.exec(text);
  const token = /--remoting-auth-token=["']?([\w-]+)/.exec(text);
  if (!port || !token) return null;
  return {
    source: 'process command line',
    pid: null,
    port: Number(port[1]),
    password: token[1],
    protocol: 'https',
  };
}

class LcuClient {
  constructor() {
    this.creds = null;
  }

  /** 認証情報を取得（キャッシュあり）。force=true で再探索 */
  async ensureCreds(force = false) {
    if (this.creds && !force) return this.creds;
    let c = readLockfile();
    if (!c) c = await readFromProcess();
    this.creds = c;
    return c;
  }

  get connectionInfo() {
    if (!this.creds) return null;
    return { port: this.creds.port, source: this.creds.source };
  }

  /** LCU API への GET。失敗したら 1 度だけ認証情報を取り直して再試行する */
  async get(pathname) {
    try {
      return await this._request('GET', pathname);
    } catch (err) {
      if (err.code === 'NO_CREDENTIALS') throw err;
      await this.ensureCreds(true);
      return await this._request('GET', pathname);
    }
  }

  _request(method, pathname, body) {
    return new Promise(async (resolve, reject) => {
      let creds;
      try {
        creds = await this.ensureCreds();
      } catch (e) {
        return reject(e);
      }
      if (!creds) {
        const e = new Error('League クライアントが見つかりません（lockfile 未検出）');
        e.code = 'NO_CREDENTIALS';
        return reject(e);
      }

      const auth = Buffer.from(`riot:${creds.password}`).toString('base64');
      const req = https.request({
        host: '127.0.0.1',
        port: creds.port,
        path: pathname,
        method,
        agent,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 8000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const e = new Error(`LCU ${res.statusCode}: ${text.slice(0, 200)}`);
            e.statusCode = res.statusCode;
            return reject(e);
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (e) {
            reject(new Error(`LCU レスポンスの JSON 解析に失敗: ${e.message}`));
          }
        });
      });

      req.on('timeout', () => req.destroy(new Error('LCU へのリクエストがタイムアウトしました')));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** フレンド一覧 */
  async getFriends() {
    return (await this.get('/lol-chat/v1/friends')) || [];
  }

  /** ログイン中のサモナー */
  async getCurrentSummoner() {
    try {
      return await this.get('/lol-chat/v1/me');
    } catch (_) {
      return null;
    }
  }
}

module.exports = { LcuClient };
