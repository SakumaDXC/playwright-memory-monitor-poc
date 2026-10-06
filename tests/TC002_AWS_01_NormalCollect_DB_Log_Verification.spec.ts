/**
 * =========================================================
 * このテストで確認すること
 * =========================================================
 * AWS上のメモリ監視アプリ（画面はS3、処理はLambda、DBはRDS）で
 * 「正常収集」ボタンを押し、次の3つが正しく起きているかを確認する。
 *
 *   1. 画面      ：「収集処理が正常に完了しました。」と表示される
 *   2. DB（RDS） ：memory_usage_logテーブルに新しいレコードが1件追加される
 *   3. ログ      ：CloudWatch Logsに、今回の処理の結果が書き込まれる
 *
 * さらに、DBに登録された「メモリ使用率」と、ログに書かれた「メモリ使用率」を突き合わせる。
 * 一致すれば、DBとログが「今回のボタン操作による同じ1回の処理」の記録だと判断できる。
 *
 * ---------------------------------------------------------
 * ログの探し方（EC2版との違い）
 * ---------------------------------------------------------
 * EC2版は、APIの応答に含まれるexecution_idを使って、今回のログを直接探せる。
 * AWS版はそのIDが使えないため、次の手順で今回のログを探す。
 *
 *   1. ボタン操作の5秒前以降のログを、CloudWatch Logsからすべて取得する
 *   2. ログをRequestId（Lambdaが1回の実行ごとに割り当てるID）ごとにまとめる
 *   3. まとめたものを1つずつ確認し、すべての条件を満たすものを今回の処理とみなす
 *   4. 見つからなければ、3秒ごとに取得し直す（最大60秒）
 *
 * ---------------------------------------------------------
 * 事前準備
 * ---------------------------------------------------------
 *   - .envにDB_PASSWORD（RDSのパスワード）を書いておく
 *   - AWSの認証情報（aws configureなど）を設定しておく。CloudWatch Logsの読み取りに使う
 *
 * ---------------------------------------------------------
 * 実行方法
 * ---------------------------------------------------------
 *   npx playwright test tests/TC002_AWS --project=chromium --workers=1
 *
 * ※ 「tests/TC002_AWS」は、ファイルの場所にこの文字列を含むテストを実行するという指定。
 *    ファイル名の末尾のバージョン（_01など）が変わっても、このコマンドのまま実行できる。
 *
 * ※ --workers=1は「テストを1つずつ順番に実行する」という指定。
 *    他のテストと同時に動くと、そちらで登録されたDBレコードやログを
 *    今回の処理のものと取り違える可能性があるため。
 */

/*
 * .envファイルに書いた設定値を読み込む。
 * 読み込んだ値は、コード内でprocess.env.設定名として使える。
 *   例：.envに「DB_PASSWORD=xxxx」と書けば、process.env.DB_PASSWORDで取り出せる
 */
import 'dotenv/config';

/*
 * Playwright（ブラウザーを自動操作してテストするツール）の基本機能を読み込む。
 *   test  ：テストを定義する。test('テスト名', 処理)の形で書く
 *   expect：結果が期待どおりかを判定する。期待と違えば、その時点でテストは失敗になる
 */
import { test, expect } from '@playwright/test';

/*
 * AWSのCloudWatch Logsを操作する機能を読み込む。
 *   CloudWatchLogsClient  ：CloudWatch Logsへの接続
 *   FilterLogEventsCommand：条件（期間など）を指定してログを取得する命令
 */
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand
} from '@aws-sdk/client-cloudwatch-logs';

/* PostgreSQL（RDSのDB）に接続する機能を読み込む */
import { Client } from 'pg';

/*
 * Node.jsに最初から入っている機能を読み込む。
 *   fs  ：ファイルの読み込みと保存を行う
 *   path：フォルダー名とファイル名をつなげて、ファイルパスを組み立てる
 */
import * as fs from 'fs';
import * as path from 'path';

/* =========================================================
 * 設定値
 * =========================================================
 * 「process.env.XXX ?? 初期値」の意味：
 *   .envにXXXが書かれていればその値を使い、書かれていなければ「??」の右側の初期値を使う。
 * 初期値は、これまでコードに直接書いていた値と同じ。
 */

