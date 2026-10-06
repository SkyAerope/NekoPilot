import type { AssetRef } from "./assets";

export type ChatAttachment = {
  readonly kind: "image" | "text";
  readonly name: string;
  readonly asset: AssetRef;
};

export const attachmentAccept = ".png,.jpg,.jpeg,.webp,.txt,.md,.json,.csv";
export const attachmentLimits = {
  count: 4,
  image: 4 * 1024 * 1024,
  text: 128 * 1024,
  total: 8 * 1024 * 1024,
} as const;
const formats: Readonly<
  Record<
    string,
    { readonly kind: ChatAttachment["kind"]; readonly mime: string }
  >
> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  webp: { kind: "image", mime: "image/webp" },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "text", mime: "text/markdown" },
  json: { kind: "text", mime: "application/json" },
  csv: { kind: "text", mime: "text/csv" },
};

export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "unsupported_type"
      | "too_many_files"
      | "file_too_large"
      | "total_too_large"
      | "empty_file"
      | "invalid_utf8"
      | "nul_text"
      | "mime_mismatch"
      | "invalid_image"
      | "image_dimensions"
      | "invalid_reference"
      | "storage_failed"
      | "missing"
      | "request_too_large",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export function attachmentFormat(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const format = Object.hasOwn(formats, extension)
    ? formats[extension]
    : undefined;
  if (!format)
    throw new AttachmentError(
      "unsupported_type",
      `${name}：不支持此格式，请选择 PNG/JPEG/WebP 或 TXT/MD/JSON/CSV`,
    );
  return format;
}

export function validateAttachmentFiles(
  files: readonly { readonly name: string; readonly size: number }[],
): void {
  if (files.length > attachmentLimits.count)
    throw new AttachmentError("too_many_files", "每条消息最多添加 4 个附件");
  let total = 0;
  for (const file of files) {
    const format = attachmentFormat(file.name);
    if (!Number.isSafeInteger(file.size) || file.size <= 0)
      throw new AttachmentError(
        "empty_file",
        `${file.name}：附件为空或大小无效`,
      );
    if (file.size > attachmentLimits[format.kind])
      throw new AttachmentError(
        "file_too_large",
        `${file.name}：图片不得超过 4 MiB，文本不得超过 128 KiB`,
      );
    total += file.size;
  }
  if (total > attachmentLimits.total)
    throw new AttachmentError(
      "total_too_large",
      "每条消息的附件合计不得超过 8 MiB",
    );
}

export function isChatAttachment(value: unknown): value is ChatAttachment {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    !("name" in value) ||
    !("asset" in value)
  )
    return false;
  if (
    (value.kind !== "image" && value.kind !== "text") ||
    typeof value.name !== "string"
  )
    return false;
  const asset = value.asset;
  if (
    typeof asset !== "object" ||
    asset === null ||
    !("id" in asset) ||
    !("mime" in asset) ||
    !("size" in asset)
  )
    return false;
  if (
    typeof asset.id !== "string" ||
    typeof asset.mime !== "string" ||
    typeof asset.size !== "number"
  )
    return false;
  try {
    const format = attachmentFormat(value.name);
    validateAttachmentFiles([{ name: value.name, size: asset.size }]);
    return (
      format.kind === value.kind &&
      format.mime === asset.mime &&
      asset.id.startsWith(`${asset.mime}:`) &&
      /^[a-f0-9]{64}$/.test(asset.id.slice(asset.mime.length + 1))
    );
  } catch (error: unknown) {
    if (error instanceof AttachmentError) return false;
    throw error;
  }
}

export function parseAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isChatAttachment))
    throw new AttachmentError(
      "invalid_reference",
      "附件引用无效，请重新添加附件",
    );
  validateAttachmentFiles(
    value.map((attachment) => ({
      name: attachment.name,
      size: attachment.asset.size,
    })),
  );
  return value.map((attachment) => ({
    kind: attachment.kind,
    name: attachment.name,
    asset: {
      id: attachment.asset.id,
      mime: attachment.asset.mime,
      size: attachment.asset.size,
    },
  }));
}
