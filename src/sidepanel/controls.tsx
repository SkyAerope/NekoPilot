import { MousePointer2, X, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function IconAction({
  label,
  children,
  ...props
}: { label: string } & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function ReferenceChip({
  label,
  icon,
  onRemove,
  className,
}: {
  label: string;
  icon?: React.ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("max-w-full gap-1 text-xs font-normal", className)}
      title={label}
    >
      {icon ?? <MousePointer2 className="size-3 shrink-0 text-primary" />}
      <span className="max-w-44 truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${label}`}
          className="shrink-0 rounded-sm p-0.5 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="size-3" />
        </button>
      )}
    </Badge>
  );
}

export function WorkingIndicator() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
    >
      <LoaderCircle className="size-3.5 animate-spin" />
      正在工作…
    </div>
  );
}
