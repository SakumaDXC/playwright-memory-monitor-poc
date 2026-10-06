/**
 * =========================================================
 * このテストで確認すること
 * =========================================================
 * EC2上で動いているメモリ監視アプリの画面を開き、「正常収集」ボタンを押す。
 * その結果、次の3つが正しく起きているかを確認する。
 *
 *   1. 画面：「収集処理が正常に完了しました。」と表示される
 *   2. DB  ：memory_usage_logテーブルに新しいレコードが1件追加される
 *   3. ログ：EC2上のapplication.logに、今回の処理の結果が書き込まれる
 *
 * さらに、次の3か所に記録された「メモリ使用率」と「収集日時」を突き合わせる。
 *   - ボタンを押したときに画面の裏で呼ばれたAPIの応答
 *   - DBに登録されたレコード
 *   - application.logに書き込まれたログ
 * 値が一致すれば、3つとも「今回のボタン操作による同じ1回の処理」の記録だと判断できる。
 *
 * ---------------------------------------------------------
 * 接続のしくみ（SSHトンネル）
 * ---------------------------------------------------------
 * アプリはEC2の内部（127.0.0.1:8000）でしか待ち受けていない。
 * そのため、PCのブラウザーからEC2のアプリを直接開くことはできない。
 *
 * そこで「SSHトンネル」を使う。
 * SSHトンネルは、PCの8000番ポートに届いた通信を、SSH接続を通してEC2の8000番ポートへ転送するしくみ。
 * ブラウザーはPC自身（127.0.0.1:8000）を開くだけで、EC2のアプリを表示できる。
 *
 *   PCのブラウザー → PCの127.0.0.1:8000 → SSHトンネル → EC2の127.0.0.1:8000（アプリ本体）
 *
 * このテストでのトンネルの扱い
 *   - トンネルが開いていなければ、テスト開始時に自動で作り、テスト終了時に閉じる
 *   - 手動で開いたトンネルがすでにあれば、それをそのまま使う（テスト終了時も閉じない）
 *   - DBとログの確認には、トンネルを使わない
 *     （helpers/ec2-ssh.tsの関数が、確認のたびにSSHでEC2へ接続してコマンドを実行するため）
 *
 * ---------------------------------------------------------
 * 実行方法
 * ---------------------------------------------------------
 *   npx playwright test tests/TC002_EC2 --project=chromium --workers=1
 *
 * ※ 「tests/TC002_EC2」は、ファイルの場所にこの文字列を含むテストを実行するという指定。
 *    ファイル名の末尾のバージョン（_02など）が変わっても、このコマンドのまま実行できる。
 *
 * ※ --workers=1は「テストを1つずつ順番に実行する」という指定。
 *    複数を同時に実行すると、それぞれが同じ8000番ポートでトンネルを作ろうとしてぶつかるため。
 */

/*
 * .envファイルに書いた設定値を読み込む。
 * 読み込んだ値は、コード内でprocess.env.設定名として使える。
 *   例：.envに「EC2_HOST=13.196.191.160」と書けば、process.env.EC2_HOSTで取り出せる
 */
import 'dotenv/config';

/*
 * Playwright（ブラウザーを自動操作してテストするツール）の基本機能を読み込む。
 *   test  ：テストを定義する。test('テスト名', 処理)の形で書く
 *   expect：結果が期待どおりかを判定する。期待と違えば、その時点でテストは失敗になる
 */
import { test, expect } from '@playwright/test';

/*
 * Node.js（JavaScriptをPC上で動かすしくみ）に最初から入っている機能を読み込む。
 *   spawn：sshなどの外部コマンドを、画面に出さずに裏で起動する
 *   fs   ：ファイルが存在するかの確認や、ファイルの保存を行う
 *   net  ：指定したポートに接続できるか（トンネルが開いているか）を確認する
 *   os   ：ユーザーのホームフォルダー（例：C:\Users\dsakuma）の場所を取得する
 *   path ：フォルダー名とファイル名をつなげて、ファイルパスを組み立てる
 */
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/*
 * EC2のDBとログを確認する関数を、helpers/ec2-ssh.tsから読み込む。
 * どの関数も、SSHでEC2へ接続し、EC2の中でコマンドを実行して結果を受け取る。
 *   getLatestDbRecordViaSsh ：DBに登録されている最新のレコードを1件取得する
 *   waitForNewDbRecordViaSsh：指定したIDより新しいレコードが登録されるまで待ち、登録されたレコードを返す
 *   waitForApplicationLog   ：指定したexecution_idのログが書き込まれるまで待ち、該当するログの行を返す
 */
