import { storeScreenshot } from "../shared/assets";
import type { LogEntry } from "./model";

export function screenshotIds(logs: readonly LogEntry[]): string[] {
  return logs.flatMap((entry) =>
    entry.screenshot ? [entry.screenshot.id] : [],
  );
}

/** 保留旧字段作为迁移输入；文件提交成功后才替换日志，失败时调用者保留原记录。 */
export async function migrateScreenshotLogs(
  logs: LogEntry[],
): Promise<LogEntry[]> {
  return Promise.all(
    logs.map(async (entry) => {
      if (entry.toolName !== "screenshot" || !entry.screenshotData)
        return entry;
      const screenshot = await storeScreenshot({
        data: entry.screenshotData,
        mime: entry.screenshotMime || "image/png",
      });
      const { screenshotData: _data, screenshotMime: _mime, ...rest } = entry;
      return {
        ...rest,
        screenshot,
        toolResult: "Screenshot captured successfully.",
      };
    }),
  );
}
