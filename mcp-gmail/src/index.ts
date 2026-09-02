#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { GmailClient } from './gmail-client.js';
import { authenticate, isAuthenticated, listAccounts } from './auth.js';

const server = new Server(
  { name: 'cyberlife-gmail-mcp', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } }
);

// Cache clients per account
const clients = new Map<string, GmailClient>();

async function getClient(account: string = 'default'): Promise<GmailClient> {
  if (!clients.has(account)) {
    const client = new GmailClient(account);
    await client.init();
    clients.set(account, client);
  }
  return clients.get(account)!;
}

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'gmail_auth',
        description: 'Accounts are managed by Cyber Life (Settings → Gmail). This tool only reports how to enable them.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account name/alias (e.g., "personal", "work"). Default: "default"',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_status',
        description: 'Check Gmail connection status and list authenticated accounts.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account to check. If not provided, lists all accounts.',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_inbox',
        description: 'Get recent emails from inbox.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of emails to return (default: 10)',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_search',
        description: 'Search emails with Gmail query syntax (e.g., "from:john subject:meeting is:unread").',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            query: {
              type: 'string',
              description: 'Gmail search query',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of emails to return (default: 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'gmail_read',
        description: 'Read full email content by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Email ID to read',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'gmail_send',
        description: 'Send an email.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            to: {
              type: 'string',
              description: 'Recipient email address',
            },
            subject: {
              type: 'string',
              description: 'Email subject',
            },
            body: {
              type: 'string',
              description: 'Email body (plain text)',
            },
            cc: {
              type: 'string',
              description: 'CC recipients (optional)',
            },
            bcc: {
              type: 'string',
              description: 'BCC recipients (optional)',
            },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      {
        name: 'gmail_reply',
        description: 'Reply to an email.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Email ID to reply to',
            },
            body: {
              type: 'string',
              description: 'Reply body (plain text)',
            },
          },
          required: ['id', 'body'],
        },
      },
      {
        name: 'gmail_draft_reply',
        description: 'Create a REPLY DRAFT in the same thread (does not send). Use when the user wants to review/edit before sending.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Email ID to draft a reply to',
            },
            body: {
              type: 'string',
              description: 'Reply body (plain text)',
            },
          },
          required: ['id', 'body'],
        },
      },
      {
        name: 'gmail_create_draft',
        description: 'Create a new email DRAFT (does not send).',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            to: {
              type: 'string',
              description: 'Recipient email address',
            },
            subject: {
              type: 'string',
              description: 'Email subject',
            },
            body: {
              type: 'string',
              description: 'Email body (plain text)',
            },
            cc: {
              type: 'string',
              description: 'CC recipients (optional)',
            },
            bcc: {
              type: 'string',
              description: 'BCC recipients (optional)',
            },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      {
        name: 'gmail_modify',
        description: 'Change labels of an email: mark read/unread, archive (remove from inbox), add/remove label ids. Reversible, unlike gmail_trash.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Email ID',
            },
            markRead: { type: 'boolean', description: 'Remove the UNREAD label' },
            markUnread: { type: 'boolean', description: 'Add the UNREAD label' },
            archive: { type: 'boolean', description: 'Remove the INBOX label (Gmail archive)' },
            addLabels: { type: 'array', items: { type: 'string' }, description: 'Label ids to add (see gmail_list_labels)' },
            removeLabels: { type: 'array', items: { type: 'string' }, description: 'Label ids to remove' },
          },
          required: ['id'],
        },
      },
      {
        name: 'gmail_trash',
        description: 'Move an email to trash.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Email ID to trash',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'gmail_list_filters',
        description: 'List all Gmail filters configured for the account.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_get_filter',
        description: 'Get details of a specific Gmail filter by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Filter ID',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'gmail_create_filter',
        description: 'Create a new Gmail filter. Use gmail_list_labels to get label IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            from: {
              type: 'string',
              description: 'Filter emails from this sender',
            },
            to: {
              type: 'string',
              description: 'Filter emails to this recipient',
            },
            subject: {
              type: 'string',
              description: 'Filter emails with this subject',
            },
            query: {
              type: 'string',
              description: 'Gmail search query for matching',
            },
            hasAttachment: {
              type: 'boolean',
              description: 'Filter emails with attachments',
            },
            addLabelIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Label IDs to add to matching emails',
            },
            removeLabelIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Label IDs to remove from matching emails',
            },
            forward: {
              type: 'string',
              description: 'Forward matching emails to this address',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_delete_filter',
        description: 'Delete a Gmail filter by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Filter ID to delete',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'gmail_list_labels',
        description: 'List all Gmail labels. Useful for getting label IDs when creating filters.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
          },
          required: [],
        },
      },
      {
        name: 'gmail_create_label',
        description: 'Create a new Gmail label. Use "/" for nested labels (e.g., "Parent/Child").',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            name: {
              type: 'string',
              description: 'Label name. Use "/" for nested labels (e.g., "Work/Projects")',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'gmail_delete_label',
        description: 'Delete a Gmail label by ID.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: 'Account email as shown in Cyber Life (default: first MCP-enabled account)',
            },
            id: {
              type: 'string',
              description: 'Label ID to delete',
            },
          },
          required: ['id'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'gmail_auth': {
        const { account = 'default' } = args as { account?: string };

        if (await isAuthenticated(account)) {
          const client = await getClient(account);
          const profile = await client.getProfile();
          return {
            content: [{
              type: 'text',
              text: `Already authenticated as ${profile?.email || account}`,
            }],
          };
        }

        const result = await authenticate(account);
        if (result.success) {
          // Reinitialize client with new credentials
          clients.delete(account);
          await getClient(account);
        }

        return {
          content: [{
            type: 'text',
            text: result.message,
          }],
          isError: !result.success,
        };
      }

      case 'gmail_status': {
        const { account } = args as { account?: string };

        if (account) {
          const authed = await isAuthenticated(account);
          if (authed) {
            const client = await getClient(account);
            const profile = await client.getProfile();
            return {
              content: [{
                type: 'text',
                text: `Account "${account}": Connected as ${profile?.email}\nTotal messages: ${profile?.messagesTotal}`,
              }],
            };
          }
          return {
            content: [{
              type: 'text',
              text: `Account "${account}": Not authenticated. Use gmail_auth to connect.`,
            }],
          };
        }

        const accounts = await listAccounts();
        if (accounts.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No Gmail accounts configured.\nUse gmail_auth to connect an account.',
            }],
          };
        }

        const statuses: string[] = [];
        for (const acc of accounts) {
          const authed = await isAuthenticated(acc);
          if (authed) {
            const client = await getClient(acc);
            const profile = await client.getProfile();
            statuses.push(`• ${acc}: ${profile?.email || 'connected'}`);
          } else {
            statuses.push(`• ${acc}: not authenticated`);
          }
        }

        return {
          content: [{
            type: 'text',
            text: `Gmail accounts:\n${statuses.join('\n')}`,
          }],
        };
      }

      case 'gmail_inbox': {
        const { account = 'default', limit = 10 } = args as { account?: string; limit?: number };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const emails = await client.listEmails({ maxResults: limit });

        if (emails.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No emails in inbox.',
            }],
          };
        }

        const formatted = emails.map((e, i) => {
          const unread = e.isUnread ? '●' : '○';
          return `${unread} [${e.id}]\n  From: ${e.from}\n  Subject: ${e.subject}\n  Date: ${e.date}\n  ${e.snippet.substring(0, 100)}...`;
        });

        return {
          content: [{
            type: 'text',
            text: `Inbox (${emails.length} emails):\n\n${formatted.join('\n\n')}`,
          }],
        };
      }

      case 'gmail_search': {
        const { account = 'default', query, limit = 10 } = args as {
          account?: string;
          query: string;
          limit?: number;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const emails = await client.searchEmails(query, limit);

        if (emails.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `No emails found for query: ${query}`,
            }],
          };
        }

        const formatted = emails.map((e) => {
          const unread = e.isUnread ? '●' : '○';
          return `${unread} [${e.id}]\n  From: ${e.from}\n  Subject: ${e.subject}\n  Date: ${e.date}`;
        });

        return {
          content: [{
            type: 'text',
            text: `Search results for "${query}" (${emails.length}):\n\n${formatted.join('\n\n')}`,
          }],
        };
      }

      case 'gmail_read': {
        const { account = 'default', id } = args as { account?: string; id: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const email = await client.getEmail(id, true);

        if (!email) {
          return {
            content: [{
              type: 'text',
              text: `Email not found: ${id}`,
            }],
            isError: true,
          };
        }

        // Mark as read
        await client.markAsRead(id);

        return {
          content: [{
            type: 'text',
            text: `From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\n\n---\n\n${email.body}`,
          }],
        };
      }

      case 'gmail_send': {
        const { account = 'default', to, subject, body, cc, bcc } = args as {
          account?: string;
          to: string;
          subject: string;
          body: string;
          cc?: string;
          bcc?: string;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.sendEmail({ to, subject, body, cc, bcc });

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Email sent successfully!\nTo: ${to}\nSubject: ${subject}\nMessage ID: ${result.messageId}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Failed to send email: ${result.error}`,
          }],
          isError: true,
        };
      }

      case 'gmail_reply': {
        const { account = 'default', id, body } = args as {
          account?: string;
          id: string;
          body: string;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.replyToEmail(id, body);

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Reply sent successfully!\nMessage ID: ${result.messageId}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Failed to reply: ${result.error}`,
          }],
          isError: true,
        };
      }

      case 'gmail_draft_reply': {
        const { account = 'default', id, body } = args as {
          account?: string;
          id: string;
          body: string;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.draftReply(id, body);

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Reply draft created (not sent).\nDraft ID: ${result.draftId}`,
            }],
          };
        }
        return {
          content: [{ type: 'text', text: `Failed to create reply draft: ${result.error}` }],
          isError: true,
        };
      }

      case 'gmail_create_draft': {
        const { account = 'default', to, subject, body, cc, bcc } = args as {
          account?: string;
          to: string;
          subject: string;
          body: string;
          cc?: string;
          bcc?: string;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.createDraft({ to, subject, body, cc, bcc });

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Draft created (not sent).\nDraft ID: ${result.draftId}`,
            }],
          };
        }
        return {
          content: [{ type: 'text', text: `Failed to create draft: ${result.error}` }],
          isError: true,
        };
      }

      case 'gmail_modify': {
        const { account = 'default', id, markRead, markUnread, archive, addLabels = [], removeLabels = [] } = args as {
          account?: string; id: string; markRead?: boolean; markUnread?: boolean; archive?: boolean; addLabels?: string[]; removeLabels?: string[];
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const add = [...addLabels];
        const remove = [...removeLabels];
        if (markRead) remove.push('UNREAD');
        if (markUnread) add.push('UNREAD');
        if (archive) remove.push('INBOX');

        const client = await getClient(account);
        const success = await client.modifyLabels(id, add, remove);

        return {
          content: [{
            type: 'text',
            text: success
              ? `Email updated (added: ${add.join(', ') || '-'}; removed: ${remove.join(', ') || '-'}).`
              : 'Failed to modify email.',
          }],
          isError: !success,
        };
      }

      case 'gmail_trash': {
        const { account = 'default', id } = args as { account?: string; id: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const success = await client.trash(id);

        return {
          content: [{
            type: 'text',
            text: success ? `Email moved to trash.` : `Failed to trash email.`,
          }],
          isError: !success,
        };
      }

      case 'gmail_list_filters': {
        const { account = 'default' } = args as { account?: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const filters = await client.listFilters();

        if (filters.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No filters configured.',
            }],
          };
        }

        const formatted = filters.map((f, i) => {
          const criteria: string[] = [];
          if (f.criteria.from) criteria.push(`from:${f.criteria.from}`);
          if (f.criteria.to) criteria.push(`to:${f.criteria.to}`);
          if (f.criteria.subject) criteria.push(`subject:${f.criteria.subject}`);
          if (f.criteria.query) criteria.push(`query:${f.criteria.query}`);
          if (f.criteria.hasAttachment) criteria.push('has:attachment');

          const actions: string[] = [];
          if (f.actions.addLabelIds?.length) actions.push(`+labels: ${f.actions.addLabelIds.join(', ')}`);
          if (f.actions.removeLabelIds?.length) actions.push(`-labels: ${f.actions.removeLabelIds.join(', ')}`);
          if (f.actions.forward) actions.push(`forward: ${f.actions.forward}`);

          return `[${f.id}]\n  Criteria: ${criteria.join(' AND ') || 'none'}\n  Actions: ${actions.join('; ') || 'none'}`;
        });

        return {
          content: [{
            type: 'text',
            text: `Gmail Filters (${filters.length}):\n\n${formatted.join('\n\n')}`,
          }],
        };
      }

      case 'gmail_get_filter': {
        const { account = 'default', id } = args as { account?: string; id: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const filter = await client.getFilter(id);

        if (!filter) {
          return {
            content: [{
              type: 'text',
              text: `Filter not found: ${id}`,
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Filter: ${filter.id}\n\nCriteria:\n${JSON.stringify(filter.criteria, null, 2)}\n\nActions:\n${JSON.stringify(filter.actions, null, 2)}`,
          }],
        };
      }

      case 'gmail_create_filter': {
        const { account = 'default', ...filterOptions } = args as {
          account?: string;
          from?: string;
          to?: string;
          subject?: string;
          query?: string;
          hasAttachment?: boolean;
          addLabelIds?: string[];
          removeLabelIds?: string[];
          forward?: string;
        };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.createFilter(filterOptions);

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Filter created successfully!\nFilter ID: ${result.filterId}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Failed to create filter: ${result.error}`,
          }],
          isError: true,
        };
      }

      case 'gmail_delete_filter': {
        const { account = 'default', id } = args as { account?: string; id: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const success = await client.deleteFilter(id);

        return {
          content: [{
            type: 'text',
            text: success ? `Filter deleted successfully.` : `Failed to delete filter.`,
          }],
          isError: !success,
        };
      }

      case 'gmail_list_labels': {
        const { account = 'default' } = args as { account?: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const labels = await client.listLabels();

        if (labels.length === 0) {
          return {
            content: [{
              type: 'text',
              text: 'No labels found.',
            }],
          };
        }

        const system = labels.filter(l => l.type === 'system');
        const user = labels.filter(l => l.type === 'user');

        let output = 'Gmail Labels:\n\n';

        if (user.length > 0) {
          output += 'User Labels:\n';
          output += user.map(l => `  • ${l.name} (${l.id})`).join('\n');
          output += '\n\n';
        }

        output += 'System Labels:\n';
        output += system.map(l => `  • ${l.name} (${l.id})`).join('\n');

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'gmail_create_label': {
        const { account = 'default', name: labelName } = args as { account?: string; name: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const result = await client.createLabel(labelName);

        if (result.success) {
          return {
            content: [{
              type: 'text',
              text: `Label "${labelName}" created successfully. ID: ${result.labelId}`,
            }],
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: `Failed to create label: ${result.error}`,
            }],
            isError: true,
          };
        }
      }

      case 'gmail_delete_label': {
        const { account = 'default', id } = args as { account?: string; id: string };

        if (!(await isAuthenticated(account))) {
          return {
            content: [{
              type: 'text',
              text: `Account "${account}" not authenticated. Use gmail_auth first.`,
            }],
            isError: true,
          };
        }

        const client = await getClient(account);
        const success = await client.deleteLabel(id);

        return {
          content: [{
            type: 'text',
            text: success ? `Label deleted successfully.` : `Failed to delete label.`,
          }],
          isError: !success,
        };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${name}`,
          }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Gmail MCP server started');
}

main().catch(console.error);
