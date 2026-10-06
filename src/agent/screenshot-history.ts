import { assetDataUrl, storeScreenshot } from "../shared/assets";
import type { ChatMessage, MessageContent } from "./types";

/** 旧历史仅转换明确标记的截图消息，不处理用户附件或普通图片 URL。 */
export async function migrateScreenshotHistory(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (
        !Array.isArray(message.content) ||
        !message.content.some(
          (part) => part.type === "text" && part.text === "[screenshot result]",
        )
      )
        return message;
      const content: MessageContent = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== "image_url") return part;
          const match = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(
            part.image_url.url,
          );
          if (!match) return part;
          const screenshot = await storeScreenshot({
            data: match[2],
            mime: match[1],
          });
          return { type: "screenshot", screenshot } satisfies {
            type: "screenshot";
            screenshot: typeof screenshot;
          };
        }),
      );
      return { ...message, content };
    }),
  );
}

/** 只物化请求副本；持久化的历史始终保留文件引用。 */
export async function materializeScreenshots(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.content)) return message;
      const content: MessageContent = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== "screenshot") return part;
          const url = await assetDataUrl(part.screenshot);
          return url
            ? ({ type: "image_url", image_url: { url } } satisfies {
                type: "image_url";
                image_url: { url: string };
              })
            : ({
                type: "text",
                text: "截图文件已不可用，请重新截图。",
              } satisfies { type: "text"; text: string });
        }),
      );
      return { ...message, content };
    }),
  );
}
