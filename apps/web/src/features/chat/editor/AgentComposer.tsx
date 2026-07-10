import { Box, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Paper, Stack, Tooltip } from "@mui/material";
import { ImagePlus, Paperclip, Send, Square } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { PartComposer, type PartComposerHandle } from "./PartComposer";
import type { RuntimePart } from "./prosemirror/part-serialization";

interface AgentComposerProps {
  parts: RuntimePart[];
  isStreaming: boolean;
  focusToken?: number;
  onPartsChange: (parts: RuntimePart[]) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onUploadImage?: (file: File) => Promise<RuntimePart>;
  onUploadDocument?: (file: File) => Promise<RuntimePart>;
  onUploadError?: (message: string | null) => void;
}

export function AgentComposer(props: AgentComposerProps) {
  const composerRef = useRef<PartComposerHandle | null>(null);
  const attachmentMenuId = useId();
  const [attachmentMenuAnchor, setAttachmentMenuAnchor] = useState<HTMLElement | null>(null);
  const isUploading = hasUploadingParts(props.parts);
  const canSubmit = !isUploading && hasSubmittableParts(props.parts);
  const canAttach = Boolean(props.onUploadImage || props.onUploadDocument);
  const isAttachmentMenuOpen = Boolean(attachmentMenuAnchor);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    props.onSubmit();
  }

  function handleComposerSubmit() {
    if (!canSubmit) {
      return;
    }

    props.onSubmit();
  }

  function handleAttachmentMenuOpen(event: MouseEvent<HTMLButtonElement>) {
    setAttachmentMenuAnchor(event.currentTarget);
  }

  function handleAttachmentMenuClose() {
    setAttachmentMenuAnchor(null);
  }

  function handleAttachmentSelect(kind: "image" | "document") {
    handleAttachmentMenuClose();

    if (kind === "image") {
      composerRef.current?.openImagePicker();
      return;
    }

    composerRef.current?.openDocumentPicker();
  }

  const submitButtonLabel = props.isStreaming ? "停止" : "发送";

  return (
    <Paper
      component="form"
      className={`chat-composer composer-shell${props.isStreaming ? " is-streaming" : ""}${isUploading ? " is-uploading" : ""}`}
      elevation={0}
      aria-busy={isUploading}
      onSubmit={handleSubmit}
    >
      <PartComposer
        ref={composerRef}
        parts={props.parts}
        focusToken={props.focusToken}
        onChange={props.onPartsChange}
        onSubmit={handleComposerSubmit}
        onCancel={props.onCancel}
        onUploadImage={props.onUploadImage}
        onUploadDocument={props.onUploadDocument}
        onUploadError={props.onUploadError}
      />

      <Stack className="composer-toolbar" direction="row" spacing={1}>
        <Tooltip title="添加附件">
          <span>
            <IconButton
              aria-label="添加附件"
              aria-controls={isAttachmentMenuOpen ? attachmentMenuId : undefined}
              aria-expanded={isAttachmentMenuOpen ? "true" : undefined}
              aria-haspopup="menu"
              className="composer-icon-button composer-attachment-button"
              disabled={!canAttach}
              onClick={handleAttachmentMenuOpen}
              size="small"
              type="button"
            >
              <Paperclip className="composer-attachment-button-icon" size={18} />
            </IconButton>
          </span>
        </Tooltip>

        <Menu
          id={attachmentMenuId}
          anchorEl={attachmentMenuAnchor}
          anchorOrigin={{ vertical: "top", horizontal: "left" }}
          className="composer-attachment-menu"
          open={isAttachmentMenuOpen}
          slotProps={{ list: { "aria-label": "选择附件类型", className: "composer-attachment-menu-list" } }}
          transformOrigin={{ vertical: "bottom", horizontal: "left" }}
          onClose={handleAttachmentMenuClose}
        >
          <MenuItem
            className="composer-attachment-menu-item"
            disabled={!props.onUploadImage}
            onClick={() => handleAttachmentSelect("image")}
          >
            <ListItemIcon className="composer-attachment-menu-icon">
              <ImagePlus size={18} />
            </ListItemIcon>
            <ListItemText primary="上传图片" />
          </MenuItem>
          <MenuItem
            className="composer-attachment-menu-item"
            disabled={!props.onUploadDocument}
            onClick={() => handleAttachmentSelect("document")}
          >
            <ListItemIcon className="composer-attachment-menu-icon">
              <Paperclip size={18} />
            </ListItemIcon>
            <ListItemText primary="上传文档" />
          </MenuItem>
        </Menu>

        <Box aria-hidden="true" className="composer-hint composer-shortcut-hint" component="span">
          <span className="composer-shortcut-item">
            <kbd className="composer-shortcut-key">Enter</kbd>
            <span>发送</span>
          </span>
          <span className="composer-shortcut-divider">·</span>
          <span className="composer-shortcut-item">
            <kbd className="composer-shortcut-key">Shift + Enter</kbd>
            <span>换行</span>
          </span>
        </Box>

        <Box className="composer-spacer" />
        <Tooltip title={submitButtonLabel}>
          <span>
            <IconButton
              className={`primary-button composer-submit-button ${props.isStreaming ? "stop" : "send"}`}
              type={props.isStreaming ? "button" : "submit"}
              size="small"
              aria-label={submitButtonLabel}
              disabled={!props.isStreaming && !canSubmit}
              onClick={props.isStreaming ? props.onCancel : undefined}
            >
              {props.isStreaming ? <Square size={18} /> : <Send size={18} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    </Paper>
  );
}

function hasSubmittableParts(parts: RuntimePart[]) {
  return parts.some((part) => part.type === "resource" || (part.type === "text" && part.value.trim().length > 0));
}

function hasUploadingParts(parts: RuntimePart[]) {
  return parts.some((part) => part.type === "resource" && getRuntimeBoolean(part, "$uploading"));
}

function getRuntimeBoolean(part: RuntimePart, key: `$${string}`) {
  const value = (part as Record<`$${string}`, unknown>)[key];
  return value === true;
}