/* ブラウザーで開くアプリの画面のURL（S3で公開している） */
const APP_URL =
  process.env.AWS_APP_URL ??
  'http://memory-monitor-poc-frontend-177213405059.s3-website-ap-northeast-1.amazonaws.com';

/* AWSのリージョン（ap-northeast-1 = 東京） */
const AWS_REGION =
  process.env.AWS_REGION ?? 'ap-northeast-1';

/* 正常収集のLambdaがログを書き込むロググループ（ログの保存場所）の名前 */
const LOG_GROUP_NAME =
  process.env.AWS_LOG_GROUP_NAME ??
  '/aws/lambda/memory-monitor-poc-collect-normal';

/* 正常収集が終わったときに、画面に表示されるはずのメッセージ */
const SUCCESS_MESSAGE =
  '収集処理が正常に完了しました。';

/*
 * 正常に処理が終わったときに、CloudWatch Logsへ必ず書き込まれるはずのメッセージの一覧。
 *   実行方式: 手動実行：ボタン操作（手動）で実行されたことを表す
 *                       （自動収集で動いた処理と区別するために使う）
 *   DB登録結果: 成功  ：DBへの登録が成功したことを表す
 *   INFO OK          ：メモリ使用率の判定結果が正常だったことを表す
 *   処理終了         ：処理が途中で止まらず、最後まで実行されたことを表す
 */
const EXPECTED_LOG_MESSAGES = [
  '実行方式: 手動実行',
  'DB登録結果: 成功',
  'INFO OK',
  '処理終了'
];

/*
 * Lambdaが実行を始めたときに、自動で書き込む開始ログの文字列。
 * 例：「START RequestId: 8f507cfc-xxxx-... Version: $LATEST」
 */
const LAMBDA_START_LOG = 'START RequestId:';

/*
 * 正常収集で記録されるメモリ使用率（％）の範囲。
 * DBに登録された値がこの範囲から外れていれば、テストを失敗にする。
 */
const MIN_MEMORY_USAGE = 50;
const MAX_MEMORY_USAGE = 99;

/*
 * PCの時計とAWSの時計のずれを、どこまで許すか（5秒）。
 * ログは「ボタン操作の5秒前」から探す。
 */
const CLOCK_TOLERANCE_MS = 5000;

/* DBに新しいレコードが登録されるのを待つ最大時間（30秒） */
const DB_WAIT_TIMEOUT_MS = 30000;

/* CloudWatch Logsに今回のログが届くのを待つ最大時間（60秒） */
const LOG_WAIT_TIMEOUT_MS = 60000;

/**
 * DBに接続するときのSSL（暗号化通信）の設定を作る関数。
 *
 * .envにDB_SSL_CA_PATHが書かれている場合：
 *   RDSの証明書ファイルを使い、接続先が本物のRDSかを検証する（安全な設定）
 * 書かれていない場合：
 *   通信は暗号化するが、接続先が本物かは検証しない（これまでと同じ設定）
 *
 * RDSの証明書ファイルは、AWSの公式サイトから「global-bundle.pem」として入手できる。
 */
function createSslConfig() {
  const caPath = process.env.DB_SSL_CA_PATH;

  if (caPath) {
    return {
      ca: fs.readFileSync(caPath, 'utf8'),
      rejectUnauthorized: true
    };
  }

  return {
    rejectUnauthorized: false
  };
}

/*
 * RDS（PostgreSQL）への接続情報。
 * パスワードはコードに書かず、.envのDB_PASSWORDから読み込む。
 */
const DB_CONFIG = {
  host:
    process.env.RDS_DB_HOST ??
    'playwright-poc-db.c3kyuus8y9fo.ap-northeast-1.rds.amazonaws.com',
  port: Number(process.env.RDS_DB_PORT ?? 5432),
  database: process.env.RDS_DB_NAME ?? 'postgres',
  user: process.env.RDS_DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: createSslConfig()
};

