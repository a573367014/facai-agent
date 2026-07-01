import { ButtonBase, CircularProgress, Dialog, DialogContent, IconButton, Menu, MenuItem } from "@mui/material";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, ImageOff, MoreHorizontal, Quote, X } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ToolTrace } from "../utils/tool-traces";
import type { ToolImageActionPayload, ToolImageActionType } from "./ToolResultPreview";

export interface MessageImageGalleryItem {
  id: string;
  resourceId?: string;
  url?: string;
  mime?: string;
  prompt?: string;
  width?: number;
  height?: number;
  toolCallRowId?: string;
  outputIndex?: number;
  state?: "pending" | "succeeded" | "failed";
  error?: string;
  trace: ToolTrace;
}

interface MessageImageGalleryProps {
  items: MessageImageGalleryItem[];
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

const MAX_IMAGE_TILE_SIZE = 300;

export function MessageImageGallery({ items, onImageAction }: MessageImageGalleryProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [actionMenu, setActionMenu] = useState<{ itemIndex: number; anchorEl: HTMLElement } | null>(null);
  const previewItem = previewIndex === null ? undefined : items[previewIndex];
  const canNavigatePreview = previewIndex !== null && items.filter((item) => item.url).length > 1;

  if (!items.length) {
    return null;
  }

  function emitImageAction(action: ToolImageActionType, item: MessageImageGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    onImageAction?.({
      action,
      url: item.url,
      index,
      prompt: item.prompt ?? `图片 ${index + 1}`,
      mime: item.mime,
      width: item.width,
      height: item.height,
      resourceId: item.resourceId,
      toolCallRowId: item.toolCallRowId,
      outputIndex: item.outputIndex,
      trace: item.trace
    });
  }

  function openPreview(index: number) {
    const item = items[index];

    if (!item?.url) {
      return;
    }

    setPreviewIndex(index);
    emitImageAction("preview", item, index);
  }

  function movePreview(offset: number) {
    if (previewIndex === null) {
      return;
    }

    const availableIndexes = items.flatMap((item, index) => (item.url ? [index] : []));
    const currentPosition = availableIndexes.indexOf(previewIndex);

    if (currentPosition === -1) {
      return;
    }

    const nextPosition = (currentPosition + offset + availableIndexes.length) % availableIndexes.length;
    const nextIndex = availableIndexes[nextPosition];

    setPreviewIndex(nextIndex);
    emitImageAction("preview", items[nextIndex], nextIndex);
  }

  function copyText(value: string) {
    const write = navigator.clipboard?.writeText(value);
    void write?.catch(() => undefined);
  }

  function copyImageLink(item: MessageImageGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    copyText(item.url);
    setActionMenu(null);
    emitImageAction("copy_link", item, index);
  }

  function quoteImage(item: MessageImageGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    setActionMenu(null);
    emitImageAction("quote", item, index);
  }

  function openImageMenu(event: MouseEvent<HTMLElement>, index: number) {
    setActionMenu({ itemIndex: index, anchorEl: event.currentTarget });
  }

  return (
    <div className={`message-image-gallery ${items.length === 1 ? "single" : "multi"}`}>
      {items.map((item, index) => (
        <figure className={`message-image-tile ${item.state ?? "succeeded"}`} key={item.id}>
          {renderImageFrame(
            item,
            index,
            openPreview,
            openImageMenu,
            () => setActionMenu(null),
            emitImageAction,
            actionMenu,
            copyImageLink,
            quoteImage
          )}
        </figure>
      ))}

      <Dialog
        className="message-image-lightbox"
        open={Boolean(previewItem?.url)}
        onClose={() => setPreviewIndex(null)}
        maxWidth={false}
        slotProps={{
          paper: {
            "aria-label": "图片预览"
          }
        }}
      >
        <DialogContent className="message-image-lightbox-content">
          <IconButton
            type="button"
            className="message-image-lightbox-close"
            aria-label="关闭图片预览"
            onClick={() => setPreviewIndex(null)}
          >
            <X size={18} />
          </IconButton>
          {canNavigatePreview ? (
            <IconButton
              type="button"
              className="message-image-lightbox-nav previous"
              aria-label="上一张图片"
              onClick={() => movePreview(-1)}
            >
              <ChevronLeft size={22} />
            </IconButton>
          ) : null}
          {previewItem?.url ? <img alt={previewItem.prompt ?? "图片预览"} src={previewItem.url} /> : null}
          {canNavigatePreview ? (
            <IconButton
              type="button"
              className="message-image-lightbox-nav next"
              aria-label="下一张图片"
              onClick={() => movePreview(1)}
            >
              <ChevronRight size={22} />
            </IconButton>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function renderImageFrame(
  item: MessageImageGalleryItem,
  index: number,
  openPreview: (index: number) => void,
  openImageMenu: (event: MouseEvent<HTMLElement>, index: number) => void,
  closeImageMenu: () => void,
  emitImageAction: (action: ToolImageActionType, item: MessageImageGalleryItem, index: number) => void,
  actionMenu: { itemIndex: number; anchorEl: HTMLElement } | null,
  copyImageLink: (item: MessageImageGalleryItem, index: number) => void,
  quoteImage: (item: MessageImageGalleryItem, index: number) => void
) {
  const isVideo = isVideoItem(item);
  const frameSize = fitWithinBox(item.width, item.height, isVideo);
  const frameStyle = {
    width: `${frameSize.width}px`,
    height: `${frameSize.height}px`
  };
  const mediaLabel = isVideo ? "视频" : "图片";

  if (item.state === "failed") {
    return (
      <div className="message-image-frame failed" style={frameStyle}>
        <ImageOff className="message-image-failed-icon" size={30} strokeWidth={1.8} aria-hidden="true" />
        <strong>生成失败</strong>
      </div>
    );
  }

  if (!item.url || item.state === "pending") {
    return (
      <>
        <div className="message-image-frame loading" style={frameStyle} role="status" aria-live="polite">
          <div className="message-image-loading-shine" aria-hidden="true" />
          <div className="message-image-loading-content">
            <CircularProgress size={20} />
            <strong>正在生成{mediaLabel}</strong>
            {item.width && item.height ? <span>{item.width} x {item.height}</span> : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="message-image-frame" style={frameStyle}>
        {isVideo ? (
          <video
            className="message-image-canvas message-video-canvas"
            aria-label={item.prompt ?? `视频 ${index + 1}`}
            src={item.url}
            controls
            preload="metadata"
          />
        ) : (
          <ButtonBase
            type="button"
            className="message-image-canvas"
            aria-label={`预览图片 ${index + 1}`}
            title="预览"
            onClick={() => openPreview(index)}
          >
            <img alt={item.prompt ?? `图片 ${index + 1}`} src={item.url} />
          </ButtonBase>
        )}
        <div className="message-image-actions">
          <IconButton
            component="a"
            href={item.url}
            download={isVideo ? `generated-video-${index + 1}.mp4` : `generated-image-${index + 1}.png`}
            aria-label={`下载${mediaLabel} ${index + 1}`}
            title="下载"
            size="small"
            onClick={() => emitImageAction("download", item, index)}
          >
            <Download size={14} />
          </IconButton>
          <IconButton
            type="button"
            aria-label={`更多${mediaLabel}操作 ${index + 1}`}
            title="更多"
            aria-haspopup="menu"
            aria-expanded={actionMenu?.itemIndex === index}
            size="small"
            onClick={(event) => openImageMenu(event, index)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        </div>
        <Menu
          className="message-image-menu"
          anchorEl={actionMenu?.anchorEl ?? null}
          open={actionMenu?.itemIndex === index}
          onClose={closeImageMenu}
          disableRestoreFocus
          slotProps={{
            list: {
              "aria-label": `${mediaLabel} ${index + 1} 操作菜单`
            }
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <MenuItem aria-label={`复制${mediaLabel}链接 ${index + 1}`} onClick={() => copyImageLink(item, index)}>
            <Copy size={14} />
            复制链接
          </MenuItem>
          {!isVideo ? (
            <MenuItem aria-label={`引用${mediaLabel} ${index + 1}`} onClick={() => quoteImage(item, index)}>
              <Quote size={14} />
              引用
            </MenuItem>
          ) : null}
          <MenuItem
            component="a"
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={isVideo ? `打开原视频 ${index + 1}` : `打开原图 ${index + 1}`}
            onClick={() => {
              closeImageMenu();
              emitImageAction("open_original", item, index);
            }}
          >
            <ExternalLink size={14} />
            {isVideo ? "打开原视频" : "打开原图"}
          </MenuItem>
        </Menu>
      </div>
    </>
  );
}

function isVideoItem(item: MessageImageGalleryItem) {
  return item.mime?.startsWith("video/") || item.trace.toolName === "generate_video";
}

function fitWithinBox(width?: number, height?: number, preferVideoRatio = false) {
  if (!width || !height || width <= 0 || height <= 0) {
    if (preferVideoRatio) {
      return {
        width: MAX_IMAGE_TILE_SIZE,
        height: Math.round((MAX_IMAGE_TILE_SIZE * 9) / 16)
      };
    }

    return {
      width: MAX_IMAGE_TILE_SIZE,
      height: MAX_IMAGE_TILE_SIZE
    };
  }

  const scale = Math.min(MAX_IMAGE_TILE_SIZE / width, MAX_IMAGE_TILE_SIZE / height, 1);

  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}
