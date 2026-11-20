import { assetDataUrl } from "../shared/assets";
import { attachmentText, readAttachment } from "../shared/attachment-files";
import { AttachmentError, parseAttachments } from "../shared/attachments";
import type { ChatMessage, MessageContent } from "./types";

/** 上传附件不参与截图裁剪，只在发送时物化请求副本。 */
export async function materializeAttachments(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.content)) return message;
      const content: Exclude<MessageContent, string> = [];
      for (const part of message.content) {
        if (part.type !== "attachment") {
          content.push(part);
          continue;
        }
        const [attachment] = parseAttachments([part.attachment]);
        if (!attachment)
          throw new AttachmentError("invalid_reference", "附件引用无效");
        const blob = await readAttachment(attachment);
        switch (attachment.kind) {
          case "text":
            content.push({
              type: "text",
              text: `[附件: ${attachment.name}]\n${await attachmentText(blob, attachment.name)}`,
            });
            break;
          case "image": {
            const url = await assetDataUrl(attachment.asset);
            if (!url)
              throw new AttachmentError(
                "missing",
                `${attachment.name}：附件文件不可用`,
              );
            content.push(
              { type: "text", text: `[附件: ${attachment.name}]` },
              { type: "image_url", image_url: { url } },
            );
            break;
          }
          default: {
            const exhaustive: never = attachment.kind;
            throw new AttachmentError("unsupported_type", String(exhaustive));
          }
        }
      }
      return { ...message, content };
    }),
  );
}
