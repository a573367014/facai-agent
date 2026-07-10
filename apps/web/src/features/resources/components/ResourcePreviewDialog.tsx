import { Dialog, DialogContent, IconButton } from "@mui/material";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { lazy, Suspense } from "react";

export interface ResourcePreviewItem {
  url: string;
  mime?: string;
  prompt?: string;
}

interface ResourcePreviewDialogProps {
  item?: ResourcePreviewItem;
  canNavigate?: boolean;
  onClose: () => void;
  onNavigate?: (offset: number) => void;
}

const OpenFileViewerPreview = lazy(() =>
  import("./OpenFileViewerPreview").then((module) => ({
    default: module.OpenFileViewerPreview
  }))
);

export function ResourcePreviewDialog({ item, canNavigate = false, onClose, onNavigate }: ResourcePreviewDialogProps) {
  const kind = getResourcePreviewKind(item);
  const label = getResourcePreviewLabel(kind);

  return (
    <Dialog
      className="message-resource-lightbox resource-preview-dialog"
      open={Boolean(item?.url)}
      onClose={onClose}
      maxWidth={false}
      slotProps={{
        paper: {
          "aria-label": `${label}预览`
        }
      }}
    >
      <DialogContent className="message-resource-lightbox-content resource-preview-content">
        <IconButton type="button" className="message-resource-lightbox-close" aria-label={`关闭${label}预览`} onClick={onClose}>
          <X size={18} />
        </IconButton>
        {canNavigate ? (
          <IconButton
            type="button"
            className="message-resource-lightbox-nav previous"
            aria-label="上一个资源"
            onClick={() => onNavigate?.(-1)}
          >
            <ChevronLeft size={22} />
          </IconButton>
        ) : null}
        {item ? <ResourcePreviewBody item={item} kind={kind} /> : null}
        {canNavigate ? (
          <IconButton
            type="button"
            className="message-resource-lightbox-nav next"
            aria-label="下一个资源"
            onClick={() => onNavigate?.(1)}
          >
            <ChevronRight size={22} />
          </IconButton>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ResourcePreviewBody({ item, kind }: { item: ResourcePreviewItem; kind: ResourcePreviewKind }) {
  if (kind === "image") {
    return <img alt={item.prompt ?? "图片预览"} src={item.url} />;
  }

  if (kind === "video") {
    return (
      <video
        className="resource-preview-native-video"
        aria-label={`${item.prompt ?? "视频"}预览`}
        src={item.url}
        controls
        autoPlay
        muted
        playsInline
        preload="auto"
      />
    );
  }

  return (
    <Suspense fallback={<div className="resource-preview-loading" role="status">正在加载预览</div>}>
      <OpenFileViewerPreview item={item} />
    </Suspense>
  );
}

type ResourcePreviewKind = "image" | "video" | "file";

function getResourcePreviewKind(item?: ResourcePreviewItem): ResourcePreviewKind {
  if (item?.mime?.startsWith("image/")) {
    return "image";
  }

  if (item?.mime?.startsWith("video/")) {
    return "video";
  }

  return "file";
}

function getResourcePreviewLabel(kind: ResourcePreviewKind) {
  if (kind === "image") {
    return "图片";
  }

  if (kind === "video") {
    return "视频";
  }

  return "资源";
}
