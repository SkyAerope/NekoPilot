import type { LogEntry } from "./model";
import { screenshotIds } from "./screenshot-storage";
import { parseAttachments } from "../shared/attachments";

export function logAssetIds(logs: LogEntry[]): string[] {
  return [
    ...screenshotIds(logs),
    ...logs.flatMap((entry) =>
      parseAttachments(entry.attachments).map(
        (attachment) => attachment.asset.id,
      ),
    ),
  ];
}
