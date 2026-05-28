/**
 * Minimal Telegram Bot API client. Uses fetch directly — no external library needed.
 * Only implements the methods we actually use.
 */

const BASE_URL = 'https://api.telegram.org';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessageEntity {
  type: string; // 'mention' | 'bot_command' | 'text_mention' | ...
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramApi {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `${BASE_URL}/bot${botToken}`;
    this.fileBaseUrl = `${BASE_URL}/file/bot${botToken}`;
  }

  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(signal ? { signal } : {}),
    };
    if (params) {
      init.body = JSON.stringify(params);
    }
    const response = await fetch(`${this.baseUrl}/${method}`, init);

    const body = (await response.json()) as TelegramApiResponse<T>;

    if (!body.ok) {
      throw new Error(
        `Telegram API error (${method}): ${body.description ?? 'unknown error'}`,
      );
    }

    return body.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe');
  }

  async getUpdates(
    offset?: number,
    timeout = 30,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      ...(offset !== undefined ? { offset } : {}),
      timeout,
      allowed_updates: ['message', 'callback_query'],
    }, signal);
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: {
      parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
      replyMarkup?: unknown;
    },
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' },
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    });
  }

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async sendChatAction(
    chatId: number,
    action: 'typing' = 'typing',
  ): Promise<boolean> {
    return this.call<boolean>('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    options?: { text?: string; showAlert?: boolean },
  ): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(options?.text ? { text: options.text } : {}),
      ...(options?.showAlert ? { show_alert: options.showAlert } : {}),
    });
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup?: unknown,
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url,
      allowed_updates: ['message', 'callback_query'],
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook');
  }

  /**
   * Resolve a file_id to a temporary download path. The path is valid
   * for at least one hour. Combine with `downloadFile` to fetch bytes.
   */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Download bytes for a file previously resolved via `getFile`. The
   * returned bytes are exactly what Telegram has on disk — voice
   * messages are ogg/opus, audio messages may be mp3/m4a/etc.
   */
  async downloadFile(filePath: string): Promise<Uint8Array> {
    const url = `${this.fileBaseUrl}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed (${response.status}) for ${filePath}`);
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Upload media as multipart and call one of the typed Telegram send
   * endpoints (sendPhoto / sendAudio / sendVideo / sendDocument / sendVoice).
   * Centralizes the FormData + Blob plumbing so each variant only has to
   * pick the right endpoint and field name.
   */
  private async sendMediaMultipart(
    endpoint: 'sendPhoto' | 'sendAudio' | 'sendVideo' | 'sendDocument',
    chatId: number,
    fieldName: 'photo' | 'audio' | 'video' | 'document',
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    options?: { caption?: string; replyMarkup?: unknown },
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (options?.caption) form.append('caption', options.caption);
    if (options?.replyMarkup) {
      form.append('reply_markup', JSON.stringify(options.replyMarkup));
    }
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const blob = new Blob([buf], { type: contentType });
    form.append(fieldName, blob, filename);

    const response = await fetch(`${this.baseUrl}/${endpoint}`, {
      method: 'POST',
      body: form,
    });
    const body = (await response.json()) as TelegramApiResponse<TelegramMessage>;
    if (!body.ok) {
      throw new Error(
        `Telegram API error (${endpoint}): ${body.description ?? 'unknown error'}`,
      );
    }
    return body.result;
  }

  async sendPhoto(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    options?: { caption?: string; replyMarkup?: unknown },
  ): Promise<TelegramMessage> {
    return this.sendMediaMultipart(
      'sendPhoto',
      chatId,
      'photo',
      bytes,
      filename,
      contentType,
      options,
    );
  }

  async sendAudio(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    options?: { caption?: string; replyMarkup?: unknown },
  ): Promise<TelegramMessage> {
    return this.sendMediaMultipart(
      'sendAudio',
      chatId,
      'audio',
      bytes,
      filename,
      contentType,
      options,
    );
  }

  async sendVideo(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    options?: { caption?: string; replyMarkup?: unknown },
  ): Promise<TelegramMessage> {
    return this.sendMediaMultipart(
      'sendVideo',
      chatId,
      'video',
      bytes,
      filename,
      contentType,
      options,
    );
  }

  async sendDocument(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    contentType: string,
    options?: { caption?: string; replyMarkup?: unknown },
  ): Promise<TelegramMessage> {
    return this.sendMediaMultipart(
      'sendDocument',
      chatId,
      'document',
      bytes,
      filename,
      contentType,
      options,
    );
  }

  /**
   * Send a voice message. `bytes` must be encoded as ogg with opus codec
   * — Telegram only accepts that format for inline voice playback.
   * Anything else (mp3, m4a, etc.) should go through `sendAudio` instead.
   */
  async sendVoice(
    chatId: number,
    bytes: Uint8Array,
    options?: {
      caption?: string;
      replyMarkup?: unknown;
      duration?: number;
    },
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (options?.caption) form.append('caption', options.caption);
    if (options?.duration !== undefined) {
      form.append('duration', String(options.duration));
    }
    if (options?.replyMarkup) {
      form.append('reply_markup', JSON.stringify(options.replyMarkup));
    }
    // Copy into a fresh ArrayBuffer to satisfy strict Blob typings —
    // Uint8Array's backing buffer may be ArrayBufferLike (incl.
    // SharedArrayBuffer) which BlobPart refuses.
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const blob = new Blob([buf], { type: 'audio/ogg' });
    form.append('voice', blob, 'voice.ogg');

    const response = await fetch(`${this.baseUrl}/sendVoice`, {
      method: 'POST',
      body: form,
    });

    const body = (await response.json()) as TelegramApiResponse<TelegramMessage>;
    if (!body.ok) {
      throw new Error(
        `Telegram API error (sendVoice): ${body.description ?? 'unknown error'}`,
      );
    }
    return body.result;
  }
}