import {
  getLatestDbRecordViaSsh,
  waitForNewDbRecordViaSsh,
  waitForApplicationLog
} from './helpers/ec2-ssh';

/* =========================================================
 * 設定値
 * =========================================================
 * 「process.env.XXX ?? 初期値」の意味：
 *   .envにXXXが書かれていればその値を使い、書かれていなければ「??」の右側の初期値を使う。
 *
 * EC2を停止してから起動し直すと、パブリックIPアドレスが変わることがある。
 * そのたびにコードを書き換えなくて済むよう、接続先は.envで変更できるようにしている。
 */

/* 接続先EC2のIPアドレス */
const EC2_HOST =
  process.env.EC2_HOST ?? '13.196.191.160';

/* EC2にログインするときのユーザー名（Amazon Linuxの標準ユーザーはec2-user） */
const EC2_USER =
  process.env.EC2_USER ?? 'ec2-user';

/*
 * SSH接続に使う秘密鍵ファイルの場所。
 * 初期値は「ホームフォルダー\.ssh\memory-monitor-ec2-key.pem」。
 */
const EC2_KEY_PATH =
  process.env.EC2_KEY_PATH ??
  path.join(os.homedir(), '.ssh', 'memory-monitor-ec2-key.pem');

/*
 * PC側のポート番号。ブラウザーはこのポートを開く。
 * .envの値は文字列なので、Number()で数値に変換している。
 */
const LOCAL_PORT =
  Number(process.env.LOCAL_APP_PORT ?? 8000);

/* EC2側でアプリが待ち受けているポート番号 */
const REMOTE_PORT =
  Number(process.env.REMOTE_APP_PORT ?? 8000);

/* ブラウザーで開くURL。PC自身のアドレスで、ここがトンネルの入り口になる */
const APP_URL = `http://127.0.0.1:${LOCAL_PORT}`;

/* EC2上のログファイルの場所。確認には使わず、証跡ファイルに記録するためだけに使う */
const APPLICATION_LOG_PATH =
  '/var/log/memory-monitor/app.log';

/* 正常収集が終わったときに、画面に表示されるはずのメッセージ */
const SUCCESS_MESSAGE =
  '収集処理が正常に完了しました。';

/*
 * 正常に処理が終わったときに、application.logへ必ず書き込まれるはずのメッセージの一覧。
 *   実行方式: 手動実行：ボタン操作（手動）で実行されたことを表す
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
 * 正常収集で記録されるメモリ使用率（％）の範囲。
 * DBに登録された値がこの範囲から外れていれば、テストを失敗にする。
 */
const MIN_MEMORY_USAGE = 50;
const MAX_MEMORY_USAGE = 99;

/*
 * PCの時計とEC2の時計のずれを、どこまで許すか。単位はミリ秒（1000ミリ秒 = 1秒）なので30秒。
 * DBの収集日時がボタン操作の時刻から30秒以上離れていれば、
 * 今回のボタン操作で登録されたデータではない（別の処理のデータ）とみなす。
 */
const CLOCK_TOLERANCE_MS = 30000;

/*
 * APIが返した収集日時と、DBに登録された収集日時の差を、どこまで許すか（15秒）。
 * 同じ処理の記録なら、ほぼ同じ時刻になるはず。
 */
const DB_API_TIME_TOLERANCE_MS = 15000;

/*
 * 正常収集APIが返すデータ（JSON）の形を定義する。
 * TypeScriptでは、このように形を決めておくと、項目名の書き間違いを事前に見つけられる。
 *
 * 項目名の後ろの「?」は、「この項目は返ってこない可能性がある」という意味。
 * 実際に返ってこなかった場合は、テストの中でエラーにして失敗させる。
 *
 * 実際の応答の例：
 * {
 *   "collect_datetime": "2026/10/01 09:45:40",   ← 収集した日時
 *   "execution_id": "5ef8f23c-fcac-4e90-828e-431f3cafe334",   ← 今回の処理のID
 *   "memory_usage": 50,   ← メモリ使用率（％）
 *   "message": "収集処理が正常に完了しました。",
 *   "result": "OK"
 * }
 */
type CollectNormalResponse = {
  result?: string;
  message?: string;
  collect_datetime?: string;
  memory_usage?: number;
  execution_id?: string;
};

/* =========================================================
 * SSHトンネルの準備と後片付け
 * ========================================================= */

/*
 * このテストが自分で起動したsshの情報を入れておく変数。
 *   - テストがトンネルを作った場合：起動したsshの情報が入る
 *   - 手動で開いたトンネルを使う場合：null（空）のまま
 * テスト終了時は、ここに入っているsshだけを止める。
 * そうすることで、手動で開いたトンネルを勝手に閉じないようにしている。
 */
