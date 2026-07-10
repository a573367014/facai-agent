import { Box, Button, Chip, Divider, IconButton, List, ListItemButton, ListItemText, TextField, Tooltip, Typography } from "@mui/material";
import { Github, LogOut, MessageCircle, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState, type UIEvent } from "react";

export interface SessionHistoryItem {
  id: string;
  title: string;
  status?: "running" | "completed" | "failed";
}

interface SessionSidebarProps {
  activeSessionId?: string;
  historyItems: SessionHistoryItem[];
  isCollapsed: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  deletingSessionIds: Set<string>;
  githubLogin?: string;
  isGithubLoginConfigured: boolean;
  onNewSession: () => void;
  onCollapse?: () => void;
  onSelectSession: (sessionId: string) => void;
  onLoadMoreSessions: () => void;
  onDeleteSession: (sessionId: string) => void;
  onGithubLogin: () => void;
  onLogout: () => void;
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
  historyItems,
  isCollapsed,
  hasMoreSessions,
  isLoadingMoreSessions,
  deletingSessionIds,
  githubLogin,
  isGithubLoginConfigured,
  onNewSession,
  onCollapse,
  onSelectSession,
  onLoadMoreSessions,
  onDeleteSession,
  onGithubLogin,
  onLogout
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
    <Box
      component="aside"
      className={isCollapsed ? "session-sidebar collapsed" : "session-sidebar"}
      aria-hidden={isCollapsed ? true : undefined}
      aria-label="会话导航"
    >
      <Box className="session-sidebar-content">
        <Box component="header" className="sidebar-header">
          <Box className="sidebar-brand">
            <Box className="sidebar-avatar" aria-hidden="true">
              <Sparkles size={17} />
            </Box>
            <Typography component="strong">发财 Agent</Typography>
          </Box>
          {onCollapse ? (
            <IconButton
              aria-label="关闭会话导航"
              className="sidebar-close-button"
              onClick={onCollapse}
              size="small"
              type="button"
            >
              <X size={18} />
            </IconButton>
          ) : null}
        </Box>

        <Box className="sidebar-primary-action">
          <Button className="new-session-button" type="button" variant="contained" startIcon={<Plus size={17} />} onClick={onNewSession}>
            新建会话
          </Button>
        </Box>

        <Box className="sidebar-search">
          <Search size={16} aria-hidden="true" />
          <TextField
            aria-label="搜索会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            variant="standard"
            fullWidth
          />
        </Box>

        <Divider className="sidebar-divider" />

        <Box component="nav" className="sidebar-history" aria-label="历史对话">
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
                      disabled={isDeleting}
                      onClick={() => onSelectSession(item.id)}
                    >
                      <MessageCircle size={15} aria-hidden="true" />
                      <ListItemText primary={item.title} />
                      {statusLabel ? <Chip className={`session-status ${item.status}`} size="small" label={statusLabel} /> : null}
                    </ListItemButton>
                    <IconButton
                      aria-label={`删除会话：${item.title}`}
                      className="session-delete-button"
                      disabled={isDeleting}
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
        </Box>

        <Box className="sidebar-footer">
          {githubLogin ? (
            <Box className="sidebar-user-card">
              <Box className="sidebar-user-avatar" aria-hidden="true">
                <Github size={17} />
              </Box>
              <Box className="sidebar-user-copy">
                <Typography component="strong">@{githubLogin}</Typography>
                <Typography component="span">GitHub 账户</Typography>
              </Box>
              <Tooltip title="退出登录">
                <IconButton aria-label="退出登录" className="sidebar-auth-logout" onClick={onLogout} size="small" type="button">
                  <LogOut size={17} />
                </IconButton>
              </Tooltip>
            </Box>
          ) : (
            <Button
              className="github-login-button sidebar-github-login-button"
              disabled={!isGithubLoginConfigured}
              fullWidth
              onClick={onGithubLogin}
              size="small"
              startIcon={<Github size={16} />}
              type="button"
              variant="outlined"
            >
              GitHub 登录
            </Button>
          )}
        </Box>
      </Box>
    </Box>
  );
}
