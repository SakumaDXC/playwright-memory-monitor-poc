# Playwright Memory Monitor PoC

メモリ監視アプリのAWS・EC2環境向けPlaywrightテストを共有するためのPoCリポジトリです。

## 収録ファイル

| ファイル | 内容 |
| --- | --- |
| `tests/TC002_AWS_01_NormalCollect_DB_Log_Verification.spec.ts` | AWS環境の正常収集テスト |
| `tests/TC002_EC2_02_NormalCollect_DB_Log_Verification.spec.ts` | EC2環境の正常収集テスト |
| `tests/TC003_AWS_01_AbnormalCollect_DB_Log_Verification.spec.ts` | AWS環境の異常収集テスト |
| `tests/TC003_EC2_02_AbnormalCollect_DB_Log_Verification.spec.ts` | EC2環境の異常収集テスト |
| `tests/helpers/ec2-ssh.ts` | EC2接続用のヘルパー |

詳しい検証内容は各テストファイルを参照してください。

## セットアップ

Node.jsとnpmを用意し、このリポジトリを取得したフォルダーで以下を実行します。

```bash
npm ci
npx playwright install
```

## テストの実行

接続先や認証情報など、テストに必要な設定を用意してから実行してください。必要な設定は `playwright.config.ts` と各テストファイルで確認してください。

```bash
npx playwright test
```

特定のテストファイルだけを実行する場合：

```bash
npx playwright test tests/TC002_AWS_01_NormalCollect_DB_Log_Verification.spec.ts
```

AWS・EC2などの外部環境を使うテストは、接続先の準備やアクセス権限がない環境では実行できません。

## セキュリティ上の注意

- このリポジトリはPublicです。
- `.env`、パスワード、秘密鍵、アクセストークンを登録しないでください。
- 実行結果、スクリーンショット、ログを共有する前に、機密情報が含まれていないか確認してください。