let tunnelProcess: ChildProcess | null = null;

/**
 * PCの指定したポートに接続できるかを確認する関数。
 *   接続できた　　：true を返す（トンネルが開いている）
 *   接続できなかった：false を返す（トンネルが開いていない）
 *
 * 「Promise」は、結果がすぐに出ない処理（通信など）の結果を、後で受け取るためのしくみ。
 * 呼び出す側は「await isPortOpen(8000)」と書くと、結果が出るまで待ってから次へ進む。
 */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    /* PC自身（127.0.0.1）の指定ポートへ接続を試みる */
    const socket = net.connect({ host: '127.0.0.1', port });

    /* 1秒待っても応答がなければ、あきらめる */
    socket.setTimeout(1000);

    /* 接続できた場合：接続を閉じて、trueを返す */
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    /* 1秒以内に応答がなかった場合：接続を閉じて、falseを返す */
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    /* 接続を拒否された場合（そのポートで何も待ち受けていない）：falseを返す */
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * 指定したポートが開くまで待つ関数。
 *
 * sshを起動しても、EC2への接続が終わってトンネルが使えるようになるまで数秒かかる。
 * そのため、0.5秒ごとにポートを確認し、開いたらすぐに次へ進む。
 *
 *   制限時間内にポートが開いた：true を返す
 *   制限時間内に開かなかった、またはsshが途中で終了した：false を返す
 *
 * 「async」が付いた関数の中では「await」が使える。
 * 「await」は、その処理が終わるまで待ってから次の行へ進むという意味。
 */
