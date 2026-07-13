export type PlaceholderType = "text" | "input" | "select" | "image" | "video" | "document" | "skill";
export type LifecycleState = "pending" | "succeeded" | "failed";

export interface PlaceholderOption {
  label: string;
  value: string;
  icon?: string;
}

export interface PartExtra {
  placeholder?: {
    type: PlaceholderType;
    label: string;
    defaultValue?: string;
    options?: PlaceholderOption[];
    removable?: boolean;
    emphasize?: boolean;
    code?: string;
    icon?: string;
    guide?: {
      description?: string;
      image?: string;
      video?: string;
    };
    [key: string]: unknown;
  };
  lifecycle?: {
    state: LifecycleState;
    error?: {
      code: string;
      message: string;
    };
  };
  tool?: {
    name: string;
    toolCallId: string;
    toolCallRowId?: string;
    outputIndex?: number;
  };
  resource?: {
    id: string;
  };
  generation?: {
    prompt?: string;
    provider?: string;
    model?: string;
  };
  [key: string]: unknown;
}

export interface TextPart {
  type: "text";
  value: string;
  extra?: PartExtra;
}

export interface ResourcePart {
  type: "resource";
  mime?: string;
  url?: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  extra?: PartExtra;
}

export type MessagePart = TextPart | ResourcePart;
