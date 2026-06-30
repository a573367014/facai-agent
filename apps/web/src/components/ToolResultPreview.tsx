import { ButtonBase, CircularProgress, Dialog, DialogContent, IconButton, Menu, MenuItem } from "@mui/material";
import { Copy, Download, ExternalLink, MoreHorizontal, Quote, X } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ToolTrace } from "../utils/tool-traces";

interface SearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
}

interface WebSearchResult {
  query?: string;
  answer?: string;
  resultCount?: number;
  results?: SearchResultItem[];
}

export interface ImageResult {
  prompt?: string;
  size?: string;
  imageUrls?: string[];
  revisedPrompts?: string[];
  // 批量生图会同时返回顶层 imageUrls 和明细 items：
  // 顶层 imageUrls 方便正文过滤资源链接；items 保留每个子任务的 prompt、尺寸和失败原因，适合 UI 展示。
  total?: number;
  succeeded?: number;
  failed?: number;
  items?: ImageResultItem[];
}

interface ImageResultItem {
  index?: number;
  status?: string;
  prompt?: string;
  width?: number;
  height?: number;
  seed?: number;
  imageUrls?: string[];
  binaryDataBase64?: string[];
  error?: string;
}

export type ToolImageActionType = "preview" | "download" | "copy_link" | "quote" | "open_original";

export interface ToolImageActionPayload {
  action: ToolImageActionType;
  url: string;
  index: number;
  prompt: string;
  mime?: string;
  width?: number;
  height?: number;
  resourceId?: string;
  toolCallRowId?: string;
  outputIndex?: number;
  trace: ToolTrace;
}

interface ToolResultPreviewProps {
  trace: ToolTrace;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}