/* =========================================================
 * データの形の定義
 * =========================================================
 * TypeScriptでは、データの形を決めておくと、項目名の書き間違いを事前に見つけられる。
 */

/* memory_usage_logテーブルの1レコードの形 */
type DbRecord = {
  id: number;
  collect_datetime: Date;
  memory_usage: number;
  created_at: Date;
};

/* CloudWatch Logsのログ1行の形（書き込まれた日時と、メッセージ） */
type CloudWatchLog = {
  timestamp: string | null;
  message: string;
};

/*
 * 1回の実行（同じRequestIdのログのまとまり）に対する判定結果の形。
 * すべての項目がtrueなら、今回のボタン操作による処理とみなす。
 */
type ExecutionChecks = {
  startedAfterOperation: boolean;
  isManualExecution: boolean;
  hasDbSuccess: boolean;
  hasInfoOk: boolean;
  hasProcessEnd: boolean;
  hasLoggedMemoryUsage: boolean;
  logMemoryMatchesDb: boolean;
};

/* 1回の実行の、ログと判定結果をまとめたもの */
type ExecutionEvaluation = {
  requestId: string;
  memoryUsages: number[];
  checks: ExecutionChecks;
  events: CloudWatchLog[];
};

/* =========================================================
 * DB（RDS）を確認する関数
 * ========================================================= */

/**
 * memory_usage_logテーブルから、最新のレコード（idがいちばん大きいもの）を1件取得する関数。
 * レコードが1件もなければnullを返す。
 *
 * 「async」が付いた関数の中では「await」が使える。
 * 「await」は、その処理（DBへの接続など）が終わるまで待ってから次の行へ進むという意味。
 */
