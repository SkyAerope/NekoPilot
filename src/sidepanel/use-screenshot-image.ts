import { useEffect, useMemo, useState } from "react";
import type { LogEntry } from "./model";

type ImageSize = { readonly width: number; readonly height: number };

export type ScreenshotImage = {
  readonly src: string;
  readonly size: ImageSize | undefined;
  readonly ready: boolean;
  readonly failed: boolean;
};

type ImageResource = {
  readonly src: string;
  readonly image: HTMLImageElement | undefined;
  readonly failed: boolean;
};

function readPngSize(data: string): ImageSize | undefined {
  // 只解码文件头，避免展开时遍历整张截图。
  const prefix = data.slice(0, 32);
  if (!/^[A-Za-z0-9+/]{32}$/.test(prefix)) return undefined;
  const header = atob(prefix);
  if (
    header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
    header.slice(12, 16) !== "IHDR"
  )
    return undefined;
  const bytes = Uint8Array.from(header, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function useScreenshotImage(
  entry: LogEntry,
  prepare: boolean,
): ScreenshotImage {
  const data = entry.screenshotData ?? "";
  const mime = entry.screenshotMime || "image/png";
  const src = useMemo(() => `data:${mime};base64,${data}`, [data, mime]);
  const headerSize = useMemo(() => readPngSize(data), [data]);
  const [resource, setResource] = useState<ImageResource>();

  useEffect(() => {
    if (!prepare || !data || resource?.src === src) return;
    let active = true;
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    void image.decode().then(
      () => {
        if (active) setResource({ src, image, failed: false });
      },
      (error: unknown) => {
        if (!active) return;
        if (!(error instanceof DOMException)) throw error;
        setResource({ src, image: undefined, failed: true });
      },
    );
    // 不在折叠时销毁已解码图片；只让过期的异步结果失效。
    return () => {
      active = false;
    };
  }, [data, src, prepare, resource]);

  const current = resource?.src === src ? resource : undefined;
  const decoded = current?.image;
  return {
    src,
    size:
      headerSize ??
      (decoded
        ? { width: decoded.naturalWidth, height: decoded.naturalHeight }
        : undefined),
    ready: !!decoded,
    failed: current?.failed ?? false,
  };
}
