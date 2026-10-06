import { execFileSync } from 'child_process';

export type DbRecord = {
  id: number;
  collect_datetime: string;
  memory_usage: number;
  created_at: string;
};

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `${name}が設定されていません。.envファイルを確認してください。`
    );
  }

  return value;
}

function executeSshCommand(remoteCommand: string): string {
  const host = getRequiredEnvironmentVariable('EC2_HOST');
  const user = process.env.EC2_USER ?? 'ec2-user';
  const keyPath = getRequiredEnvironmentVariable('SSH_KEY_PATH');

  try {
    return execFileSync(
      'ssh.exe',
      [
        '-i',
        keyPath,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        `${user}@${host}`,
        remoteCommand
      ],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    ).trim();
  } catch (error) {
    const details =
      error instanceof Error ? error.message : String(error);

    throw new Error(
      `EC2上のコマンド実行に失敗しました。\n${details}`
    );
  }
}

export function getLatestDbRecordViaSsh(): DbRecord | null {
  const sql = [
    'SELECT id,',
    "to_char(collect_datetime, 'YYYY-MM-DD HH24:MI:SS'),",
    'memory_usage,',
    "to_char(created_at, 'YYYY-MM-DD HH24:MI:SS')",
    'FROM memory_usage_log',
    'ORDER BY id DESC',
    'LIMIT 1;'
  ].join(' ');

  const remoteCommand = [
    'sudo -u postgres',
    'psql',
    '-d memory_monitor',
    '-t',
    '-A',
    '-F "|"',
    `-c "${sql}"`
  ].join(' ');

  const output = executeSshCommand(remoteCommand);

  if (!output) {
    return null;
  }

  const [
    id,
    collectDatetime,
    memoryUsage,
    createdAt
  ] = output.split('|');

  if (!id || !collectDatetime || !memoryUsage || !createdAt) {
    throw new Error(
      `DB取得結果を解析できませんでした。取得結果: ${output}`
    );
  }

  return {
    id: Number(id),
    collect_datetime: collectDatetime,
    memory_usage: Number(memoryUsage),
    created_at: createdAt
  };
}

export async function waitForNewDbRecordViaSsh(
  beforeId: number,
  timeoutMilliseconds = 30000
): Promise<DbRecord> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    const latestRecord = getLatestDbRecordViaSsh();

    if (latestRecord && latestRecord.id > beforeId) {
      return latestRecord;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(
    `DBに新規レコードが登録されませんでした。処理前ID: ${beforeId}`
  );
}

export function getApplicationLogByExecutionId(
  executionId: string
): string[] {
  if (!/^[0-9a-fA-F-]{36}$/.test(executionId)) {
    throw new Error(
      `execution_idの形式が不正です: ${executionId}`
    );
  }

  const output = executeSshCommand(
    `sudo grep -F "${executionId}" /var/log/memory-monitor/app.log`
  );

  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

export async function waitForApplicationLog(
  executionId: string,
  expectedMessages: string[],
  timeoutMilliseconds = 30000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    try {
      const lines = getApplicationLogByExecutionId(executionId);

      const allMessagesExist = expectedMessages.every(
        expectedMessage =>
          lines.some(line => line.includes(expectedMessage))
      );

      if (allMessagesExist) {
        return lines;
      }
    } catch {
      // ログ出力前はgrepが終了コード1になるため、再試行する
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error(
    [
      `execution_id=${executionId}のログ確認がタイムアウトしました。`,
      `期待するログ: ${expectedMessages.join(', ')}`
    ].join(' ')
  );
}