async function getLatestDbRecord(): Promise<DbRecord | null> {
  /* パスワードがなければ接続できないので、分かりやすいメッセージで先に止める */
  if (!DB_CONFIG.password) {
    throw new Error(
      'DB_PASSWORDが設定されていません。.envファイルを確認してください。'
    );
  }

  const client = new Client(DB_CONFIG);

  /*
   * try { ... } finally { ... }：tryの中でエラーが起きても起きなくても、
   * 最後に必ずfinallyの中の処理（ここではDBとの接続を閉じる）を実行する書き方。
   */
  try {
    await client.connect();

    /* idの大きい順に並べて、先頭の1件だけを取得する */
    const result = await client.query<DbRecord>(`
      SELECT
        id,
        collect_datetime,
        memory_usage,
        created_at
      FROM memory_usage_log
      ORDER BY id DESC
      LIMIT 1
    `);

    /* 「?? null」：レコードがなければnullを返す */
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

/**
 * 指定したidより新しいレコードが登録されるまで待ち、登録されたレコードを返す関数。
 *
 * Lambdaの処理が終わってDBに登録されるまで少し時間がかかるため、
 * 2秒ごとに最新レコードを確認する。
 * 制限時間内に登録されなければ、エラーにする。
 */
async function waitForNewDbRecord(
  beforeId: number,
  timeoutMilliseconds: number
): Promise<DbRecord> {
  /* 待つのをやめる時刻（現在時刻 + 制限時間） */
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    const latestRecord = await getLatestDbRecord();

    /* ボタン操作前の最新idより大きければ、新しく登録されたレコード */
    if (latestRecord && latestRecord.id > beforeId) {
      return latestRecord;
    }

    /* まだ登録されていなければ、2秒待ってからもう一度確認する */
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(
    `DBに新規レコードが登録されませんでした。処理前の最新ID: ${beforeId}`
  );
}

/* =========================================================
 * CloudWatch Logsを確認する関数
 * ========================================================= */

/**
 * ログ1行から、RequestId（Lambdaが1回の実行ごとに割り当てるID）を取り出す関数。
 * 見つからなければnullを返す。
 *
 * Lambdaのログには、次のような形でRequestIdが書かれている。
 *   開始・終了のログ：「START RequestId: 8f507cfc-xxxx-... Version: $LATEST」
 *   アプリのログ　　：「2026-10-01T09:45:40.000Z<タブ>8f507cfc-xxxx-...<タブ>INFO ...」
 *
 * 正規表現（文字列のパターン）の意味
 *   (?:RequestId:\s*|\t)：「RequestId:」とその後の空白、またはタブ文字の直後から探す
 *   ([0-9a-fA-F-]{36})  ：36文字の英数字とハイフン（RequestIdの形）を取り出す
 *   (?:\s|\\t|\t)       ：その直後に空白かタブがあること
 */
function extractRequestId(message: string): string | null {
  const match = message.match(
    /(?:RequestId:\s*|\t)([0-9a-fA-F-]{36})(?:\s|\\t|\t)/
  );

  return match ? match[1] : null;
}

/**
 * ログから「メモリ使用率: 数値」を探し、数値の部分をすべて取り出す関数。
 *   例：「... メモリ使用率: 65 ...」 → 65 を取り出す
 *
 * 1回の処理の中でメモリ使用率が何度か書き込まれる場合があるため、
 * 見つかった数値をすべて配列（[65, 65] のような一覧）にして返す。
 * 1つも見つからなければ、空の配列 [] を返す。
 */
function extractMemoryUsages(
  events: CloudWatchLog[]
): number[] {
  const memoryUsages: number[] = [];

  for (const event of events) {
    /*
     *   メモリ使用率: ：この文字を探す
     *   \s*          ：その後ろにある空白を読み飛ばす（空白がなくてもよい）
     *   (\d+)        ：続く数字の部分を取り出す
     */
    const match = event.message.match(/メモリ使用率:\s*(\d+)/);

    if (match) {
      /* 文字列の "65" を数値の 65 に変換して、配列に追加する */
      memoryUsages.push(Number(match[1]));
    }
  }

  return memoryUsages;
}

/**
 * ログの中に、指定した文字列を含む行が1行でもあるかを確認する関数。
 *   1行でもあれば：true
 *   1行もなければ：false
 *
 * some：配列の中に、条件に合うものが1つでもあればtrueを返す。
 * includes：文字列の中に、指定した文字列が含まれていればtrueを返す。
 */
function hasMessage(
  events: CloudWatchLog[],
  expectedMessage: string
): boolean {
  return events.some(event =>
    event.message.includes(expectedMessage)
  );
}

/**
 * CloudWatch Logsから、指定した時刻以降のログをすべて取得する関数。
 *
 * CloudWatch Logsは、ログが多いと1回ですべてを返さず、
 * 「続きがある」という印（nextToken）を付けて返してくる。
 * そのため、nextTokenがなくなるまで、続きを取得し続ける。
 */
async function getCloudWatchEvents(
  cloudWatchClient: CloudWatchLogsClient,
  searchStartTime: number
): Promise<CloudWatchLog[]> {
  /* 取得したログをためておく配列 */
  const collectedEvents: CloudWatchLog[] = [];

  /* 続きを取得するための印。最初はなし（undefined） */
  let nextToken: string | undefined;

  /* do { ... } while (条件)：まず1回実行し、条件を満たす間は繰り返す書き方 */
  do {
    const previousToken = nextToken;

    /* 指定した期間（searchStartTimeから現在まで）のログを取得する */
    const response = await cloudWatchClient.send(
      new FilterLogEventsCommand({
        logGroupName: LOG_GROUP_NAME,
        startTime: searchStartTime,
        endTime: Date.now(),
        /* 複数の保存先（ログストリーム）にまたがるログを、時刻順に混ぜて返す */
        interleaved: true,
        nextToken
      })
    );

    /*
     * 取得したログを、このテストで使う形（日時とメッセージ）に変換する。
     * map：配列の各要素を、別の形に変換した新しい配列を作る。
     */
    const currentEvents =
      (response.events ?? []).map(event => ({
        timestamp:
          event.timestamp !== undefined
            ? new Date(event.timestamp).toISOString()
            : null,
        message: event.message ?? ''
      }));

    /* 「...」は、配列の中身を1つずつ取り出して追加する書き方 */
    collectedEvents.push(...currentEvents);

    nextToken = response.nextToken;

    /*
     * 続きがない、または前回と同じ印が返ってきた（これ以上進まない）場合は終了する。
     * 同じ印のまま繰り返すと、無限に続いてしまうため。
     */
    if (nextToken === undefined || nextToken === previousToken) {
      break;
    }
  } while (nextToken);

  return collectedEvents;
}

/**
 * ログをRequestIdごとにまとめる関数。
 *
 * CloudWatch Logsには、複数回の実行のログが混ざって入っている。
 * RequestIdが同じログは同じ1回の実行のものなので、RequestIdごとに分けてまとめる。
 *
 * Map：「キー（ここではRequestId）」と「値（ここではログの一覧）」の組を管理するしくみ。
 */
function groupEventsByRequestId(
  events: CloudWatchLog[]
): Map<string, CloudWatchLog[]> {
  const eventsByRequestId = new Map<string, CloudWatchLog[]>();

  for (const event of events) {
    const requestId = extractRequestId(event.message);

    /* RequestIdが書かれていない行は、どの実行のものか分からないので飛ばす */
    if (!requestId) {
      continue;
    }

    /* そのRequestIdのログの一覧を取り出し（まだなければ空の一覧）、1行追加して戻す */
    const requestEvents = eventsByRequestId.get(requestId) ?? [];
    requestEvents.push(event);
    eventsByRequestId.set(requestId, requestEvents);
  }

  return eventsByRequestId;
}

/**
 * 1回の実行のログが、今回のボタン操作による正常収集の条件を満たすかを判定する関数。
 * 各条件をtrue（満たす）かfalse（満たさない）で判定し、結果をまとめて返す。
 */
function evaluateExecution(
  requestId: string,
  events: CloudWatchLog[],
  dbRecordAfter: DbRecord
): ExecutionEvaluation {
  const memoryUsages = extractMemoryUsages(events);

  const checks: ExecutionChecks = {
    /*
     * Lambdaの開始ログ（START RequestId:）があること。
     * ログはボタン操作の5秒前以降の分だけを取得しているので、
     * 開始ログがあれば、この実行はボタン操作の5秒前以降に始まったと分かる。
     * 開始ログがない場合は、もっと前に始まった別の実行の、終わりの部分だけが含まれている。
     */
    startedAfterOperation:
      hasMessage(events, LAMBDA_START_LOG),

    /* ボタン操作で実行された（自動収集ではない） */
    isManualExecution:
      hasMessage(events, '実行方式: 手動実行'),

    /* DB登録に成功した */
    hasDbSuccess:
      hasMessage(events, 'DB登録結果: 成功'),

    /* メモリ使用率の判定が正常だった */
    hasInfoOk:
      hasMessage(events, 'INFO OK'),

    /* 処理が最後まで実行された */
    hasProcessEnd:
      hasMessage(events, '処理終了'),

    /* ログからメモリ使用率を1つ以上取り出せた（取り出せないと次の比較ができない） */
    hasLoggedMemoryUsage:
      memoryUsages.length > 0,

    /*
     * ログに書かれたメモリ使用率が、すべてDBの値と同じであること。
     * every：配列のすべての値が条件に合えばtrueを返す。
     * ログとDBが同じ1回の処理の記録かを判断する、いちばん重要な確認。
     */
    logMemoryMatchesDb:
      memoryUsages.length > 0 &&
      memoryUsages.every(value => value === dbRecordAfter.memory_usage)
  };

  return { requestId, memoryUsages, checks, events };
}

/**
 * 判定結果がすべてtrueかを確認する関数。
 * Object.values：checksに入っているtrue/falseを一覧にして取り出す。
 */
function isAllPassed(checks: ExecutionChecks): boolean {
  return Object.values(checks).every(Boolean);
}

/**
 * 今回のボタン操作による処理のログが見つかるまで待ち、見つかったログと判定結果を返す関数。
 *
 * CloudWatch Logsにログが届くまでには、数秒から数十秒かかることがある。
 * そのため、見つかるまで3秒ごとにログを取得し直す。
 *
 * 制限時間内に見つからなければ、候補になった実行ごとに
 * 「どの条件を満たさなかったか」を表示してエラーにする。
 */
async function waitForMatchingCloudWatchLogs(
  operationStartTime: number,
  dbRecordAfter: DbRecord,
  timeoutMilliseconds: number
): Promise<ExecutionEvaluation> {
  const cloudWatchClient = new CloudWatchLogsClient({
    region: AWS_REGION
  });

  const deadline = Date.now() + timeoutMilliseconds;

  /* PCとAWSの時計のずれを考えて、ボタン操作の5秒前からのログを探す */
  const searchStartTime = operationStartTime - CLOCK_TOLERANCE_MS;

  /* 最後に確認した候補の判定結果。見つからなかったときの原因表示に使う */
  let lastEvaluations: ExecutionEvaluation[] = [];

  try {
    while (Date.now() < deadline) {
      const events = await getCloudWatchEvents(
        cloudWatchClient,
        searchStartTime
      );

      console.log('CloudWatch取得件数:', events.length);

      /* RequestIdごとにまとめ、それぞれを判定する */
      lastEvaluations = [...groupEventsByRequestId(events).entries()]
        .map(([requestId, requestEvents]) =>
          evaluateExecution(requestId, requestEvents, dbRecordAfter)
        );

      /* find：条件に合う最初の1つを取り出す。すべての判定がtrueの実行を探す */
      const matchingExecution =
        lastEvaluations.find(evaluation => isAllPassed(evaluation.checks));

      if (matchingExecution) {
        return matchingExecution;
      }

      /* まだ見つからなければ、3秒待ってからもう一度取得する */
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } finally {
    /* CloudWatch Logsとの接続を閉じる */
    cloudWatchClient.destroy();
  }

  /* 候補ごとの判定結果を、1行ずつの文字列にする（失敗の原因を調べるため） */
  const candidateSummary =
    lastEvaluations.length > 0
      ? lastEvaluations
          .map(evaluation =>
            `RequestId=${evaluation.requestId} ` +
            `ログのメモリ使用率=[${evaluation.memoryUsages}] ` +
            `判定=${JSON.stringify(evaluation.checks)}`
          )
          .join('\n')
      : '(対象期間にRequestId付きのログがありません)';

  throw new Error(
    [
      '今回のDB登録結果と一致するCloudWatchログが見つかりませんでした。',
      `DB ID: ${dbRecordAfter.id}`,
      `DBメモリ使用率: ${dbRecordAfter.memory_usage}`,
      `ロググループ: ${LOG_GROUP_NAME}`,
      '候補ごとの判定結果（falseの項目が満たさなかった条件）:',
      candidateSummary
    ].join('\n')
  );
}

/* =========================================================
 * テスト本体
 * =========================================================
 * test('テスト名', async ({ page }, testInfo) => { ... }) の形で書く。
 * 波かっこ { ... } の中が、テストで実行する処理。
 *
 * Playwrightが自動で用意して渡してくれるもの
 *   page    ：テスト用に開かれたブラウザーのタブ。画面を開く・ボタンを押すなどの操作に使う
 *   testInfo：実行中のテストの情報。HTMLレポートにファイルを添付するのに使う
 */
test(
  'TC002_AWS 正常収集：DBレコードとCloudWatchログ突合',
  async ({ page }, testInfo) => {
    /*
     * このテストの制限時間を120秒にする。
     * Playwrightの標準は30秒だが、DBへの登録やログが届くのを待つ時間があるため長めにしている。
     */
    test.setTimeout(120000);

    /*
     * 証跡（スクリーンショットと結果ファイル）を保存するフォルダーを作る。
     * recursive: true は「フォルダーがすでにあってもエラーにしない」という指定。
     */
    const evidenceDirectory = path.resolve('evidence');
    fs.mkdirSync(evidenceDirectory, { recursive: true });

    /* 保存するファイル名が前回の実行と重ならないよう、現在時刻（ミリ秒）を番号として使う */
    const evidenceId = Date.now();

    /* -------------------------------------------------------
     * 手順1：ボタンを押す前の、DBの最新レコードを記録しておく
     * -------------------------------------------------------
     * DBのレコードには、登録順に大きくなる番号（id）が振られている。
     * ボタンを押す前の最新のidを覚えておけば、
     * ボタンを押した後にそれより大きいidのレコードがあるかどうかで、
     * 新しく登録されたかを判断できる。
     */
    const dbRecordBefore = await getLatestDbRecord();

    if (!dbRecordBefore) {
      throw new Error(
        'memory_usage_logテーブルにレコードがありません。'
      );
    }

    console.log('処理前DBレコード:', dbRecordBefore);

    /* -------------------------------------------------------
     * 手順2：アプリの画面を開く
     * -------------------------------------------------------
     * page.goto：ブラウザーで指定したURLを開く（Playwrightの機能）。
     * ページの読み込みが終わるまで待ってから、次の行へ進む。
     */
    await page.goto(APP_URL);

    /* -------------------------------------------------------
     * 手順3：「正常収集」ボタンを押す
     * -------------------------------------------------------
     * ボタンを押した時刻を記録しておく（ログを探す期間の起点にするため）。
     *
     * page.getByRole：画面の部品を「種類」と「表示されている名前」で探す（Playwrightの機能）。
     * ここでは「正常収集」と書かれたボタンを探し、click()でクリックする。
     */
    const operationStartTime = Date.now();

    await page.getByRole('button', { name: '正常収集' }).click();

    /* -------------------------------------------------------
     * 手順4：画面に完了メッセージが表示されたことを確認する
     * -------------------------------------------------------
     * page.getByText：指定した文字列が書かれている画面の部品を探す（Playwrightの機能）。
     * toBeVisible：その部品が画面に表示されることを確認する。
     *   すぐに表示されなくても、表示されるまで少しの間（標準で5秒）待ってくれる。
     *   それでも表示されなければ、テストは失敗する。
     */
    await expect(
      page.getByText(SUCCESS_MESSAGE)
    ).toBeVisible();

    /*
     * 証跡として、画面のスクリーンショットを保存する。
     * fullPage: true は、画面に収まっていない下の部分まで含めて、ページ全体を撮影する指定。
     */
    const screenshotPath = path.join(
      evidenceDirectory,
      `TC002_AWS_NormalCollect_Success_${evidenceId}.png`
    );

    await page.screenshot({ path: screenshotPath, fullPage: true });

    /* -------------------------------------------------------
     * 手順5：DBに新しいレコードが登録されたことを確認する
     * -------------------------------------------------------
     * 手順1で記録したidより新しいレコードが登録されるまで待ち、登録されたレコードを受け取る。
     */
    const dbRecordAfter = await waitForNewDbRecord(
      dbRecordBefore.id,
      DB_WAIT_TIMEOUT_MS
    );

    console.log('処理後DBレコード:', dbRecordAfter);

    /* 新しいレコードのidが、ボタンを押す前の最新のidより大きいことを確認する */
    expect(
      dbRecordAfter.id,
      '新しいDBレコードが追加されていません。'
    ).toBeGreaterThan(dbRecordBefore.id);

    /* 登録されたメモリ使用率が、正常収集の範囲（50～99）に入っていることを確認する */
    expect(
      dbRecordAfter.memory_usage,
      `DBのメモリ使用率が${MIN_MEMORY_USAGE}未満です。`
    ).toBeGreaterThanOrEqual(MIN_MEMORY_USAGE);

    expect(
      dbRecordAfter.memory_usage,
      `DBのメモリ使用率が${MAX_MEMORY_USAGE}を超えています。`
    ).toBeLessThanOrEqual(MAX_MEMORY_USAGE);

    /* -------------------------------------------------------
     * 手順6：今回の処理のログを、CloudWatch Logsから探す
     * -------------------------------------------------------
     * 次の条件をすべて満たす実行（RequestId）を探す。
     *   - ボタン操作の5秒前以降に始まった
     *   - 手動実行、DB登録成功、INFO OK、処理終了のログがそろっている
     *   - ログのメモリ使用率が、手順5で登録されたDBの値と同じ
     *
     * 条件をすべて満たす実行が見つかった時点で、確認は合格になる。
     * 見つからなければ、関数の中で原因を表示してテストを失敗させる。
     */
    const matchingExecution = await waitForMatchingCloudWatchLogs(
      operationStartTime,
      dbRecordAfter,
      LOG_WAIT_TIMEOUT_MS
    );

    console.log('一致したRequestId:', matchingExecution.requestId);
    console.log('DBメモリ使用率:', dbRecordAfter.memory_usage);
    console.log('ログのメモリ使用率:', matchingExecution.memoryUsages);
    console.log('判定結果:', matchingExecution.checks);
    console.log('一致したCloudWatch Logs:', matchingExecution.events);

    /* -------------------------------------------------------
     * 手順7：テスト結果を証跡ファイル（JSON）に保存する
     * -------------------------------------------------------
     * ここまで来たということは、すべての確認に合格したということ。
     * 後から「いつ・何を・どのように確認して・どうだったか」を確認できるよう、
     * 確認に使った値と判定結果をすべてまとめて、ファイルに保存する。
     */
    const evidence = {
      testCase: 'TC002_AWS 正常収集：DBレコードとCloudWatchログ突合',
      result: 'PASS',
      /* toISOString()：日時を「2026-10-02T04:56:08.000Z」のような国際標準の文字列にする */
      executedAt: new Date().toISOString(),
      applicationUrl: APP_URL,
      operationStartTime: new Date(operationStartTime).toISOString(),

      /* 画面の確認結果 */
      screen: {
        expectedMessage: SUCCESS_MESSAGE,
        verified: true
      },

      /* DBの確認結果（ボタンを押す前と後のレコード） */
      database: {
        table: 'memory_usage_log',
        before: dbRecordBefore,
        after: dbRecordAfter,
        verified: dbRecordAfter.id > dbRecordBefore.id
      },

      /* ログの確認結果（今回の処理のログもすべて記録する） */
      cloudWatch: {
        logGroupName: LOG_GROUP_NAME,
        requestId: matchingExecution.requestId,
        searchStartTime: new Date(operationStartTime - CLOCK_TOLERANCE_MS).toISOString(),
        expectedMessages: EXPECTED_LOG_MESSAGES,
        events: matchingExecution.events
      },

      /* DBとログを突き合わせた結果 */
      correlation: {
        /* どのような方法で突き合わせたか */
        method: [
          'ボタン操作の5秒前以降のログを取得し、RequestIdごとにまとめる',
          'Lambdaの開始ログがあるかで、ボタン操作後に始まった実行かを確認',
          '手動実行・DB登録成功・INFO OK・処理終了のログがそろっているかを確認',
          'ログのメモリ使用率が、すべてDBの値と同じかを比較'
        ],
        dbMemoryUsage: dbRecordAfter.memory_usage,
        logMemoryUsages: matchingExecution.memoryUsages,
        /* 手順6の判定結果 */
        checks: matchingExecution.checks,
        /* すべての判定がtrueならtrue */
        verified: isAllPassed(matchingExecution.checks)
      }
    };

    const jsonEvidencePath = path.join(
      evidenceDirectory,
      `TC002_AWS_NormalCollect_Result_${evidenceId}.json`
    );

    /*
     * evidenceの内容をJSON形式の文字列にして、ファイルに保存する。
     * JSON.stringifyの「null, 2」は、人が読みやすいように2文字ずつ字下げして書き出す指定。
     */
    fs.writeFileSync(
      jsonEvidencePath,
      JSON.stringify(evidence, null, 2),
      'utf8'
    );

    /*
     * testInfo.attach：PlaywrightのHTMLレポートにファイルを添付する（Playwrightの機能）。
     * 添付しておくと、レポート画面からスクリーンショットや結果ファイルを直接開ける。
     */
    await testInfo.attach('TC002_AWS 正常収集画面', {
      path: screenshotPath,
      contentType: 'image/png'
    });

    await testInfo.attach('TC002_AWS DB・CloudWatch突合結果', {
      path: jsonEvidencePath,
      contentType: 'application/json'
    });
  }
);