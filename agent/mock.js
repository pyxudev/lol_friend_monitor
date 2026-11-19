'use strict';
/** LCU が無い環境（Linux / クライアント未起動）で UI を確認するためのモックデータ源 */

const NAMES = [
  ['ShadowFang', 'JP1'], ['MidOrFeed', 'KR'], ['こうきくん', 'JP1'],
  ['BaronSteal', 'NA1'], ['SupportDiff', 'JP1'], ['TeemoOnTop', 'EUW'],
  ['ゆうた', 'JP1'], ['LastHitMiss', 'JP1'], ['JungleGap', 'OCE'],
  ['FlashOnCD', 'JP1'], ['さくら', 'JP1'], ['AFKSplit', 'NA1'],
];
const AVAIL = ['chat', 'away', 'dnd', 'offline', 'offline'];
const GAME_STATUS = ['outOfGame', 'inQueue', 'championSelect', 'inGame'];
/** LoL 以外の在席（通知されないこと）も確認できるように混ぜておく */
const PRODUCTS = ['league_of_legends', 'league_of_legends', 'league_of_legends', 'valorant', 'riot'];

class MockSource {
  constructor() {
    this.friends = NAMES.map(([gameName, tagLine], i) => ({
      puuid: `mock-puuid-${i}`,
      gameName,
      tagLine,
      name: gameName,
      icon: 1000 + i,
      availability: i < 4 ? 'chat' : 'offline',
      productId: i === 2 ? 'valorant' : (i === 3 ? 'riot' : 'league_of_legends'),
      statusMessage: i % 3 === 0 ? 'ランク回してます' : '',
      groupName: i % 2 === 0 ? 'フレンド' : '野良',
      lol: { gameStatus: 'outOfGame', level: 30 + i * 3 },
    }));
    this.tick = 0;
  }

  async getFriends() {
    this.tick += 1;
    // 数ティックごとにランダムに 1〜2 人の状態を変える
    if (this.tick % 2 === 0) {
      const n = 1 + Math.floor(Math.random() * 2);
      for (let k = 0; k < n; k++) {
        const f = this.friends[Math.floor(Math.random() * this.friends.length)];
        f.availability = AVAIL[Math.floor(Math.random() * AVAIL.length)];
        if (f.availability === 'offline') {
          f.lol.gameStatus = 'outOfGame';
        } else {
          // オフライン → オンラインの復帰時に製品も引き直す
          f.productId = PRODUCTS[Math.floor(Math.random() * PRODUCTS.length)];
          f.lol.gameStatus = f.productId === 'league_of_legends'
            ? GAME_STATUS[Math.floor(Math.random() * GAME_STATUS.length)]
            : 'outOfGame';
        }
      }
    }
    return JSON.parse(JSON.stringify(this.friends));
  }

  async getCurrentSummoner() {
    return {
      gameName: 'DemoSummoner', tagLine: 'JP1', name: 'DemoSummoner',
      icon: 4567, availability: 'chat', productId: 'league_of_legends',
      lol: { gameStatus: 'outOfGame', level: 150 },
    };
  }

  get connectionInfo() { return { port: 0, source: 'モックモード' }; }
  async ensureCreds() { return { mock: true }; }
}

module.exports = { MockSource };
