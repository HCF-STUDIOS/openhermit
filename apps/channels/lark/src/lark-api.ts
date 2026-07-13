/**
 * Thin wrapper around the official `@larksuiteoapi/node-sdk` REST client.
 * The SDK manages `tenant_access_token` acquisition/refresh internally.
 */
import { Client, Domain, LoggerLevel } from '@larksuiteoapi/node-sdk';

export interface LarkBotInfo {
  openId: string | undefined;
  appName: string | undefined;
}

export class LarkApi {
  readonly client: Client;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly domainKey: 'feishu' | 'lark',
    private readonly log: (message: string) => void = () => {},
  ) {
    this.client = new Client({
      appId,
      appSecret,
      domain: domainKey === 'lark' ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.error,
    });
  }

  get domain(): 'feishu' | 'lark' {
    return this.domainKey;
  }

  /** GET /open-apis/bot/v3/info — the bot's own open_id (for @mention gating). */
  async getBotInfo(): Promise<LarkBotInfo> {
    const res = await this.client.request<{
      bot?: { open_id?: string; app_name?: string };
    }>({ method: 'GET', url: '/open-apis/bot/v3/info' });
    const bot = (res as { bot?: { open_id?: string; app_name?: string } }).bot;
    return { openId: bot?.open_id, appName: bot?.app_name };
  }

  /** Send a plain text message to a chat. Returns the message_id. */
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return res.data?.message_id;
  }

  /** Send a previously uploaded image by key. */
  async sendImage(chatId: string, imageKey: string): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    return res.data?.message_id;
  }

  /** Send a previously uploaded file by key. */
  async sendFile(chatId: string, fileKey: string): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    return res.data?.message_id;
  }

  /** Upload image bytes for messaging. Returns the image_key. */
  async uploadImage(bytes: Uint8Array): Promise<string | undefined> {
    const res = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: Buffer.from(bytes),
      },
    });
    return res?.image_key;
  }

  /** Upload file bytes for messaging. Returns the file_key. */
  async uploadFile(bytes: Uint8Array, fileName: string): Promise<string | undefined> {
    const res = await this.client.im.v1.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: Buffer.from(bytes),
      },
    });
    return res?.file_key;
  }

  /**
   * Download an inbound message resource (image or file) as bytes.
   * `type` must be `image` for image messages and `file` otherwise.
   */
  async downloadResource(
    messageId: string,
    key: string,
    type: 'image' | 'file',
  ): Promise<Uint8Array> {
    const res = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: key },
      params: { type },
    });
    // The SDK wraps binary endpoints in a readable-stream helper.
    const streamHolder = res as unknown as {
      getReadableStream?: () => NodeJS.ReadableStream;
    };
    if (typeof streamHolder.getReadableStream !== 'function') {
      throw new Error('lark resource download: SDK response has no readable stream');
    }
    const stream = streamHolder.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }
}
