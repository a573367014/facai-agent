import { Box, Button, Chip, Divider, IconButton, List, ListItemButton, ListItemText, TextField, Typography } from "@mui/material";
import { MessageCircle, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState, type UIEvent } from "react";

export interface SessionHistoryItem {
  id: string;
  title: string;
  status?: "running" | "completed" | "failed";
}

interface SessionSidebarProps {
  activeSessionId?: string;
  health: string;
  historyItems: SessionHistoryItem[];
  isCollapsed: boolean;
  isBusy: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  deletingSessionIds: Set<string>;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onLoadMoreSessions: () => void;
  onDeleteSession: (sessionId: string) => void;
}

function getStatusLabel(status?: SessionHistoryItem["status"]) {
  if (status === "running") {
    return "进行中";
  }

  if (status === "failed") {
    return "失败";
  }

  return null;
}

export function SessionSidebar({
  activeSessionId,
  health,
  historyItems,
  isCollapsed,
  isBusy,
  hasMoreSessions,
  isLoadingMoreSessions,
  deletingSessionIds,
  onNewSession,
  onSelectSession,
  onLoadMoreSessions,
  onDeleteSession
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    if (!keyword) {
      return historyItems;
    }

    return historyItems.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [historyItems, query]);
  const isFiltering = query.trim().length > 0;

  function handleHistoryScroll(event: UIEvent<HTMLUListElement>) {
    if (isFiltering || !hasMoreSessions || isLoadingMoreSessions) {
      return;
    }

    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;

    if (distanceToBottom <= 48) {
      onLoadMoreSessions();
    }
  }

  return (
    <Box component="aside" className={isCollapsed ? "session-sidebar collapsed" : "session-sidebar"} aria-hidden={isCollapsed ? true : undefined}>
      <Box className="session-sidebar-content">
        <Box className="sidebar-search">
          <Search size={16} aria-hidden="true" />
          <TextField
            aria-label="搜索会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索..."
            variant="standard"
            fullWidth
          />
        </Box>

        <Box className="sidebar-brand">
          <Box className="sidebar-avatar" aria-hidden="true">
            <Sparkles size={17} />
          </Box>
          <Box>
            <Typography component="strong">发财 Agent</Typography>
            <Typography component="p">Fastify 工作台</Typography>
          </Box>
        </Box>

        <Button className="new-session-button" type="button" variant="contained" startIcon={<Plus size={17} />} onClick={onNewSession} disabled={isBusy}>
          新建会话
        </Button>

        <Divider className="sidebar-divider" />

        <Box className="sidebar-history-heading">
          <Typography component="span">历史对话</Typography>
          {activeSessionId ? <Chip size="small" label="当前" /> : null}
        </Box>

        <List className="session-history-list" disablePadding onScroll={handleHistoryScroll}>
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const statusLabel = getStatusLabel(item.status);
              const isDeleting = deletingSessionIds.has(item.id);

              return (
                <Box className={item.id === activeSessionId ? "session-history-row selected" : "session-history-row"} key={item.id}>
                  <ListItemButton
                    aria-label={item.title}
                    className="session-history-item"
                    selected={item.id === activeSessionId}
                    disabled={isBusy || isDeleting}
                    onClick={() => onSelectSession(item.id)}
                  >
                    <MessageCircle size={15} />
                    <ListItemText primary={item.title} />
                    {statusLabel ? <Chip className={`session-status ${item.status}`} size="small" label={statusLabel} /> : null}
                  </ListItemButton>
                  <IconButton
                    aria-label={`删除会话：${item.title}`}
                    className="session-delete-button"
                    disabled={isBusy || isDeleting}
                    onClick={() => onDeleteSession(item.id)}
                    size="small"
                    type="button"
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </Box>
              );
            })
          ) : (
            <Box className="session-history-empty">暂无会话记录</Box>
          )}
          {!isFiltering && isLoadingMoreSessions ? <Box className="session-history-empty">加载更多会话...</Box> : null}
        </List>

        <Box className="sidebar-footer">
          <Chip className={health === "正常" ? "status ok" : "status"} color={health === "正常" ? "primary" : "default"} label={`API ${health}`} />
        </Box>
      </Box>
    </Box>
  );
}
