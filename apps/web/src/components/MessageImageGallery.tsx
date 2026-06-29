import { ButtonBase, CircularProgress, Dialog, DialogContent, IconButton, Menu, MenuItem } from "@mui/material";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, MoreHorizontal, Quote, X } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ToolTrace } from "../utils/tool-traces";
import type { ToolImageActionPayload, ToolImageActionType } from "./ToolResultPreview";

export interface MessageImageGalleryItem {
  id: string;
  url?: string;
  prompt?: string;
  width?: number;
  height?: number;
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

    copyText(`![${item.prompt || `图片 ${index + 1}`}](${item.url})`);
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
  const frameSize = fitWithinBox(item.width, item.height);
  const frameStyle = {
    width: `${frameSize.width}px`,
    height: `${frameSize.height}px`
  };

  if (item.state === "failed") {
    return (
      <div className="message-image-frame failed" style={frameStyle}>
        <strong>图片生成失败</strong>
        <p>{item.error ?? "图片生成失败"}</p>
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
            <strong>正在生成图片</strong>
            {item.width && item.height ? <span>{item.width} x {item.height}</span> : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="message-image-frame" style={frameStyle}>
        <ButtonBase
          type="button"
          className="message-image-canvas"
          aria-label={`预览图片 ${index + 1}`}
          title="预览"
          onClick={() => openPreview(index)}
        >
          <img alt={item.prompt ?? `图片 ${index + 1}`} src={item.url} />
        </ButtonBase>
        <div className="message-image-actions">
          <IconButton
            component="a"
            href={item.url}
            download={`generated-image-${index + 1}.png`}
            aria-label={`下载图片 ${index + 1}`}
            title="下载"
            size="small"
            onClick={() => emitImageAction("download", item, index)}
          >
            <Download size={14} />
          </IconButton>
          <IconButton
            type="button"
            aria-label={`更多图片操作 ${index + 1}`}
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
              "aria-label": `图片 ${index + 1} 操作菜单`
            }
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <MenuItem aria-label={`复制图片链接 ${index + 1}`} onClick={() => copyImageLink(item, index)}>
            <Copy size={14} />
            复制链接
          </MenuItem>
          <MenuItem aria-label={`引用图片 ${index + 1}`} onClick={() => quoteImage(item, index)}>
            <Quote size={14} />
            引用
          </MenuItem>
          <MenuItem
            component="a"
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`打开原图 ${index + 1}`}
            onClick={() => {
              closeImageMenu();
              emitImageAction("open_original", item, index);
            }}
          >
            <ExternalLink size={14} />
            打开原图
          </MenuItem>
        </Menu>
      </div>
    </>
  );
}

function fitWithinBox(width?: number, height?: number) {
  if (!width || !height || width <= 0 || height <= 0) {
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