async function waitForPort(
  port: number,
  timeoutMilliseconds: number
): Promise<boolean> {
  /* 待つのをやめる時刻（現在時刻 + 制限時間） */
  const deadline = Date.now() + timeoutMilliseconds;

  /* 現在時刻がやめる時刻になるまで、確認を繰り返す */
  while (Date.now() < deadline) {
    /*
     * sshがすでに終了していないか確認する。
     * exitCodeに値が入っていれば、sshは終了している。
     * 秘密鍵が違う、EC2に接続できないなどの理由でsshが終了した場合、
     * いくら待ってもトンネルは開かないので、すぐにfalseを返す。
     */
    if (tunnelProcess && tunnelProcess.exitCode !== null) {
      return false;
    }

    /* ポートが開いていれば、trueを返して終了する */
    if (await isPortOpen(port)) {
      return true;
    }

    /* まだ開いていなければ、0.5秒（500ミリ秒）待ってからもう一度確認する */
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /* 制限時間内に開かなかった */
  return false;
}

/**
 * test.beforeAll：テスト本体より前に1回だけ実行される処理（Playwrightの機能）。
 * ここでエラーが起きると、テスト本体は実行されずに失敗になる。
 *
 * ここで行うこと
 *   1. PCの8000番ポートが開いているか（トンネルがあるか）を確認する
 *   2. 開いていなければ、sshを起動してトンネルを作る
 *   3. トンネルの先で、EC2のアプリが実際に応答するかを確認する
 *
 * 失敗したときに原因がすぐ分かるよう、
 * 「SSH接続の失敗」と「アプリが止まっている」で、別々のエラーメッセージを出す。
 */
test.beforeAll(async () => {
  /* この準備処理の制限時間を60秒にする。60秒を超えると失敗になる */
  test.setTimeout(60000);

  if (await isPortOpen(LOCAL_PORT)) {
    /*
     * すでに8000番ポートが開いている場合。
     * 手動で開いたトンネルなどがあると判断し、新しいトンネルは作らずにそれを使う。
     */
    console.log(
      `127.0.0.1:${LOCAL_PORT} は既に利用可能です。既存のSSHトンネルを使用します。`
    );
  } else {
    /*
     * 8000番ポートが開いていない場合は、トンネルを作る。
     * まず秘密鍵ファイルがあるかを確認する。
     * 秘密鍵がなければsshは必ず失敗するので、分かりやすいメッセージで先に止める。
     */
    if (!fs.existsSync(EC2_KEY_PATH)) {
      throw new Error(
        `SSH秘密鍵が見つかりません: ${EC2_KEY_PATH}`
      );
    }

    console.log(
      `SSHトンネルを開始します: PCの${LOCAL_PORT}番 -> ${EC2_HOST}の${REMOTE_PORT}番`
    );

    /* sshが出したエラーメッセージをためておく変数。失敗したときに原因として表示する */
    let sshErrorOutput = '';

    /*
     * sshコマンドを、画面に出さずに裏で起動する。
     * PowerShellで次のコマンドを実行するのと同じ。
     *
     *   ssh -i 秘密鍵 -N -L 8000:127.0.0.1:8000 ec2-user@EC2のIP
     *
     * 各オプションの意味
     *   -i                              ：接続に使う秘密鍵ファイルを指定する
     *   -N                              ：EC2にログインして操作はせず、トンネルだけを作る
     *   -L 8000:127.0.0.1:8000          ：PCの8000番に届いた通信を、EC2から見た127.0.0.1:8000へ転送する
     *   ExitOnForwardFailure=yes        ：転送の準備に失敗したら、すぐにsshを終了する（失敗に早く気づける）
     *   ServerAliveInterval=30          ：30秒ごとにEC2と通信し、何もしていない間に接続が切れるのを防ぐ
     *   BatchMode=yes                   ：パスワードなどの入力を求めず、入力が必要なら即失敗する
     *                                     （入力待ちのまま、テストが止まってしまうのを防ぐ）
     *   StrictHostKeyChecking=accept-new：初めて接続するEC2なら、確認を求めずに信頼済みとして登録する
     */
    tunnelProcess = spawn(
      'ssh',
      [
        '-i', EC2_KEY_PATH,
        '-N',
        '-L', `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`,
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        `${EC2_USER}@${EC2_HOST}`
      ],
      {
        /*
         * sshの入出力の扱い。順に「入力」「通常の出力」「エラー出力」。
         * 入力と通常の出力は使わない（ignore）。エラー出力だけ受け取る（pipe）。
         */
        stdio: ['ignore', 'ignore', 'pipe'],
        /* Windowsで、黒いコンソール画面が開かないようにする */
        windowsHide: true
      }
    );

    /* sshがエラーメッセージを出したら、sshErrorOutputに追加していく */
    tunnelProcess.stderr?.on('data', data => {
      sshErrorOutput += data.toString();
    });

    /* トンネルが使えるようになるまで、最大20秒（20000ミリ秒）待つ */
    const opened = await waitForPort(LOCAL_PORT, 20000);

    if (!opened) {
      /* トンネルが開かなかった場合は、起動したsshを止めてからエラーにする */
      tunnelProcess.kill();
      tunnelProcess = null;

      throw new Error(
        [
          'SSHトンネルを開始できませんでした。',
          `接続先: ${EC2_USER}@${EC2_HOST}`,
          'EC2のIPアドレス、秘密鍵の場所、',
          'セキュリティグループで22番ポートが許可されているかを確認してください。',
          `SSHエラー: ${sshErrorOutput || '(出力なし)'}`
        ].join(' ')
      );
    }
  }

  /*
   * トンネルが開いていても、EC2上のアプリが止まっていれば画面は開けない。
   * そこで、テスト本体に進む前に、実際にURLへアクセスしてアプリが応答するかを確認する。
   *
   * fetch：指定したURLにアクセスし、応答を受け取る。
   * AbortSignal.timeout(10000)：10秒たっても応答がなければ、アクセスを打ち切る。
   * （打ち切らないと、アプリが応答しないままテストがずっと止まってしまう）
   *
   * try { ... } catch { ... }：tryの中でエラーが起きたら、catchの中の処理を実行する書き方。
   */
  try {
    const response = await fetch(`${APP_URL}/`, {
      signal: AbortSignal.timeout(10000)
    });

    /* 応答はあったが、エラー（HTTPステータスが400番台や500番台）だった場合 */
    if (!response.ok) {
      throw new Error(`HTTP status=${response.status}`);
    }
  } catch (error) {
    throw new Error(
      [
        'SSHトンネルはありますが、EC2のWebアプリが応答しません。',
        'EC2上で「curl -v http://127.0.0.1:8000/」と',
        '「sudo ss -ltnp | grep :8000」を実行し、アプリが起動しているか確認してください。',
        `詳細: ${String(error)}`
      ].join(' ')
    );
  }
});

/**
 * test.afterAll：テストがすべて終わった後に1回だけ実行される処理（Playwrightの機能）。
 * テストが成功しても失敗しても実行される。
 *
 * このテストが自分で起動したsshだけを止めて、トンネルを閉じる。
 * 手動で開いたトンネルを使った場合は、tunnelProcessがnullなので何もしない。
 */
test.afterAll(async () => {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    console.log('SSHトンネルを終了しました。');
  }
});

/* =========================================================
 * 判定に使う関数
 * ========================================================= */

