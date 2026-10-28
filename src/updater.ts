import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface AvailableUpdate {
  version: string;
  update: Update;
}

/** 检查 GitHub Releases 上的 latest.json；只有用户主动触发时才会联网。 */
export async function findUpdate(): Promise<AvailableUpdate | null> {
  // 连不上时不要让按钮一直转：20 秒后给出明确失败。
  const update = await check({ timeout: 20_000 });
  return update ? { version: update.version, update } : null;
}

/** 下载并安装更新，完成后重启应用。 */
export async function installUpdate(
  update: Update,
  onProgress: (percent: number | null) => void,
): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;

  await update.downloadAndInstall(
    (event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? null;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        onProgress(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
      }
    },
    { timeout: 300_000 },
  );

  await relaunch();
}
