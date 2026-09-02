import { google, gmail_v1 } from 'googleapis';
import { getOAuth2Client, isAuthenticated } from './auth.js';

export interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body?: string;
  date: string;
  isUnread: boolean;
  labels: string[];
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  isHtml?: boolean;
}

export interface GmailFilter {
  id: string;
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    hasAttachment?: boolean;
    size?: number;
    sizeComparison?: 'larger' | 'smaller';
  };
  actions: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
    markRead?: boolean;
    markImportant?: boolean;
    neverSpam?: boolean;
    trash?: boolean;
    star?: boolean;
  };
}

export interface CreateFilterOptions {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  hasAttachment?: boolean;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
  markRead?: boolean;
  markImportant?: boolean;
  neverSpam?: boolean;
  trash?: boolean;
  star?: boolean;
}

export class GmailClient {
  private account: string;
  private gmail: gmail_v1.Gmail | null = null;

  constructor(account: string = 'default') {
    this.account = account;
  }

  async init(): Promise<boolean> {
    if (!(await isAuthenticated(this.account))) {
      return false;
    }

    const auth = await getOAuth2Client(this.account);
    this.gmail = google.gmail({ version: 'v1', auth });
    return true;
  }

  async getProfile(): Promise<{ email: string; messagesTotal: number } | null> {
    if (!this.gmail) return null;

    try {
      const res = await this.gmail.users.getProfile({ userId: 'me' });
      return {
        email: res.data.emailAddress || '',
        messagesTotal: res.data.messagesTotal || 0,
      };
    } catch (error) {
      console.error('Failed to get profile:', error);
      return null;
    }
  }

  async listEmails(options: {
    maxResults?: number;
    query?: string;
    labelIds?: string[];
  } = {}): Promise<Email[]> {
    if (!this.gmail) return [];

    const { maxResults = 20, query, labelIds = ['INBOX'] } = options;

    try {
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        maxResults,
        q: query,
        labelIds,
      });

      const messages = res.data.messages || [];
      const emails: Email[] = [];

      for (const msg of messages) {
        const email = await this.getEmail(msg.id!);
        if (email) emails.push(email);
      }