/**
 * ログの各行から「メモリ使用率: 数値」を探し、数値の部分を取り出す関数。
 *   例：ログの行「... メモリ使用率: 65 ...」 → 65 を取り出す
 *
 * 1回の処理の中でメモリ使用率が何度か書き込まれる場合があるため、
 * 見つかった数値をすべて配列（[65, 65] のような一覧）にして返す。
 * 1つも見つからなければ、空の配列 [] を返す。
 */
function extractMemoryUsagesFromLogs(
  logLines: string[]
): number[] {
  /* 見つかった数値を入れていく配列 */
  const memoryUsages: number[] = [];

  /* ログを1行ずつ確認する */
  for (const line of logLines) {
    /*
     * 正規表現（文字列のパターン）で探す。
     *   メモリ使用率: ：この文字を探す
     *   \s*          ：その後ろにある空白を読み飛ばす（空白がなくてもよい）
     *   (\d+)        ：続く数字の部分を取り出す
     * 見つかれば、match[1]に取り出した数字（文字列）が入る。見つからなければnull。
     */
    const match = line.match(/メモリ使用率:\s*(\d+)/);

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
  logLines: string[],
  expectedMessage: string
): boolean {
  return logLines.some(line =>
    line.includes(expectedMessage)
  );
}

/**
 * 日時の文字列を、大小を比べられる数値（ミリ秒）に変換する関数。
 *
 * 日時は文字列のままだと「何秒離れているか」を計算できない。
 * そこで、「1970年1月1日0時（UTC）から何ミリ秒たったか」という数値に変換する。
 * 数値にすれば、引き算で時刻の差を求められる。
 *
 * APIとDBでは日時の書き方が違うため、先に同じ書き方にそろえてから変換する。
 *   API：2026/10/01 09:45:40（スラッシュ区切り）
 *   DB ：2026-10-01 09:45:40（ハイフン区切り）
 *     ↓ どちらも次の書き方にそろえる
 *   2026-10-01T09:45:40Z
 *
 * 末尾の「Z」は、UTC（世界標準時）の時刻であることを表す。
 * APIとDBの日時には「どの国の時刻か」という情報が付いていないが、
 * 実際の値はUTCで記録されているため、UTCとして扱う。
 * Zを付けずに変換すると、PCの設定に従って日本時間として扱われ、9時間ずれてしまう。
 * 「+09:00」のように時差の情報が付いている場合は、その情報をそのまま使う。
 *
 * 変換できなかった場合は、元の値と変換後の値を表示してエラーにする。
 */
function parseDateTime(
  value: unknown,
  fieldName: string
): number {
  /* 値がすでに日時型（Date）なら、書き方をそろえる必要はないので、そのまま数値に変換する */
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }

  /* 値が空の場合はエラーにする */
  if (value === null || value === undefined) {
    throw new Error(`${fieldName}がnullまたはundefinedです。`);
  }

  /* 文字列に変換し、前後の空白を取り除く */
  const originalValue = String(value).trim();

  /* 書き方を3段階でそろえる */
  let normalizedValue = originalValue
    /*
     * 1. スラッシュをハイフンに変える。月や日が1桁なら、先頭に0を付けて2桁にする。
     *    例：2026/10/1 → 2026-10-01
     */
    .replace(
      /^(\d{4})\/(\d{1,2})\/(\d{1,2})/,
      (_matched, year: string, month: string, day: string) =>
        `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    )
    /*
     * 2. 日付と時刻の間の空白を「T」に変える（日時の国際標準の書き方）。
     *    例：2026-10-01 09:45:40 → 2026-10-01T09:45:40
     */
    .replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T')
    /*
     * 3. 時差の情報が「+0900」の書き方なら、「+09:00」に変える。
     */
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  /* 末尾に時差の情報（Zや+09:00）がなければ、UTCを表す「Z」を付ける */
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalizedValue)) {
    normalizedValue += 'Z';
  }

  /* そろえた文字列をミリ秒の数値に変換する。変換できなければNaN（数値ではない）になる */
  const milliseconds = Date.parse(normalizedValue);

  if (Number.isNaN(milliseconds)) {
    throw new Error(
      `${fieldName}を日時として解析できません。元の値: ${originalValue} 変換後: ${normalizedValue}`
    );
  }

  return milliseconds;
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
  'TC002_EC2 正常収集：API・DB・application.logの突合',
  async ({ page }, testInfo) => {
    /*
     * このテストの制限時間を120秒にする。
     * Playwrightの標準は30秒だが、DBへの登録やログの書き込みを待つ時間があるため長めにしている。
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
    const dbRecordBefore = getLatestDbRecordViaSsh();

    /* 最新レコードを取得できなかった場合は、比較ができないのでエラーにする */
    if (!dbRecordBefore) {
      throw new Error(
        'memory_usage_logテーブルの最新レコードを取得できませんでした。'
      );
    }

    console.log('ボタン操作前の最新DBレコード:', dbRecordBefore);

    /* -------------------------------------------------------
     * 手順2：アプリの画面を開く
     * -------------------------------------------------------
     * page.goto：ブラウザーで指定したURLを開く（Playwrightの機能）。
     * ページの読み込みが終わるまで待ってから、次の行へ進む。
     */
    await page.goto(APP_URL);

    /* -------------------------------------------------------
     * 手順3：「正常収集」ボタンを押し、APIの応答を受け取る
     * -------------------------------------------------------
     * ボタンを押すと、画面の裏側で /api/collect/normal というAPIが呼ばれ、
     * サーバーがメモリ使用率の収集やDB登録を行って、結果を返してくる。
     * その返ってきた結果（応答）を受け取って、中身を確認する。
     *
     * page.waitForResponse：条件に合う通信の応答が届くまで待つ（Playwrightの機能）。
     * ここでの条件は「POSTという種類の通信」かつ「URLに /api/collect/normal を含む」。
     *
     * 注意：ボタンを押した後に待ち始めると、応答がすでに届いていて取りこぼすことがある。
     * そのため、ボタンを押す「前」に待ち始めておき（ここではawaitを付けない）、
     * ボタンを押した後で結果を受け取る。
     */
    const apiResponsePromise = page.waitForResponse(response =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/collect/normal')
    );

    /* ボタンを押した時刻を記録する（後で、DBの収集日時と比べるため） */
    const operationStartTime = Date.now();

    /*
     * page.getByRole：画面の部品を「種類」と「表示されている名前」で探す（Playwrightの機能）。
     * ここでは「正常収集」と書かれたボタンを探し、click()でクリックする。
     */
    await page.getByRole('button', { name: '正常収集' }).click();

    /* 先に待ち始めておいたAPIの応答を、ここで受け取る */
    const apiResponse = await apiResponsePromise;

    /* APIの応答を受け取った時刻を記録する */
    const apiResponseReceivedTime = Date.now();

    /*
     * APIがエラーを返していないかを確認する。
     * apiResponse.ok()は、HTTPステータスが200番台（成功）ならtrueになる。
     * 400番台や500番台（エラー）ならfalseになり、ここでテストは失敗する。
     */
    expect(
      apiResponse.ok(),
      `正常収集APIがHTTPエラーを返しました。status=${apiResponse.status()}`
    ).toBeTruthy();

    /*
     * 応答の中身（JSON）を取り出す。
     * 「as CollectNormalResponse」は、上で定義した形のデータとして扱うという指定。
     */
    const responseBody =
      await apiResponse.json() as CollectNormalResponse;

    console.log('APIの応答:', responseBody);

    /*
     * execution_idは、1回の処理ごとに割り当てられるID。
     * application.logの各行にもこのIDが書かれているので、
     * このIDを手がかりに、今回の処理のログだけを探し出せる。
     *
     * 「?.」は、execution_idがない場合にエラーにならず、undefined（値なし）にする書き方。
     * trim()で前後の空白を取り除いている。
     */
    const executionId = responseBody.execution_id?.trim();

    /* execution_idがなければ、ログを探せないのでエラーにする */
    if (!executionId) {
      throw new Error(
        `APIの応答にexecution_idがありません。応答: ${JSON.stringify(responseBody)}`
      );
    }

    /*
     * メモリ使用率と収集日時は、後でDBの値と比べるために必要。
     * どちらかが応答に含まれていなければ、比較できないのでエラーにする。
     * （含まれていないのに合格にしてしまうと、APIの不具合に気づけないため）
     */
    if (typeof responseBody.memory_usage !== 'number') {
      throw new Error(
        `APIの応答にmemory_usage（数値）がありません。応答: ${JSON.stringify(responseBody)}`
      );
    }

    if (!responseBody.collect_datetime) {
      throw new Error(
        `APIの応答にcollect_datetimeがありません。応答: ${JSON.stringify(responseBody)}`
      );
    }

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
      `TC002_EC2_NormalCollect_Success_${evidenceId}.png`
    );

    await page.screenshot({ path: screenshotPath, fullPage: true });

    /* -------------------------------------------------------
     * 手順5：DBに新しいレコードが登録されたことを確認する
     * -------------------------------------------------------
     * 手順1で記録したidより新しいレコードが登録されるまで待ち、登録されたレコードを受け取る。
     */
    const dbRecordAfter =
      await waitForNewDbRecordViaSsh(dbRecordBefore.id);

    console.log('ボタン操作後に登録されたDBレコード:', dbRecordAfter);

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
     * 手順6：今回の処理のログを、application.logから取り出す
     * -------------------------------------------------------
     * 手順3で受け取ったexecution_idを手がかりに、今回の処理で書き込まれたログを探す。
     * ログの書き込みは処理より少し遅れることがあるため、
     * 必要なメッセージ（EXPECTED_LOG_MESSAGES）がそろうまで最大60秒待つ。
     */
    const applicationLogs = await waitForApplicationLog(
      executionId,
      EXPECTED_LOG_MESSAGES,
      60000
    );

    console.log('今回の処理のapplication.log:', applicationLogs);

    /* 取り出したログから、メモリ使用率の数値を取り出す（例：[50]） */
    const loggedMemoryUsages =
      extractMemoryUsagesFromLogs(applicationLogs);

    /* -------------------------------------------------------
     * 手順7：APIとDBの収集日時を、比べられる数値に変換する
     * ------------------------------------------------------- */
    const dbCollectTime = parseDateTime(
      dbRecordAfter.collect_datetime,
      'DBのcollect_datetime'
    );

    const apiCollectTime = parseDateTime(
      responseBody.collect_datetime,
      'APIのcollect_datetime'
    );

    /*
     * APIとDBの収集日時が、何ミリ秒離れているかを計算する。
     * Math.absは、引き算の結果がマイナスでもプラスにする（どちらが先でも差だけを見るため）。
     */
    const apiDbTimeDifference =
      Math.abs(dbCollectTime - apiCollectTime);

    /* -------------------------------------------------------
     * 手順8：API・DB・ログの内容が一致しているかを判定する
     * -------------------------------------------------------
     * 確認したい項目を1つずつtrue（合格）かfalse（不合格）で判定し、checksにまとめる。
     * すべてtrueならテストは合格。
     * 判定結果は、後で証跡ファイル（JSON）にもそのまま記録する。
     */
    const checks = {
      /*
       * DBの収集日時が、ボタン操作の時刻付近であること。
       * 「ボタンを押した時刻の30秒前」から「APIの応答を受け取った時刻の30秒後」までの間に
       * 入っていれば、今回のボタン操作で登録されたデータと判断する。
       * 範囲から外れていれば、別の処理（自動収集など）で登録されたデータの可能性がある。
       */
      isNearOperationTime:
        dbCollectTime >= operationStartTime - CLOCK_TOLERANCE_MS &&
        dbCollectTime <= apiResponseReceivedTime + CLOCK_TOLERANCE_MS,

      /* APIの収集日時とDBの収集日時の差が、15秒以内であること */
      apiDbTimeMatches:
        apiDbTimeDifference <= DB_API_TIME_TOLERANCE_MS,

      /* 取り出したログに、今回のexecution_idが含まれていること */
      sameExecutionId:
        hasMessage(applicationLogs, executionId),

      /* ログに「実行方式: 手動実行」があること（ボタン操作で実行された） */
      isManualExecution:
        hasMessage(applicationLogs, '実行方式: 手動実行'),

      /* ログに「DB登録結果: 成功」があること（DB登録に成功した） */
      hasDbSuccess:
        hasMessage(applicationLogs, 'DB登録結果: 成功'),

      /* ログに「INFO OK」があること（メモリ使用率の判定が正常だった） */
      hasInfoOk:
        hasMessage(applicationLogs, 'INFO OK'),

      /* ログに「処理終了」があること（処理が最後まで実行された） */
      hasProcessEnd:
        hasMessage(applicationLogs, '処理終了'),

      /* ログからメモリ使用率を1つ以上取り出せたこと（取り出せないと次の比較ができない） */
      hasLoggedMemoryUsage:
        loggedMemoryUsages.length > 0,

      /*
       * ログに書かれたメモリ使用率が、すべてDBの値と同じであること。
       * every：配列のすべての値が条件に合えばtrueを返す。
       * ログとDBが同じ1回の処理の記録かを判断する、いちばん重要な確認。
       */
      logMemoryMatchesDb:
        loggedMemoryUsages.length > 0 &&
        loggedMemoryUsages.every(value => value === dbRecordAfter.memory_usage),

      /* APIが返したメモリ使用率が、DBの値と同じであること */
      apiMemoryMatchesDb:
        responseBody.memory_usage === dbRecordAfter.memory_usage
    };

    console.log('判定結果:', checks);

    /*
     * 判定結果を1項目ずつ確認する。
     * toBeTruthy：値がtrueであることを確認する。
     * falseの項目があれば、そこでテストは失敗し、2つ目に書いたメッセージが表示される。
     * どの項目で失敗したかがメッセージで分かるよう、1項目ずつ分けて確認している。
     */
    expect(checks.isNearOperationTime,
      'DBの収集日時が、ボタンを押した時刻付近ではありません。別の処理で登録されたデータの可能性があります。').toBeTruthy();
    expect(checks.apiDbTimeMatches,
      `APIとDBの収集日時の差が${DB_API_TIME_TOLERANCE_MS / 1000}秒を超えています。差=${apiDbTimeDifference}ミリ秒`).toBeTruthy();
    expect(checks.sameExecutionId,
      `application.logにexecution_id「${executionId}」がありません。`).toBeTruthy();
    expect(checks.isManualExecution,
      'application.logに「実行方式: 手動実行」がありません。').toBeTruthy();
    expect(checks.hasDbSuccess,
      'application.logに「DB登録結果: 成功」がありません。').toBeTruthy();
    expect(checks.hasInfoOk,
      'application.logに「INFO OK」がありません。').toBeTruthy();
    expect(checks.hasProcessEnd,
      'application.logに「処理終了」がありません。').toBeTruthy();
    expect(checks.hasLoggedMemoryUsage,
      'application.logからメモリ使用率を取り出せませんでした。').toBeTruthy();
    expect(checks.logMemoryMatchesDb,
      `ログとDBのメモリ使用率が一致しません。ログ=${loggedMemoryUsages} DB=${dbRecordAfter.memory_usage}`).toBeTruthy();
    expect(checks.apiMemoryMatchesDb,
      `APIとDBのメモリ使用率が一致しません。API=${responseBody.memory_usage} DB=${dbRecordAfter.memory_usage}`).toBeTruthy();

    /* -------------------------------------------------------
     * 手順9：テスト結果を証跡ファイル（JSON）に保存する
     * -------------------------------------------------------
     * ここまで来たということは、すべての確認に合格したということ。
     * 後から「いつ・何を・どのように確認して・どうだったか」を確認できるよう、
     * 確認に使った値と判定結果をすべてまとめて、ファイルに保存する。
     */
    const evidence = {
      testCase: 'TC002_EC2 正常収集：API・DB・application.logの突合',
      result: 'PASS',
      /* toISOString()：日時を「2026-10-02T04:56:08.000Z」のような国際標準の文字列にする */
      executedAt: new Date().toISOString(),
      applicationUrl: APP_URL,
      operationStartTime: new Date(operationStartTime).toISOString(),
      apiResponseReceivedTime: new Date(apiResponseReceivedTime).toISOString(),
      executionId,

      /* APIが返した内容（そのまま記録する） */
      apiResponse: responseBody,

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

      /* ログの確認結果（取り出したログの行も記録する） */
      applicationLog: {
        path: APPLICATION_LOG_PATH,
        executionId,
        expectedMessages: EXPECTED_LOG_MESSAGES,
        lines: applicationLogs
      },

      /* API・DB・ログを突き合わせた結果 */
      correlation: {
        /* どのような方法で突き合わせたか */
        method: [
          'APIの応答に含まれるexecution_idで、今回の処理のログを特定',
          'API・DB・ログのメモリ使用率が同じかを比較',
          'APIとDBの収集日時の差と、ボタン操作の時刻との差を比較'
        ],
        dbMemoryUsage: dbRecordAfter.memory_usage,
        apiMemoryUsage: responseBody.memory_usage,
        logMemoryUsages: loggedMemoryUsages,
        /* 収集日時は、元の値とUTCに変換した値の両方を記録する */
        collectDatetime: {
          apiOriginal: responseBody.collect_datetime,
          apiUtc: new Date(apiCollectTime).toISOString(),
          databaseOriginal: dbRecordAfter.collect_datetime,
          databaseUtc: new Date(dbCollectTime).toISOString(),
          differenceMilliseconds: apiDbTimeDifference,
          toleranceMilliseconds: DB_API_TIME_TOLERANCE_MS
        },
        /* 手順8の判定結果 */
        checks,
        /* すべての判定がtrueならtrue */
        verified: Object.values(checks).every(Boolean)
      }
    };

    const jsonEvidencePath = path.join(
      evidenceDirectory,
      `TC002_EC2_NormalCollect_Result_${evidenceId}.json`
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
    await testInfo.attach('TC002_EC2 正常収集の完了画面', {
      path: screenshotPath,
      contentType: 'image/png'
    });

    await testInfo.attach('TC002_EC2 API・DB・application.logの突合結果', {
      path: jsonEvidencePath,
      contentType: 'application/json'
    });
  }
);