function isImageToolName(toolName: string) {
  return toolName === "generate_image" || toolName === "edit_image";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDisplayText(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function asWebSearchResult(result: unknown): WebSearchResult | null {
  if (!isRecord(result) || !Array.isArray(result.results)) {
    return null;
  }

  return result as WebSearchResult;
}

export function asImageResult(result: unknown): ImageResult | null {
  if (!isRecord(result) || !Array.isArray(result.imageUrls)) {
    return null;
  }

  return result as ImageResult;
}

function getImagePrompt(trace: ToolTrace, result?: ImageResult | null) {
  return result?.prompt ?? toDisplayText(trace.arguments?.prompt);
}

function getImageSize(trace: ToolTrace, result?: ImageResult | null) {
  if (result?.size) {
    return result.size;
  }

  const width = trace.arguments?.width;
  const height = trace.arguments?.height;

  if (typeof width === "number" && typeof height === "number") {
    return `${width} x ${height}`;
  }

  return "";
}

function getImageItemSize(item: ImageResultItem) {
  if (typeof item.width === "number" && typeof item.height === "number") {
    return `${item.width} x ${item.height}`;
  }

  return "";
}

function getBatchSummary(result: ImageResult) {
  const items = result.items ?? [];
  // 后端会给 total/succeeded/failed；这里再按 items 兜底，避免工具只返回明细时摘要为空。
  const total = result.total ?? items.length;
  const succeeded = result.succeeded ?? items.filter((item) => item.status === "success").length;
  const failed = result.failed ?? items.filter((item) => item.status === "failed").length;

  return `批量 ${total} 项，成功 ${succeeded} 项，失败 ${failed} 项`;
}

function copyText(value: string) {
  const write = navigator.clipboard?.writeText(value);
  void write?.catch(() => undefined);
}

function RawJsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) {
    return null;
  }

  return (
    <details className="tool-raw-json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function WebSearchPreview({ trace, result }: { trace: ToolTrace; result: WebSearchResult }) {
  const query = result.query ?? toDisplayText(trace.arguments?.query);
  const results = result.results ?? [];

  return (
    <div className="tool-preview">
      {query ? (
        <div className="tool-preview-row">
          <span>query</span>
          <strong>{query}</strong>
        </div>
      ) : null}
      {result.answer ? <p className="tool-preview-answer">{result.answer}</p> : null}
      <div className="tool-preview-row">
        <span>来源</span>
        <strong>来源 {result.resultCount ?? results.length} 条</strong>
      </div>
      {results.length > 0 ? (
        <ol className="tool-source-list">
          {results.map((item, index) => (
            <li key={`${item.url ?? item.title ?? "source"}-${index}`}>
              {item.url ? (
                <a href={item.url} target="_blank" rel="noreferrer">
                  {item.title || item.url}
                </a>
              ) : (
                <strong>{item.title || "未命名来源"}</strong>
              )}
              {item.snippet ? <p>{item.snippet}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function ImageLoadingPreview({ trace }: { trace: ToolTrace }) {
  const prompt = getImagePrompt(trace);
  const size = getImageSize(trace);

  return (
    <div className="tool-preview">
      {prompt ? (
        <div className="tool-preview-row">
          <span>prompt</span>
          <strong>{prompt}</strong>
        </div>
      ) : null}
      {size ? (
        <div className="tool-preview-row">
          <span>尺寸</span>
          <strong>{size}</strong>
        </div>
      ) : null}
      <div className="tool-image-loading" role="status" aria-live="polite">
        <div className="tool-image-loading-shine" aria-hidden="true" />
        <div className="tool-image-loading-content">
          <CircularProgress size={20} />
          <strong>正在生成图片</strong>
          <p>正在根据你的描述生成图片，完成后会自动替换成预览。</p>
        </div>
      </div>
    </div>
  );
}

export function ImagePreview({
  trace,
  result,
  onImageAction
}: {
  trace: ToolTrace;
  result: ImageResult;
  onImageAction?: (payload: ToolImageActionPayload) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [actionMenu, setActionMenu] = useState<{ url: string; index: number; anchorEl: HTMLElement } | null>(null);
  const prompt = getImagePrompt(trace, result);
  const size = getImageSize(trace, result);
  const imageUrls = result.imageUrls ?? [];
  const batchItems = result.items ?? [];
  const hasBatchItems = batchItems.length > 0;

  const emitImageAction = (action: ToolImageActionType, url: string, index: number, itemPrompt = prompt) => {
    onImageAction?.({ action, url, index, prompt: itemPrompt, trace });
  };

  const previewImage = (url: string, index: number, itemPrompt?: string) => {
    setPreviewUrl(url);
    emitImageAction("preview", url, index, itemPrompt);
  };

  const copyImageLink = (url: string, index: number, itemPrompt?: string) => {
    copyText(url);
    setCopiedUrl(url);
    setActionMenu(null);
    emitImageAction("copy_link", url, index, itemPrompt);
  };

  const quoteImage = (url: string, index: number, itemPrompt?: string) => {
    setActionMenu(null);
    emitImageAction("quote", url, index, itemPrompt);
  };

  const openImageMenu = (event: MouseEvent<HTMLElement>, url: string, index: number) => {
    setActionMenu({ url, index, anchorEl: event.currentTarget });
  };

  return (
    <div className="tool-preview">
      {!hasBatchItems && prompt ? (
        <div className="tool-preview-row">
          <span>prompt</span>
          <strong>{prompt}</strong>
        </div>
      ) : null}
      {!hasBatchItems && size ? (
        <div className="tool-preview-row">
          <span>尺寸</span>
          <strong>{size}</strong>
        </div>
      ) : null}
      {hasBatchItems ? (
        <div className="tool-image-batch">
          <div className="tool-preview-row tool-image-batch-summary">
            <span>批量</span>
            <strong>{getBatchSummary(result)}</strong>
          </div>
          {batchItems.map((item, itemIndex) => {
            // 批量结果不能直接渲染顶层 imageUrls，因为那会丢掉“这张图来自哪个 prompt”
            // 和“哪个子任务失败了”。所以这里按 item 分组展示，用户能明确看到每个子任务的状态。
            const itemPrompt = item.prompt ?? `子任务 ${item.index ?? itemIndex + 1}`;
            const itemSize = getImageItemSize(item);
            const itemUrls = item.imageUrls ?? [];

            return (
              <div className={`tool-image-batch-item ${item.status ?? "unknown"}`} key={`${item.index ?? itemIndex}:${itemPrompt}`}>
                <div className="tool-preview-row">
                  <span>{item.status === "failed" ? "失败" : "prompt"}</span>
                  <strong>{itemPrompt}</strong>
                </div>
                {itemSize ? (
                  <div className="tool-preview-row">
                    <span>尺寸</span>
                    <strong>{itemSize}</strong>
                  </div>
                ) : null}
                {itemUrls.length > 0 ? (
                  <div className="tool-image-grid">
                    {itemUrls.map((url, imageIndex) => {
                      const flatIndex = item.index ?? imageIndex;

                      return (
                        <figure className="tool-image-preview" key={url}>
                          <div className="tool-image-stage">
                            <ButtonBase
                              type="button"
                              className="tool-image-canvas"
                              aria-label={`预览图片 ${flatIndex + 1}`}
                              title="预览"
                              onClick={() => previewImage(url, flatIndex, itemPrompt)}
                            >
                              <img alt={itemPrompt} src={url} />
                            </ButtonBase>
                            <div className="tool-image-actions">
                              <IconButton
                                component="a"
                                href={url}
                                download={`generated-image-${flatIndex + 1}.png`}
                                aria-label={`下载图片 ${flatIndex + 1}`}
                                title="下载"
                                size="small"
                                onClick={() => emitImageAction("download", url, flatIndex, itemPrompt)}
                              >
                                <Download size={14} />
                              </IconButton>
                              <IconButton
                                type="button"
                                aria-label={`更多图片操作 ${flatIndex + 1}`}
                                title="更多"
                                aria-haspopup="menu"
                                aria-expanded={actionMenu?.url === url}
                                size="small"
                                onClick={(event) => openImageMenu(event, url, flatIndex)}
                              >
                                <MoreHorizontal size={15} />
                              </IconButton>
                            </div>
                            <Menu
                              className="tool-image-menu"
                              anchorEl={actionMenu?.anchorEl ?? null}
                              open={actionMenu?.url === url}
                              onClose={() => setActionMenu(null)}
                              disableRestoreFocus
                              slotProps={{
                                list: {
                                  "aria-label": `图片 ${flatIndex + 1} 操作菜单`
                                }
                              }}
                              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                              transformOrigin={{ vertical: "top", horizontal: "right" }}
                            >
                              <MenuItem aria-label={`复制图片链接 ${flatIndex + 1}`} onClick={() => copyImageLink(url, flatIndex, itemPrompt)}>
                                <Copy size={14} />
                                复制链接
                              </MenuItem>
                              <MenuItem aria-label={`引用图片 ${flatIndex + 1}`} onClick={() => quoteImage(url, flatIndex, itemPrompt)}>
                                <Quote size={14} />
                                引用
                              </MenuItem>
                              <MenuItem
                                component="a"
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`打开原图 ${flatIndex + 1}`}
                                onClick={() => {
                                  setActionMenu(null);
                                  emitImageAction("open_original", url, flatIndex, itemPrompt);
                                }}
                              >
                                <ExternalLink size={14} />
                                打开原图
                              </MenuItem>
                            </Menu>
                          </div>
                          <figcaption className="tool-image-caption">
                            <span>{copiedUrl === url ? "已复制" : `图片 ${flatIndex + 1}`}</span>
                          </figcaption>
                        </figure>
                      );
                    })}
                  </div>
                ) : null}
                {item.error ? <p className="tool-image-batch-error">{item.error}</p> : null}
              </div>
            );
          })}
        </div>
      ) : imageUrls.length > 0 ? (
        <div className="tool-image-grid">
          {imageUrls.map((url, index) => (
            <figure className="tool-image-preview" key={url}>
              <div className="tool-image-stage">
                <ButtonBase
                  type="button"
                  className="tool-image-canvas"
                  aria-label={`预览图片 ${index + 1}`}
                  title="预览"
                  onClick={() => previewImage(url, index)}
                >
                  <img alt={`生成图片 ${index + 1}`} src={url} />
                </ButtonBase>
                <div className="tool-image-actions">
                  <IconButton
                    component="a"
                    href={url}
                    download={`generated-image-${index + 1}.png`}
                    aria-label={`下载图片 ${index + 1}`}
                    title="下载"
                    size="small"
                    onClick={() => emitImageAction("download", url, index)}
                  >
                    <Download size={14} />
                  </IconButton>
                  <IconButton
                    type="button"
                    aria-label={`更多图片操作 ${index + 1}`}
                    title="更多"
                    aria-haspopup="menu"
                    aria-expanded={actionMenu?.url === url}
                    size="small"
                    onClick={(event) => openImageMenu(event, url, index)}
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                </div>
                <Menu
                  className="tool-image-menu"
                  anchorEl={actionMenu?.anchorEl ?? null}
                  open={actionMenu?.url === url}
                  onClose={() => setActionMenu(null)}
                  disableRestoreFocus
                  slotProps={{
                    list: {
                      "aria-label": `图片 ${index + 1} 操作菜单`
                    }
                  }}
                  anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                  transformOrigin={{ vertical: "top", horizontal: "right" }}
                >
                  <MenuItem aria-label={`复制图片链接 ${index + 1}`} onClick={() => copyImageLink(url, index)}>
                    <Copy size={14} />
                    复制链接
                  </MenuItem>
                  <MenuItem aria-label={`引用图片 ${index + 1}`} onClick={() => quoteImage(url, index)}>
                    <Quote size={14} />
                    引用
                  </MenuItem>
                  <MenuItem
                    component="a"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`打开原图 ${index + 1}`}
                    onClick={() => {
                      setActionMenu(null);
                      emitImageAction("open_original", url, index);
                    }}
                  >
                    <ExternalLink size={14} />
                    打开原图
                  </MenuItem>
                </Menu>
              </div>
              <figcaption className="tool-image-caption">
                <span>{copiedUrl === url ? "已复制" : `图片 ${index + 1}`}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {result.revisedPrompts?.length ? (
        <RawJsonBlock label="改写后的提示词" value={result.revisedPrompts} />
      ) : null}
      <Dialog
        className="tool-image-lightbox"
        open={Boolean(previewUrl)}
        onClose={() => setPreviewUrl(null)}
        maxWidth={false}
        slotProps={{
          paper: {
            "aria-label": "图片预览"
          }
        }}
      >
        <DialogContent className="tool-image-lightbox-content">
          <IconButton type="button" className="tool-image-lightbox-close" aria-label="关闭图片预览" onClick={() => setPreviewUrl(null)}>
            <X size={18} />
          </IconButton>
          {previewUrl ? <img alt="图片预览" src={previewUrl} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImageTraceSummary({ trace }: { trace: ToolTrace }) {
  const isRunning = trace.status === "pending" || trace.status === "running";

  return (
    <div className="tool-preview tool-image-trace-summary">
      <p>{isRunning ? "图片正在正文区域生成中。" : "图片结果已在正文区域展示。"}</p>
    </div>
  );
}

export function ToolResultPreview({ trace, onImageAction }: ToolResultPreviewProps) {
  // 工具的完整 result 仍然是 unknown：不同工具返回结构不一样。
  // 展示层只对已知工具做“友好预览”，未知工具保留 JSON 折叠块，避免为了 UI 反向约束所有工具必须长成一种格式。
  if (trace.error) {
    return (
      <div className="tool-preview tool-error-preview">
        <strong>{trace.error.code}</strong>
        <p>{trace.error.message}</p>
        <span>{trace.error.recoverable ? "可恢复，模型可以继续根据错误调整" : "不可恢复，本次工具调用已停止"}</span>
      </div>
    );
  }

  const searchResult = asWebSearchResult(trace.result);
  if (trace.toolName === "web_search" && searchResult) {
    return <WebSearchPreview trace={trace} result={searchResult} />;
  }

  if (isImageToolName(trace.toolName) && (trace.status === "pending" || trace.status === "running")) {
    return <ImageTraceSummary trace={trace} />;
  }

  const imageResult = asImageResult(trace.result);
  if (isImageToolName(trace.toolName) && imageResult) {
    return <ImageTraceSummary trace={trace} />;
  }

  return (
    <div className="tool-preview">
      <RawJsonBlock label="参数" value={trace.arguments} />
      <RawJsonBlock label="结果" value={trace.result} />
    </div>
  );
}