      return emails;
    } catch (error) {
      console.error('Failed to list emails:', error);
      return [];
    }
  }

  async getEmail(id: string, includeBody: boolean = false): Promise<Email | null> {
    if (!this.gmail) return null;

    try {
      const res = await this.gmail.users.messages.get({
        userId: 'me',
        id,
        format: includeBody ? 'full' : 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      const headers = res.data.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

      let body = '';
      if (includeBody && res.data.payload) {
        body = this.extractBody(res.data.payload);
      }

      return {
        id: res.data.id || '',
        threadId: res.data.threadId || '',
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        snippet: res.data.snippet || '',
        body,
        date: getHeader('Date'),
        isUnread: res.data.labelIds?.includes('UNREAD') || false,
        labels: res.data.labelIds || [],
      };
    } catch (error) {
      console.error('Failed to get email:', error);
      return null;
    }
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    if (payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Fallback to HTML if no plain text
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Recursive for nested parts
      for (const part of payload.parts) {
        if (part.parts) {
          const body = this.extractBody(part);
          if (body) return body;
        }
      }
    }

    return '';
  }

  async sendEmail(options: SendEmailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    const { to, subject, body, cc, bcc, isHtml = false } = options;

    try {
      const messageParts = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '',
        body,
      ];

      if (cc) messageParts.splice(1, 0, `Cc: ${cc}`);
      if (bcc) messageParts.splice(1, 0, `Bcc: ${bcc}`);

      const message = messageParts.join('\n');
      const encodedMessage = Buffer.from(message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
        },
      });

      return {
        success: true,
        messageId: res.data.id || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async replyToEmail(
    originalId: string,
    body: string,
    options: { replyAll?: boolean } = {}
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    const original = await this.getEmail(originalId, false);
    if (!original) {
      return { success: false, error: 'Original email not found' };
    }

    // Get thread to get proper references
    const thread = await this.gmail.users.threads.get({
      userId: 'me',
      id: original.threadId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'],
    });

    const messages = thread.data.messages || [];
    const lastMessage = messages[messages.length - 1];
    const headers = lastMessage?.payload?.headers || [];
    const messageId = headers.find(h => h.name === 'Message-ID')?.value || '';
    const references = headers.find(h => h.name === 'References')?.value || '';

    const to = original.from; // Reply to sender
    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${references} ${messageId}`.trim(),
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ];

    const message = messageParts.join('\n');
    const encodedMessage = Buffer.from(message)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId: original.threadId,
        },
      });

      return {
        success: true,
        messageId: res.data.id || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async draftReply(
    originalId: string,
    body: string
  ): Promise<{ success: boolean; draftId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    const original = await this.getEmail(originalId, false);
    if (!original) {
      return { success: false, error: 'Original email not found' };
    }

    const thread = await this.gmail.users.threads.get({
      userId: 'me',
      id: original.threadId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References'],
    });

    const messages = thread.data.messages || [];
    const lastMessage = messages[messages.length - 1];
    const headers = lastMessage?.payload?.headers || [];
    const messageId = headers.find(h => h.name === 'Message-ID')?.value || '';
    const references = headers.find(h => h.name === 'References')?.value || '';

    const to = original.from;
    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${references} ${messageId}`.trim(),
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ];

    const encodedMessage = Buffer.from(messageParts.join('\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const res = await this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: encodedMessage,
            threadId: original.threadId,
          },
        },
      });

      return {
        success: true,
        draftId: res.data.id || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async createDraft(options: SendEmailOptions): Promise<{ success: boolean; draftId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    const { to, subject, body, cc, bcc } = options;
    const messageParts = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ];
    if (cc) messageParts.splice(1, 0, `Cc: ${cc}`);
    if (bcc) messageParts.splice(1, 0, `Bcc: ${bcc}`);

    const encodedMessage = Buffer.from(messageParts.join('\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    try {
      const res = await this.gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: encodedMessage } },
      });
      return { success: true, draftId: res.data.id || undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async searchEmails(query: string, maxResults: number = 20): Promise<Email[]> {
    return this.listEmails({ query, maxResults, labelIds: [] });
  }

  async markAsRead(id: string): Promise<boolean> {
    if (!this.gmail) return false;

    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: {
          removeLabelIds: ['UNREAD'],
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async markAsUnread(id: string): Promise<boolean> {
    if (!this.gmail) return false;

    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: {
          addLabelIds: ['UNREAD'],
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  // One modify call for the rule-driven actions: mark read/unread, archive
  // (drop INBOX), custom labels. Gmail applies add + remove atomically.
  async modifyLabels(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<boolean> {
    if (!this.gmail) return false;
    if (!addLabelIds.length && !removeLabelIds.length) return true;

    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds, removeLabelIds },
      });
      return true;
    } catch (error) {
      console.error(`Failed to modify labels of ${id}:`, error);
      return false;
    }
  }

  async trash(id: string): Promise<boolean> {
    if (!this.gmail) return false;

    try {
      await this.gmail.users.messages.trash({
        userId: 'me',
        id,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ========== FILTERS ==========

  async listFilters(): Promise<GmailFilter[]> {
    if (!this.gmail) return [];

    try {
      const res = await this.gmail.users.settings.filters.list({
        userId: 'me',
      });

      const filters = res.data.filter || [];
      return filters.map(f => this.parseFilter(f));
    } catch (error) {
      console.error('Failed to list filters:', error);
      return [];
    }
  }

  async getFilter(id: string): Promise<GmailFilter | null> {
    if (!this.gmail) return null;

    try {
      const res = await this.gmail.users.settings.filters.get({
        userId: 'me',
        id,
      });

      return this.parseFilter(res.data);
    } catch (error) {
      console.error('Failed to get filter:', error);
      return null;
    }
  }

  async createFilter(options: CreateFilterOptions): Promise<{ success: boolean; filterId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const criteria: gmail_v1.Schema$FilterCriteria = {};
      if (options.from) criteria.from = options.from;
      if (options.to) criteria.to = options.to;
      if (options.subject) criteria.subject = options.subject;
      if (options.query) criteria.query = options.query;
      if (options.hasAttachment !== undefined) criteria.hasAttachment = options.hasAttachment;

      const action: gmail_v1.Schema$FilterAction = {};
      if (options.addLabelIds) action.addLabelIds = options.addLabelIds;
      if (options.removeLabelIds) action.removeLabelIds = options.removeLabelIds;
      if (options.forward) action.forward = options.forward;

      const res = await this.gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria,
          action,
        },
      });

      return {
        success: true,
        filterId: res.data.id || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async deleteFilter(id: string): Promise<boolean> {
    if (!this.gmail) return false;

    try {
      await this.gmail.users.settings.filters.delete({
        userId: 'me',
        id,
      });
      return true;
    } catch (error) {
      console.error('Failed to delete filter:', error);
      return false;
    }
  }

  async listLabels(): Promise<{ id: string; name: string; type: string }[]> {
    if (!this.gmail) return [];

    try {
      const res = await this.gmail.users.labels.list({
        userId: 'me',
      });

      return (res.data.labels || []).map(l => ({
        id: l.id || '',
        name: l.name || '',
        type: l.type || '',
      }));
    } catch (error) {
      console.error('Failed to list labels:', error);
      return [];
    }
  }

  async createLabel(name: string): Promise<{ success: boolean; labelId?: string; error?: string }> {
    if (!this.gmail) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const res = await this.gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        },
      });

      return {
        success: true,
        labelId: res.data.id || undefined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async deleteLabel(id: string): Promise<boolean> {
    if (!this.gmail) return false;

    try {
      await this.gmail.users.labels.delete({
        userId: 'me',
        id,
      });
      return true;
    } catch (error) {
      console.error('Failed to delete label:', error);
      return false;
    }
  }

  private parseFilter(f: gmail_v1.Schema$Filter): GmailFilter {
    return {
      id: f.id || '',
      criteria: {
        from: f.criteria?.from ?? undefined,
        to: f.criteria?.to ?? undefined,
        subject: f.criteria?.subject ?? undefined,
        query: f.criteria?.query ?? undefined,
        hasAttachment: f.criteria?.hasAttachment ?? undefined,
        size: f.criteria?.size ?? undefined,
        sizeComparison: (f.criteria?.sizeComparison as 'larger' | 'smaller') ?? undefined,
      },
      actions: {
        addLabelIds: f.action?.addLabelIds ?? undefined,
        removeLabelIds: f.action?.removeLabelIds ?? undefined,
        forward: f.action?.forward ?? undefined,
      },
    };
  }
}
