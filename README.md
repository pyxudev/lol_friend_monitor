# LoL Friend Watcher

League of Legends のフレンドリストを表示し、**登録したプレイヤー（複数可）が LoL でオンラインになったらデスクトップ通知／音／Discord 通知を飛ばす** Web アプリです。
Vercel にデプロイして、複数人がそれぞれのアカウントで使えます。

![node](https://img.shields.io/badge/node-%3E%3D18-green) ![deps](https://img.shields.io/badge/dependencies-0-blue)

---

## 仕組み

Riot の公開 Web API には **フレンドリストやオンライン状態を取得する手段がありません**。
これらは各自の PC で動いている League クライアントのローカル API（LCU API）からしか取れず、クラウド上のサーバーからは届きません。
そこで次の 2 つのデータ源を組み合わせています。

```
 各ユーザーの PC                         Vercel                              ブラウザ（どこからでも）
┌──────────────────────┐   HTTPS   ┌─────────────────────────────┐   5 秒ごと  ┌──────────────┐
│ League クライアント     │ ───────▶ │ /api/agent/push             │ ◀──────── │ /api/state   │
│   ▲ LCU API (lockfile) │  エージェント │   状態変化を検出 → 通知         │            │ 一覧・通知・音 │
│ エージェント (Node)     │  トークン   │ Upstash Redis（ユーザー別）     │            └──────────────┘
└──────────────────────┘           │ /api/cron ─▶ Riot 公開 API      │ ──▶ Discord Webhook
                                   └─────────────────────────────┘
```

| データ源 | 使える条件 | 分かること |
|---|---|---|
| **エージェント**（LCU API） | League クライアントを起動している PC でエージェントを動かしている | フレンド一覧、オンライン／離席／ロビー／キュー／チャンピオン選択／試合中。数秒で通知 |
| **Riot 公開 API**（Spectator-V5） | 設定画面で自分の Riot API キーを登録している、かつエージェントが止まっている | 監視リストの Riot ID が**試合中かどうかだけ**。約 1 分間隔。ロビーやキュー中は分からない |

エージェントが LCU に繋がっている間は Riot API は使いません（重複通知の防止と API 制限の節約のため）。

---

## 使う人向け

### 1. アカウントを作る

デプロイされた URL を開き「新しく始める」を押します。メールアドレスやパスワードは不要で、ブラウザにユーザートークンが保存されます。
別の端末で使うときは「設定 → アカウント」のユーザートークンをコピーして、ログイン画面に貼り付けてください。

### 2. エージェントを起動する（フレンド一覧とオンライン通知に必要）

League クライアントを起動する PC（Node.js 18 以上）で、「設定 → エージェント」に表示されるコマンドを実行します。

```bash
npx -y github:pyxudev/lol_frend_monitor --server https://<デプロイ先>.vercel.app --token lfwa_xxxxx
```

npx が使えない場合:

```bash
git clone https://github.com/pyxudev/lol_frend_monitor.git
cd lol_frend_monitor
npm run agent -- --server https://<デプロイ先>.vercel.app --token lfwa_xxxxx
```

* `--server` / `--token` は `~/.lol-friend-watcher/agent.json` に保存されるので、2 回目からは `npm run agent` だけで起動できます。
* League クライアントより先に起動しておいても構いません。クライアントが起動すると自動で接続します。
* エージェントトークンは状態の送信にしか使えません。漏れた場合は「設定 → トークンを再発行」で無効化できます。
* lockfile が見つからない場合は `LCU_LOCKFILE="D:\Games\Riot Games\League of Legends\lockfile"` のように環境変数で場所を指定できます。

### 3. 監視するプレイヤーを登録する

フレンド一覧の **☆** を押すか、右カラム下の入力欄に `名前#タグ` を入力します（最大 30 人）。
Riot API で検知するには `#タグ` まで必要です。

### 4. Riot API キーを登録する（任意・エージェント停止中の試合検知）

エージェントが止まっている間も、監視している相手が試合を始めたら通知を受け取れます。

1. [Riot Developer Portal](https://developer.riotgames.com/) で API キーを発行します。開発用キー（Development API Key）は **24 時間で失効** するので、Personal API Key の申請をおすすめします。
2. 「設定 → Riot API」で、自分のサーバー（JP など）を選んで API キーを貼り付け、保存します。保存時に Riot に問い合わせて、キーが有効か確認します。

* キーはアカウントごとに保存され、画面には末尾 4 文字しか表示されません。「削除」ボタンで登録を消せます。
* レート制限はキーごとにかかります。Personal キーの上限（100 回 / 2 分）では、Riot API で同時に確認できるのは 1 分あたり 50 人ほどです。
* 確認は、誰かがこのアカウントでページを開いている間に約 1 分ごとに行います。ブラウザを閉じていても確認するには、運営者が `/api/cron` を定期実行している必要があります（[運営者向け](#4-riot-api-の定期チェック任意)）。

### 5. 通知を受け取る

| 種類 | 条件 | ブラウザを閉じていても届く |
|---|---|---|
| デスクトップ通知 | 右上の「通知を許可」で許可済み | ✗（タブを開いておく必要あり） |
| 画面内トースト＋通知音 | 常時 | ✗ |
| Discord Webhook | 設定画面で URL を登録 | **✓** |

ブラウザを閉じていても受け取りたい場合は Discord Webhook を設定してください（Discord の「サーバー設定 → 連携サービス → ウェブフック」で発行）。

---

## 通知される条件

監視リストに入れたプレイヤーが **「LoL クライアントで在席していない状態」から「在席した状態」へ変化したとき** に 1 回通知します。

| 相手の状態 | エージェント | Riot API |
|---|---|---|
| LoL のロビー／キュー中／チャンピオン選択 | **✓** | ✗ |
| LoL で試合中 | **✓** | **✓**（試合開始時） |
| LoL で離席中・取り込み中（試合外） | 設定「離席中・取り込み中も通知」が ON のときのみ | ✗ |
| Riot クライアントのみ／VALORANT など他タイトル／モバイル | ✗（設定で解除可） | ✗ |

取りこぼし対策（エージェント）:

* **オフライン → そのままゲーム中**（ポーリングの間に進んだ場合）も通知します。
* **離席中で一旦見送った → その後ゲーム中** になった時点で通知します。
* エージェントやクライアントが**短時間（3 分以内）途切れた間のオンライン化**は復帰時に通知します。長く途切れた場合や初回は、通知が溢れないよう基準の取得だけ行います。

同じ相手への再通知は「再通知を抑制する時間」（既定 10 分）の間は行いません。エージェントと Riot API で二重に通知することもありません。

---

## 運営者向け: Vercel へのデプロイ

### 1. Upstash Redis を用意する

Vercel のプロジェクト画面 → **Storage → Marketplace → Upstash (Redis)** を追加して接続します。
環境変数 `KV_REST_API_URL` / `KV_REST_API_TOKEN` が自動で設定されます（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` でも可）。

### 2. 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | ✓ | Upstash Redis（上記で自動設定） |
| `CRON_SECRET` | `/api/cron` を使う場合のみ | `/api/cron` を呼ぶための秘密の文字列（`openssl rand -hex 32` など）。Cron を使わないなら不要 |

Riot API キーは Vercel ではなく、各ユーザーが設定画面で登録します（[使う人向け](#4-riot-api-キーを登録する任意エージェント停止中の試合検知)）。

### 3. デプロイ

```bash
npx vercel deploy --prod
```

ビルドは不要です（`public/` が静的配信、`api/` がサーバーレス関数になります）。

### 4. Riot API の定期チェック（任意）

Cron を使わなくても、ブラウザを開いている間は `/api/state` のついでに約 1 分ごとにチェックします。**ブラウザを閉じていても試合開始を検知する**には、`/api/cron` を 1 分ごとに呼ぶ必要があります。対象は Riot API キーを登録しているユーザーだけです。

* **Vercel Pro プラン**: `vercel.json` に次を追加します（`CRON_SECRET` は Vercel が自動で付けて呼び出します）。
  ```json
  "crons": [{ "path": "/api/cron", "schedule": "* * * * *" }]
  ```
  Hobby プランの Cron は 1 日 1 回までなので、この用途には使えません。
* **Hobby プラン**: [cron-job.org](https://cron-job.org) などの外部サービスから 1 分ごとに次のリクエストを送ります。
  ```
  GET https://<デプロイ先>.vercel.app/api/cron
  Authorization: Bearer <CRON_SECRET>
  ```

### Upstash の使用量の目安

* エージェント: 状態が変わったとき＋60 秒ごとに送信。1 回あたり Redis 2 コマンド
* ブラウザ: 5 秒ごとに 1 コマンド（Riot API チェック時は数コマンド追加）

Upstash の無料枠を超える場合は、エージェントの更新間隔を延ばすか有料プランを検討してください。

---

## ローカル開発

```bash
npm run dev                 # http://localhost:7320（Upstash 未設定ならメモリに保存）
npm run agent:mock -- --server http://localhost:7320 --token <エージェントトークン>
npm test
```

`agent:mock` は 12 人のダミーフレンドが数秒ごとにランダムで状態を変えるので、League クライアントがなくても通知まで確認できます。

---

## ファイル構成

```
api/                 Vercel サーバーレス関数
  account.js           アカウント作成 / 情報 / 削除
  state.js             ブラウザ用の状態取得（Riot API チェックも兼ねる）
  watch.js             監視リストの追加・削除
  settings.js          設定の更新
  refresh.js           Riot API チェックを今すぐ実行
  test-notify.js       テスト通知
  cron.js              全ユーザーの Riot API チェック
  agent/push.js        エージェントからの状態受信
  agent/token.js       エージェントトークンの再発行
lib/
  core.js              フレンド状態の正規化・LoL 在席判定・通知判定
  riot.js              Riot 公開 API（Account-V1 / Spectator-V5）
  users.js             アカウント・トークン・設定
  state.js             状態の読み込みとブラウザ向けの整形
  redis.js             Upstash REST クライアント（未設定時はメモリ）
  notify.js            Discord Webhook 送信
  http.js              HTTP ヘルパー
agent/
  index.js             エージェント本体（LCU → サーバーへ送信）
  lcu.js               LCU 接続（lockfile 検出 / Basic 認証 / 自己署名証明書）
  mock.js              デモ用のダミーデータ源
public/                UI（index.html / style.css / app.js）
scripts/dev.js         ローカル開発サーバー
test/                  node:test によるテスト
```

---

## プライバシーと注意

* エージェントは**フレンドの名前・在席状態・ステータスメッセージなど表示に必要な項目だけ**をサーバーへ送ります。lockfile の認証情報や Riot の ID / パスワードは送信しません。
* 送られたデータはユーザーごとに Upstash Redis に保存され、「設定 → アカウントを削除」ですべて消えます。
* 登録した Riot API キーは Riot API を呼ぶために平文で Upstash に保存されます（ブラウザには末尾 4 文字しか返しません）。Upstash の管理者は読めるので、気になる場合は使い終わったら「削除」してください。
* Discord Webhook はサーバーから任意の URL へリクエストさせないよう、`discord.com` の Webhook URL のみ受け付けます。
* LCU API は Riot の非公式（ドキュメント化されていない）インターフェースです。クライアントの更新でレスポンス形式が変わる可能性があります。
