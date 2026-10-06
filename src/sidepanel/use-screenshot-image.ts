import { useEffect, useState } from "react";
import { readAsset, storeScreenshot } from "../shared/assets";
import { withAssetPublication } from "../shared/asset-lifecycle";
import type { LogEntry } from "./model";

type ImageSize = { readonly width: number; readonly height: number };
export type ScreenshotImage = {
  readonly src: string;
  readonly size: ImageSize | undefined;
  readonly ready: boolean;
  readonly failed: boolean;
};
type ImageResource = {
  readonly key: string;
  readonly src: string;
  readonly image: HTMLImageElement | undefined;
  readonly failed: boolean;
};

export function useScreenshotImage(
  entry: LogEntry,
  prepare: boolean,
): ScreenshotImage {
  const ref = entry.screenshot;
  const data = entry.screenshotData;
  const mime = entry.screenshotMime || "image/png";
  const key = ref?.id ?? data ?? "";
  const [requestedKey, setRequestedKey] = useState<string>();
  const [resource, setResource] = useState<ImageResource>();

  useEffect(() => {
    if (prepare && key) setRequestedKey(key);
  }, [prepare, key]);

  useEffect(() => {
    if (!key || requestedKey !== key) return;
    let active = true;
    let url: string | undefined;
    let image: HTMLImageElement | undefined;
    const load = async () => {
      const blob = await withAssetPublication(async () => {
        const screenshot = ref ?? (data ? await storeScreenshot({ data, mime }) : undefined);
        if (!screenshot || !active) return null;
        return readAsset(screenshot.id);
      });
      if (!active) return;
      if (!blob) throw new DOMException("截图文件不存在", "NotFoundError");
      url = URL.createObjectURL(blob);
      image = new Image();
      image.decoding = "async";
      image.src = url;
      await image.decode();
      if (active) setResource({ key, src: url, image, failed: false });
    };
    void load().catch((error: unknown) => {
      if (active) setResource({ key, src: "", image: undefined, failed: true });
      if (!(error instanceof Error)) throw error;
    });
    // 折叠不改变 requestedKey；仅替换引用或卸载时释放解码资源。
    return () => {
      active = false;
      if (image) image.src = "";
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, requestedKey, ref, data, mime]);

  const current = resource?.key === key ? resource : undefined;
  const image = current?.image;
  return {
    src: current?.src ?? "",
    size:
      ref?.width && ref.height
        ? { width: ref.width, height: ref.height }
        : image
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : undefined,
    ready: !!image,
    failed: current?.failed ?? false,
  };
}
