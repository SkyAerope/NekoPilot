import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LogEntry } from "./model";
import type { ScreenshotImage } from "./use-screenshot-image";

export function ScreenshotPreview({
  entry,
  image,
}: {
  readonly entry: LogEntry;
  readonly image: ScreenshotImage;
}) {
  const reducedMotion = useReducedMotion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [measurement, setMeasurement] = useState<{
    readonly height: number;
    readonly animate: boolean;
  }>();
  const data = entry.screenshotData ?? "";
  const { src, size, ready, failed } = image;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      const height = body.getBoundingClientRect().height;
      setMeasurement((previous) =>
        previous?.height === height
          ? previous
          : { height, animate: previous !== undefined },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  return (
    <motion.div
      data-slot="screenshot-preview"
      initial={false}
      animate={{ height: measurement?.height ?? "auto" }}
      transition={{
        duration: reducedMotion || !measurement?.animate ? 0 : 0.2,
        ease: [0.2, 0, 0, 1],
      }}
      className="min-w-0 overflow-hidden"
    >
      <div ref={bodyRef} className="min-w-0">
        {data ? (
          <div
            className="relative"
            style={
              size && !failed
                ? {
                    width: `min(100%, ${Math.min(size.width, (256 * size.width) / size.height)}px)`,
                    aspectRatio: `${size.width} / ${size.height}`,
                  }
                : undefined
            }
          >
            {!failed && (
              <img
                src={ready ? src : undefined}
                width={size?.width}
                height={size?.height}
                alt="浏览器截图"
                className={cn(
                  "absolute inset-0 size-full rounded-md border object-contain transition-opacity duration-200 motion-reduce:transition-none",
                  !ready && "opacity-0",
                  entry.prunedFromContext && "grayscale",
                  ready && entry.prunedFromContext && "opacity-50",
                )}
              />
            )}
            {(!ready || failed) && (
              <p
                className={cn(
                  "px-3 py-2 text-xs text-muted-foreground",
                  size && !failed && "absolute inset-0",
                )}
              >
                {failed ? "截图加载失败" : "正在加载截图…"}
              </p>
            )}
          </div>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">正在截屏…</p>
        )}
        {data && entry.prunedFromContext && (
          <p className="mt-2 text-xs text-muted-foreground">已从上下文删除</p>
        )}
      </div>
    </motion.div>
  );
}
