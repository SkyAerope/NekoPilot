import { AssetStorageError, readAsset, storeAsset } from "./assets";
import { AssetPins, withAssetPublication } from "./asset-lifecycle";
import {
  AttachmentError,
  attachmentFormat,
  parseAttachments,
  validateAttachmentFiles,
} from "./attachments";
import type { ChatAttachment } from "./attachments";

export async function attachmentText(
  blob: Blob,
  name: string,
): Promise<string> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await blob.arrayBuffer(),
    );
    if (text.includes("\0"))
      throw new AttachmentError("nul_text", `${name}：不是有效的 UTF-8 文本`);
    if (!text.length)
      throw new AttachmentError("empty_file", `${name}：附件为空`);
    return text;
  } catch (error: unknown) {
    if (error instanceof TypeError)
      throw new AttachmentError(
        "invalid_utf8",
        `${name}：只支持 UTF-8 编码文本`,
      );
    throw error;
  }
}

async function validateContent(blob: Blob, name: string): Promise<void> {
  const format = attachmentFormat(name);
  switch (format.kind) {
    case "text":
      await attachmentText(blob, name);
      return;
    case "image": {
      const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      const signature =
        format.mime === "image/png"
          ? bytes[0] === 137 &&
            bytes[1] === 80 &&
            bytes[2] === 78 &&
            bytes[3] === 71
          : format.mime === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
              String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
      if (!signature)
        throw new AttachmentError(
          "mime_mismatch",
          `${name}：图片格式与文件内容不匹配`,
        );
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch (error: unknown) {
        if (error instanceof DOMException)
          throw new AttachmentError(
            "invalid_image",
            `${name}：图片损坏或无法解码`,
          );
        throw error;
      }
      try {
        if (bitmap.width > 8000 || bitmap.height > 8000)
          throw new AttachmentError(
            "image_dimensions",
            `${name}：图片尺寸不得超过 8000×8000`,
          );
      } finally {
        bitmap.close();
      }
      return;
    }
    default: {
      const exhaustive: never = format.kind;
      throw new AttachmentError("unsupported_type", String(exhaustive));
    }
  }
}

export async function validateAttachmentDraft(
  files: readonly File[],
): Promise<void> {
  validateAttachmentFiles(files);
  for (const file of files)
    await validateContent(
      new Blob([file], { type: attachmentFormat(file.name).mime }),
      file.name,
    );
}

/** 独立 pin 所有权覆盖发布后的窗口，调用方交接引用后释放。 */
export async function prepareAttachments(
  files: readonly File[],
): Promise<{
  readonly attachments: ChatAttachment[];
  readonly release: () => Promise<void>;
}> {
  await validateAttachmentDraft(files);
  const pins = new AssetPins();
  try {
    return await withAssetPublication(async () => {
      const attachments: ChatAttachment[] = [];
      for (const file of files) {
        const format = attachmentFormat(file.name);
        const blob = new Blob([file], { type: format.mime });
        const asset = await storeAsset(blob);
        attachments.push({ kind: format.kind, name: file.name, asset });
        await pins.retain([asset.id]);
      }
      return { attachments, release: () => pins.clear() };
    });
  } catch (error: unknown) {
    await pins.clear();
    if (error instanceof AssetStorageError)
      throw new AttachmentError("storage_failed", error.message);
    throw error;
  }
}

export async function readAttachment(
  attachment: ChatAttachment,
): Promise<Blob> {
  const blob = await readAsset(attachment.asset.id);
  if (!blob)
    throw new AttachmentError(
      "missing",
      `${attachment.name}：附件文件已不可用，请重新添加或新建对话`,
    );
  if (
    blob.size !== attachment.asset.size ||
    blob.type !== attachment.asset.mime
  )
    throw new AttachmentError(
      "invalid_reference",
      `${attachment.name}：附件引用与文件不匹配`,
    );
  await validateContent(blob, attachment.name);
  return blob;
}

export async function validateStoredAttachments(
  value: unknown,
): Promise<ChatAttachment[]> {
  const attachments = parseAttachments(value);
  await Promise.all(attachments.map(readAttachment));
  return attachments;
}
