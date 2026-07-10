import { ButtonBase, CircularProgress, IconButton, Menu, MenuItem } from "@mui/material";
import { Copy, Download, ExternalLink, FileText, ImageOff, Maximize2, MoreHorizontal, Quote } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ToolResourceActionPayload, ToolResourceActionType } from "@/features/inspector/model/tool-resource-action";
import type { ToolTrace } from "@/features/inspector/model/tool-traces";
import { ResourcePreviewDialog } from "./ResourcePreviewDialog";

export interface MessageResourceGalleryItem {
  id: string;
  resourceId?: string;
  url?: string;
  mime?: string;
  name?: string;
  prompt?: string;
  width?: number;
  height?: number;
  resourceType?: string;
  toolCallRowId?: string;
  outputIndex?: number;
  state?: "pending" | "succeeded" | "failed";
  error?: string;
  trace: ToolTrace;
}

interface MessageResourceGalleryProps {
  items: MessageResourceGalleryItem[];
  onResourceAction?: (payload: ToolResourceActionPayload) => void;
}

const MAX_RESOURCE_TILE_SIZE = 300;

export function MessageResourceGallery({ items, onResourceAction }: MessageResourceGalleryProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [actionMenu, setActionMenu] = useState<{ itemIndex: number; anchorEl: HTMLElement } | null>(null);
  const previewItem = previewIndex === null ? undefined : items[previewIndex];
  const canNavigatePreview = previewIndex !== null && items.filter((item) => item.url).length > 1;

  if (!items.length) {
    return null;
  }

  function emitResourceAction(action: ToolResourceActionType, item: MessageResourceGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    onResourceAction?.({
      action,
      url: item.url,
      index,
      prompt: item.prompt ?? item.name ?? `资源 ${index + 1}`,
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
    emitResourceAction("preview", item, index);
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
    emitResourceAction("preview", items[nextIndex], nextIndex);
  }

  function copyText(value: string) {
    const write = navigator.clipboard?.writeText(value);
    void write?.catch(() => undefined);
  }

  function copyResourceLink(item: MessageResourceGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    copyText(item.url);
    setActionMenu(null);
    emitResourceAction("copy_link", item, index);
  }

  function quoteResource(item: MessageResourceGalleryItem, index: number) {
    if (!item.url) {
      return;
    }

    setActionMenu(null);
    emitResourceAction("quote", item, index);
  }

  function openResourceMenu(event: MouseEvent<HTMLElement>, index: number) {
    setActionMenu({ itemIndex: index, anchorEl: event.currentTarget });
  }

  return (
    <div className={`message-resource-gallery ${items.length === 1 ? "single" : "multi"}`}>
      {items.map((item, index) => (
        <figure className={`message-resource-tile ${getItemKind(item)} ${item.state ?? "succeeded"}`} key={item.id}>
          {renderResourceFrame(
            item,
            index,
            openPreview,
            openResourceMenu,
            () => setActionMenu(null),
            emitResourceAction,
            actionMenu,
            copyResourceLink,
            quoteResource
          )}
        </figure>
      ))}

      <ResourcePreviewDialog
        item={previewItem?.url ? { url: previewItem.url, mime: previewItem.mime, prompt: previewItem.prompt ?? previewItem.name } : undefined}
        canNavigate={canNavigatePreview}
        onClose={() => setPreviewIndex(null)}
        onNavigate={movePreview}
      />
    </div>
  );
}

function renderResourceFrame(
  item: MessageResourceGalleryItem,
  index: number,
  openPreview: (index: number) => void,
  openResourceMenu: (event: MouseEvent<HTMLElement>, index: number) => void,
  closeResourceMenu: () => void,
  emitResourceAction: (action: ToolResourceActionType, item: MessageResourceGalleryItem, index: number) => void,
  actionMenu: { itemIndex: number; anchorEl: HTMLElement } | null,
  copyResourceLink: (item: MessageResourceGalleryItem, index: number) => void,
  quoteResource: (item: MessageResourceGalleryItem, index: number) => void
) {
  const isVideo = isVideoItem(item);
  const isDocument = isDocumentItem(item);
  const frameSize = fitWithinBox(item.width, item.height, isVideo);
  const frameStyle = {
    width: `${frameSize.width}px`,
    height: `${frameSize.height}px`
  };
  const resourceLabel = isDocument ? "文档" : isVideo ? "视频" : "图片";

  if (item.state === "failed") {
    return (
      <div className="message-resource-frame failed" style={frameStyle}>
        <ImageOff className="message-resource-failed-icon" size={30} strokeWidth={1.8} aria-hidden="true" />
        <strong>生成失败</strong>
      </div>
    );
  }

  if (!item.url || item.state === "pending") {
    return (
      <>
        <div className="message-resource-frame loading" style={frameStyle} role="status" aria-live="polite">
          <div className="message-resource-loading-shine" aria-hidden="true" />
          <div className="message-resource-loading-content">
            <CircularProgress size={20} />
            <strong>正在生成{resourceLabel}</strong>
            {item.width && item.height ? <span>{item.width} x {item.height}</span> : null}
          </div>
        </div>
      </>
    );
  }

  if (isDocument) {
    return renderDocumentFrame(
      item,
      index,
      openPreview,
      openResourceMenu,
      closeResourceMenu,
      emitResourceAction,
      actionMenu,
      copyResourceLink
    );
  }

  return (
    <>
      <div className="message-resource-frame" style={frameStyle}>
        {isVideo ? (
          <video
            className="message-resource-canvas message-video-canvas"
            aria-label={item.prompt ?? `视频 ${index + 1}`}
            src={item.url}
            controls
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        ) : (
          <ButtonBase
            type="button"
            className="message-resource-canvas"
            aria-label={`预览图片 ${index + 1}`}
            title="预览"
            onClick={() => openPreview(index)}
          >
            <img alt={item.prompt ?? `图片 ${index + 1}`} src={item.url} />
          </ButtonBase>
        )}
        <div className="message-resource-actions">
          {isVideo ? (
            <IconButton
              type="button"
              aria-label={`预览视频 ${index + 1}`}
              title="预览"
              size="small"
              onClick={() => openPreview(index)}
            >
              <Maximize2 size={14} />
            </IconButton>
          ) : null}
          <IconButton
            component="a"
            href={item.url}
            download={isVideo ? `generated-video-${index + 1}.mp4` : `generated-image-${index + 1}.png`}
            aria-label={`下载${resourceLabel} ${index + 1}`}
            title="下载"
            size="small"
            onClick={() => emitResourceAction("download", item, index)}
          >
            <Download size={14} />
          </IconButton>
          <IconButton
            type="button"
            aria-label={`更多${resourceLabel}操作 ${index + 1}`}
            title="更多"
            aria-haspopup="menu"
            aria-expanded={actionMenu?.itemIndex === index}
            size="small"
            onClick={(event) => openResourceMenu(event, index)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        </div>
        <Menu
          className="message-resource-menu"
          anchorEl={actionMenu?.anchorEl ?? null}
          open={actionMenu?.itemIndex === index}
          onClose={closeResourceMenu}
          disableRestoreFocus
          slotProps={{
            list: {
              "aria-label": `${resourceLabel} ${index + 1} 操作菜单`
            }
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <MenuItem aria-label={`复制${resourceLabel}链接 ${index + 1}`} onClick={() => copyResourceLink(item, index)}>
            <Copy size={14} />
            复制链接
          </MenuItem>
          {!isVideo ? (
            <MenuItem aria-label={`引用${resourceLabel} ${index + 1}`} onClick={() => quoteResource(item, index)}>
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
              closeResourceMenu();
              emitResourceAction("open_original", item, index);
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

function renderDocumentFrame(
  item: MessageResourceGalleryItem,
  index: number,
  openPreview: (index: number) => void,
  openResourceMenu: (event: MouseEvent<HTMLElement>, index: number) => void,
  closeResourceMenu: () => void,
  emitResourceAction: (action: ToolResourceActionType, item: MessageResourceGalleryItem, index: number) => void,
  actionMenu: { itemIndex: number; anchorEl: HTMLElement } | null,
  copyResourceLink: (item: MessageResourceGalleryItem, index: number) => void
) {
  const displayName = item.name ?? item.prompt ?? `生成文档 ${index + 1}`;

  return (
    <div className="message-document-card">
      <ButtonBase
        type="button"
        className="message-document-main"
        aria-label={`预览文档 ${index + 1}`}
        title="预览"
        onClick={() => openPreview(index)}
      >
        <div className="message-document-icon" aria-hidden="true">
          <FileText size={22} />
        </div>
        <div className="message-document-info">
          <strong>{displayName}</strong>
          <span>{getDocumentFormatLabel(item)}</span>
        </div>
      </ButtonBase>
      <div className="message-document-actions">
        <IconButton
          type="button"
          aria-label={`预览文档 ${index + 1}`}
          title="预览"
          size="small"
          onClick={() => openPreview(index)}
        >
          <Maximize2 size={14} />
        </IconButton>
        <IconButton
          component="a"
          href={item.url}
          download={displayName}
          aria-label={`下载文档 ${index + 1}`}
          title="下载"
          size="small"
          onClick={() => emitResourceAction("download", item, index)}
        >
          <Download size={14} />
        </IconButton>
        <IconButton
          type="button"
          aria-label={`更多文档操作 ${index + 1}`}
          title="更多"
          aria-haspopup="menu"
          aria-expanded={actionMenu?.itemIndex === index}
          size="small"
          onClick={(event) => openResourceMenu(event, index)}
        >
          <MoreHorizontal size={15} />
        </IconButton>
      </div>
      <Menu
        className="message-resource-menu"
        anchorEl={actionMenu?.anchorEl ?? null}
        open={actionMenu?.itemIndex === index}
        onClose={closeResourceMenu}
        disableRestoreFocus
        slotProps={{
          list: {
            "aria-label": `文档 ${index + 1} 操作菜单`
          }
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem aria-label={`复制文档链接 ${index + 1}`} onClick={() => copyResourceLink(item, index)}>
          <Copy size={14} />
          复制链接
        </MenuItem>
        <MenuItem
          component="a"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`打开原文档 ${index + 1}`}
          onClick={() => {
            closeResourceMenu();
            emitResourceAction("open_original", item, index);
          }}
        >
          <ExternalLink size={14} />
          打开原文档
        </MenuItem>
      </Menu>
    </div>
  );
}

function getItemKind(item: MessageResourceGalleryItem) {
  if (isDocumentItem(item)) {
    return "document";
  }

  return isVideoItem(item) ? "video" : "image";
}

function isVideoItem(item: MessageResourceGalleryItem) {
  return item.mime?.startsWith("video/") || item.trace.toolName === "generate_video";
}

function isDocumentItem(item: MessageResourceGalleryItem) {
  return (
    item.resourceType === "document" ||
    item.trace.toolName === "generate_document" ||
    item.mime?.startsWith("text/") ||
    item.mime === "application/markdown" ||
    item.mime === "application/pdf" ||
    item.mime === "application/msword" ||
    item.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function getDocumentFormatLabel(item: MessageResourceGalleryItem) {
  if (item.mime === "text/markdown" || item.mime === "application/markdown" || item.name?.toLowerCase().endsWith(".md")) {
    return "Markdown";
  }

  if (item.mime === "text/plain" || item.name?.toLowerCase().endsWith(".txt")) {
    return "TXT";
  }

  if (item.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || item.name?.toLowerCase().endsWith(".docx")) {
    return "Word";
  }

  if (item.mime === "application/pdf" || item.name?.toLowerCase().endsWith(".pdf")) {
    return "PDF";
  }

  return item.mime ?? "文件";
}

function fitWithinBox(width?: number, height?: number, preferVideoRatio = false) {
  if (!width || !height || width <= 0 || height <= 0) {
    if (preferVideoRatio) {
      return {
        width: MAX_RESOURCE_TILE_SIZE,
        height: Math.round((MAX_RESOURCE_TILE_SIZE * 9) / 16)
      };
    }

    return {
      width: MAX_RESOURCE_TILE_SIZE,
      height: MAX_RESOURCE_TILE_SIZE
    };
  }

  const scale = Math.min(MAX_RESOURCE_TILE_SIZE / width, MAX_RESOURCE_TILE_SIZE / height, 1);

  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  };
}
