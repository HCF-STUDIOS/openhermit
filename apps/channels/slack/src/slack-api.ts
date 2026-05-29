import { WebClient } from '@slack/web-api';

/** Bound inbound file downloads so a stalled connection can't block the queue. */
const FILE_DOWNLOAD_TIMEOUT_MS = 15_000;

/** An inbound file shared in a Slack message (bytes behind url_private auth). */
export interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  channel_type?: string;
  files?: SlackFile[];
}

export interface SlackBotInfo {
  id: string;
  name: string;
  user_id: string;
}

export class SlackApi {
  readonly web: WebClient;
  private readonly botToken: string;
  private botInfo: SlackBotInfo | undefined;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.web = new WebClient(botToken);
  }

  /**
   * Download the bytes of an inbound Slack file. `url_private` endpoints
   * require the bot token as a bearer header.
   *
   * When `maxBytes` is given the cap is enforced here, not by the caller:
   * the declared `content-length` is rejected up front, and the body is
   * streamed and aborted the moment it crosses the limit — so an oversized
   * or mislabeled file never fully lands in memory.
   */
  async downloadFile(urlPrivate: string, maxBytes?: number): Promise<Uint8Array> {
    const res = await fetch(urlPrivate, {
      headers: { authorization: `Bearer ${this.botToken}` },
      // Bound the download so a stalled connection can't block the channel queue.
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Slack file download failed (${res.status})`);
    }

    if (maxBytes !== undefined) {
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`Slack file exceeds the ${maxBytes}-byte limit (content-length ${declared})`);
      }
    }

    if (maxBytes === undefined || !res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error(`Slack file exceeds the ${maxBytes}-byte limit (${bytes.byteLength} bytes)`);
      }
      return bytes;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Slack file exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * Upload a file to a channel (and optional thread) via files.uploadV2.
   * `caption` becomes the message's initial comment.
   */
  async uploadFile(
    channel: string,
    file: { bytes: Uint8Array; filename: string; caption?: string; threadTs?: string },
  ): Promise<void> {
    const args: Record<string, unknown> = {
      channel_id: channel,
      file: Buffer.from(file.bytes),
      filename: file.filename,
    };
    if (file.caption) args.initial_comment = file.caption;
    if (file.threadTs) args.thread_ts = file.threadTs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.web.files.uploadV2(args as any);
  }

  async getBotInfo(): Promise<SlackBotInfo> {
    if (this.botInfo) return this.botInfo;
    const result = await this.web.auth.test();
    this.botInfo = {
      id: result.bot_id as string,
      name: result.user as string,
      user_id: result.user_id as string,
    };
    return this.botInfo;
  }

  async sendMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; mrkdwn?: boolean },
  ): Promise<{ ts: string; channel: string }> {
    const args: Record<string, unknown> = {
      channel,
      text,
      mrkdwn: options?.mrkdwn ?? true,
    };
    if (options?.threadTs) args.thread_ts = options.threadTs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.web.chat.postMessage(args as any);
    return { ts: result.ts as string, channel: result.channel as string };
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
  ): Promise<void> {
    await this.web.chat.update({ channel, ts, text });
  }

  async getUserInfo(userId: string): Promise<{ name: string; real_name?: string }> {
    const result = await this.web.users.info({ user: userId });
    const user = result.user as { name?: string; real_name?: string } | undefined;
    const info: { name: string; real_name?: string } = { name: user?.name ?? userId };
    if (user?.real_name) info.real_name = user.real_name;
    return info;
  }

  async getConversationInfo(channelId: string): Promise<{ name?: string; is_im: boolean }> {
    const result = await this.web.conversations.info({ channel: channelId });
    const ch = result.channel as { name?: string; is_im?: boolean } | undefined;
    const info: { name?: string; is_im: boolean } = { is_im: ch?.is_im ?? false };
    if (ch?.name) info.name = ch.name;
    return info;
  }
}
