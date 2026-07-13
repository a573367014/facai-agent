import {
  audioPlugin,
  fallbackPlugin,
  imagePlugin,
  officePlugin,
  pdfPlugin,
  textPlugin,
  videoPlugin
} from "@open-file-viewer/core";
import "@open-file-viewer/core/style.css";
import { FileViewer } from "@open-file-viewer/react";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { ResourcePreviewItem } from "./ResourcePreviewDialog";

interface OpenFileViewerPreviewProps {
  item: ResourcePreviewItem;
}

const pdfOptions = {
  workerSrc: pdfWorkerSrc,
  useFetchData: true
};

const previewPlugins = [
  imagePlugin(),
  videoPlugin(),
  audioPlugin(),
  textPlugin(),
  pdfPlugin(pdfOptions),
  officePlugin({ pdf: pdfOptions }),
  fallbackPlugin()
];

export function OpenFileViewerPreview({ item }: OpenFileViewerPreviewProps) {
  return (
    <FileViewer
      className="resource-preview-file-viewer"
      file={item.url}
      fileName={item.prompt ?? inferFileName(item.url)}
      fit="contain"
      height="min(84vh, 760px)"
      locale="zh-CN"
      mimeType={item.mime}
      plugins={previewPlugins}
      theme="dark"
      toolbar={{
        download: true,
        fullscreen: true,
        print: true,
        search: true,
        labels: {
          download: "下载",
          fullscreen: "全屏",
          print: "打印",
          search: "搜索"
        },
        titles: {
          download: "下载原文件",
          fullscreen: "全屏预览",
          print: "打印",
          search: "搜索内容"
        }
      }}
      width="min(92vw, 1180px)"
    />
  );
}

function inferFileName(url: string) {
  try {
    const parsedUrl = new URL(url, window.location.origin);
    const lastSegment = parsedUrl.pathname.split("/").filter(Boolean).pop();
    return decodeURIComponent(lastSegment ?? "资源预览");
  } catch {
    return "资源预览";
  }
}
