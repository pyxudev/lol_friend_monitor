# 0002. データストア：Upstash Redis（REST API を直接呼ぶ）

- ステータス: 採用
- 日付: 2026-11-19

## 背景

従来は監視リストと設定を `data/config.json` に保存していた。Vercel のサーバーレス関数はファイルシステムを永続化できず、インスタンス間でメモリも共有できないため、外部ストアが必要になった。
保存するのはユーザーごとの小さな JSON（設定・監視リスト・直近の状態・通知ログ）で、検索や結合は不要。

## 検討した案

- **Upstash Redis**：Vercel Marketplace から連携でき、無料枠がある。KV 用途に向いている。
- **Neon Postgres**：データが増えた場合に向いているが、スキーマ管理が必要で今回の用途には過剰。

## 決定

**Upstash Redis** を採用し、SDK を入れずに REST API を `fetch` で直接呼ぶ（`lib/redis.js`）。依存パッケージ 0 の方針を保つ。

- 環境変数は `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`、または Marketplace 連携時の `KV_REST_API_URL` / `KV_REST_API_TOKEN` のどちらでもよい。
- 未設定のときはローカル開発用にプロセス内メモリで動く。Vercel 上（`VERCEL` 環境変数あり）で未設定ならエラーにする。

キー設計:

| キー | 内容 |
|---|---|
| `users` | 全ユーザー ID の SET（cron で巡回） |
| `tok:<sha256>` | トークン → `<uid>:user` / `<uid>:agent`（[0003](0003-authentication.md)） |
| `u:<uid>:cfg` | 監視リスト・設定・エージェントトークン |
| `u:<uid>:agent` | エージェント由来の状態・判定用の前回状態・通知ログ |
| `u:<uid>:riot` | Riot API 由来の状態・通知ログ |
| `u:<uid>:riotlock` | Riot チェックの多重実行防止（`SET NX EX 50`） |
| `riot:puuid:<name#tag>` | Riot ID → PUUID のキャッシュ（7 日、見つからない場合は 1 時間） |

## 結果

- Upstash は**コマンド数で課金**されるため、コマンドを減らす設計にした。
  - `cfg` / `agent` / `riot` は `MGET` 1 回でまとめて読む。ブラウザの状態取得は 1 コマンドで済む。
  - 通知ログは別リストにせず `agent` / `riot` の中に持ち、読み出し時にマージする。
  - エージェントは状態が変わったときと 60 秒ごとにだけ送る。1 回の送信は 2 コマンド。
- `agent` と `riot` を別キーにしたので、エージェントの送信と Riot チェックが同時に走っても互いの書き込みを上書きしない。
- 利用者が増えると無料枠を超える可能性がある（README に目安を記載）。
