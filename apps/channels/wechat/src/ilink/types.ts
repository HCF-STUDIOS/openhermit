/**
 * iLink wire types — trimmed to what the text-only v0 needs.
 *
 * Field names mirror Tencent's iLink protocol (snake_case in JSON over HTTP).
 * Media types (image/voice/file/video) are intentionally omitted; v0
 * ignores inbound media and never emits it.
 */

/** Common request metadata attached to every CGI request. */
export interface BaseInfo {
  channel_version?: string;
  /** Self-declared upstream identity, analogous to HTTP `User-Agent`. */
  bot_agent?: string;
}

/** Item type discriminator on `MessageItem`. */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** `WeixinMessage.message_type` — 1 = inbound from user, 2 = our reply. */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** `MessageItem.text_item` — the only item shape we read/write in v0. */
export interface TextItem {
  text?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  /** Other item shapes (image_item/voice_item/file_item/video_item) intentionally untyped here. */
  [key: string]: unknown;
}

/** Unified inbound/outbound envelope (iLink: `WeixinMessage`). */
export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesReq {
  /** Opaque server cursor; send "" on first request or after reset. */
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next getUpdates long-poll. */
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface NotifyStartResp {
  ret?: number;
  errmsg?: string;
}

export interface NotifyStopResp {
  ret?: number;
  errmsg?: string;
}

// ─── QR login wire types ──────────────────────────────────────────────

export type QrLoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrCodeResponse {
  qrcode: string;
  /** URL string the user opens (or that the UI encodes as a QR). */
  qrcode_img_content: string;
}

export interface QrStatusResponse {
  status: QrLoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  /** New host to redirect polling to when status is scaned_but_redirect. */
  redirect_host?: string;
}
