import { Box, Button, Chip, Divider, List, ListItemButton, ListItemText, TextField, Typography } from "@mui/material";
import { MessageCircle, Plus, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

export interface SessionHistoryItem {
  id: string;
  title: string;
  status?: "running" | "completed" | "failed";
}

interface SessionSidebarProps {
  activeSessionId?: string;
  health: string;
  historyItems: SessionHistoryItem[];
  isBusy: boolean;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
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
  isBusy,
  onNewSession,
  onSelectSession
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();

    if (!keyword) {
      return historyItems;
    }

    return historyItems.filter((item) => item.title.toLowerCase().includes(keyword));
  }, [historyItems, query]);

  return (
    <Box component="aside" className="session-sidebar">
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

      <List className="session-history-list" disablePadding>
        {filteredItems.length > 0 ? (
          filteredItems.map((item) => {
            const statusLabel = getStatusLabel(item.status);

            return (
              <ListItemButton
                className="session-history-item"
                key={item.id}
                selected={item.id === activeSessionId}
                disabled={isBusy}
                onClick={() => onSelectSession(item.id)}
              >
                <MessageCircle size={15} />
                <ListItemText primary={item.title} />
                {statusLabel ? <Chip className={`session-status ${item.status}`} size="small" label={statusLabel} /> : null}
              </ListItemButton>
            );
          })
        ) : (
          <Box className="session-history-empty">暂无会话记录</Box>
        )}
      </List>

      <Box className="sidebar-footer">
        <Chip className={health === "正常" ? "status ok" : "status"} color={health === "正常" ? "primary" : "default"} label={`API ${health}`} />
      </Box>
    </Box>
  );
}
