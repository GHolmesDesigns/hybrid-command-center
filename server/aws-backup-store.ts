import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BackupNotifier, BackupObjectStore, StoredBackup } from './backup-operations.ts';

const execute = promisify(execFile);

async function aws(args: string[]) {
  const { stdout } = await execute('aws', args, { windowsHide: true, maxBuffer: 1024 * 1024 });
  return stdout;
}

export class AwsCliBackupStore implements BackupObjectStore {
  private readonly bucket: string;
  constructor(bucket: string) {
    this.bucket = bucket;
  }

  async put(options: {
    key: string;
    filePath: string;
    contentLength: number;
    checksumSha256: string;
  }) {
    await aws([
      's3api',
      'put-object',
      '--bucket',
      this.bucket,
      '--key',
      options.key,
      '--body',
      options.filePath,
      '--server-side-encryption',
      'AES256',
      '--checksum-algorithm',
      'SHA256',
      '--metadata',
      `sha256=${options.checksumSha256}`,
      '--no-cli-pager',
    ]);
  }

  async list(prefix: string): Promise<StoredBackup[]> {
    const output = await aws([
      's3api',
      'list-objects-v2',
      '--bucket',
      this.bucket,
      '--prefix',
      prefix,
      '--output',
      'json',
      '--no-cli-pager',
    ]);
    const parsed = JSON.parse(output) as {
      Contents?: { Key: string; Size: number; LastModified: string }[];
    };
    return (parsed.Contents ?? []).map((object) => ({
      key: object.Key,
      size: object.Size,
      lastModified: object.LastModified,
    }));
  }

  async remove(key: string) {
    await aws(['s3api', 'delete-object', '--bucket', this.bucket, '--key', key, '--no-cli-pager']);
  }

  async download(key: string, destinationPath: string) {
    await aws([
      's3api',
      'get-object',
      '--bucket',
      this.bucket,
      '--key',
      key,
      destinationPath,
      '--checksum-mode',
      'ENABLED',
      '--no-cli-pager',
    ]);
    fs.chmodSync(destinationPath, 0o600);
  }
}

export class AwsSnsNotifier implements BackupNotifier {
  private readonly topicArn: string;
  constructor(topicArn: string) {
    this.topicArn = topicArn;
  }
  async notify(message: string) {
    await aws([
      'sns',
      'publish',
      '--topic-arn',
      this.topicArn,
      '--subject',
      'Hybrid Command Center backup alert',
      '--message',
      message,
      '--no-cli-pager',
    ]);
  }
}
