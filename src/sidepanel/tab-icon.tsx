import { useState } from "react";
import { Link } from "lucide-react";
import type { TargetTab } from "../shared/target-tab";

export function TabIcon({ tab }: { tab: TargetTab }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = tab.favIconUrl;
  const loaded = Boolean(url && loadedUrl === url && failedUrl !== url);
  return (
    <span className="relative inline-flex size-3.5 shrink-0" aria-hidden="true">
      {!loaded && <Link className="size-3.5 text-muted-foreground" />}
      {url && failedUrl !== url && (
        <img
          src={url}
          alt=""
          className={`absolute inset-0 size-3.5 object-contain ${loaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLoadedUrl(url)}
          onError={() => setFailedUrl(url)}
        />
      )}
    </span>
  );
}
