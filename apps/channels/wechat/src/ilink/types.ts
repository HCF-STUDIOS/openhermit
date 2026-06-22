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

/** `MessageItem.text_item`. */
export interface TextItem {
  text?: string;
}

/**
 * CDN media reference. `aes_key` is base64 in JSON; `full_url` (when present)
 * is a complete download URL, otherwise the client builds one from a CDN base.
 * Shape ported from Tencent's MIT-licensed `openclaw-weixin` (`api/types.ts`).
 */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = fileid only, 1 = packed thumbnail/preview info. */
  encrypt_type?: number;
  /** Complete download URL returned by the server (no client assembly needed). */
  full_url?: string;
}

/** `MessageItem.image_item` — inbound photo (also used for outbound). */
export interface ImageItem {
  /** Full-resolution CDN reference. */
  media?: CDNMedia;
  /** Thumbnail CDN reference. */
  thumb_media?: CDNMedia;
  /** Raw AES-128 key as a hex string (16 bytes); preferred over `media.aes_key`. */
  aeskey?: string;
  url?: string;
  hd_size?: number;
  /** Outbound: ciphertext size of the uploaded image. */
  mid_size?: number;
}

/** `MessageItem.video_item` — outbound video. */
export interface VideoItem {
  media?: CDNMedia;
  /** Ciphertext size of the uploaded video. */
  video_size?: number;
}

/** `MessageItem.file_item` — outbound file attachment (any document). */
export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  /** Plaintext byte size, as a string. */
  len?: string;
}

/** `VoiceItem.encode_type` — audio codec. WeChat voice notes are SILK (6). */
export const VoiceEncodeType = {
  PCM: 1,
  ADPCM: 2,
  FEATURE: 3,
  SPEEX: 4,
  AMR: 5,
  SILK: 6,
  MP3: 7,
  OGG_SPEEX: 8,
} as const;

/**
 * `MessageItem.voice_item` — inbound voice note. Shape ported from Tencent's
 * MIT `openclaw-weixin` (`src/api/types.ts`). Unlike `ImageItem`, voice carries
 * its AES key only inside `media.aes_key` (base64) — there is no top-level hex
 * `aeskey`. WeChat sometimes pre-transcribes the clip into `text`.
 */
export interface VoiceItem {
  /** CDN reference to the encrypted audio bytes. */
  media?: CDNMedia;
  /** Codec, see {@link VoiceEncodeType}; WeChat voice notes are `SILK` (6). */
  encode_type?: number;
  bits_per_sample?: number;
  /** Sample rate in Hz (WeChat SILK voice notes are 24000). */
  sample_rate?: number;
  /** Clip length in milliseconds. */
  playtime?: number;
  /** WeChat-side speech-to-text result, when present. */
  text?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  video_item?: VideoItem;
  file_item?: FileItem;
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

/** `ilink/bot/sendmessage` response. A non-zero `ret`/`errcode` means the
 * server rejected the message even though the HTTP status was 200. */
export interface SendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** `GetUploadUrlReq.media_type` — kind of media being uploaded to the CDN. */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/**
 * Request a CDN upload slot (`ilink/bot/getuploadurl`). The bytes are
 * AES-128-ECB encrypted before upload, so both the plaintext size/md5 and the
 * ciphertext size are declared. Shape ported from Tencent's MIT `openclaw-weixin`
 * (`src/api/types.ts`).
 */
export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  /** Plaintext size in bytes. */
  rawsize?: number;
  /** Plaintext MD5 (hex). */
  rawfilemd5?: string;
  /** Ciphertext size after AES-128-ECB + PKCS7 padding. */
  filesize?: number;
  no_need_thumb?: boolean;
  /** Encryption key as a hex string (32 chars / 16 bytes). */
  aeskey?: string;
}

export interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  thumb_upload_param?: string;
  /** Complete upload URL; preferred over assembling from `upload_param`. */
  upload_full_url?: string;
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
