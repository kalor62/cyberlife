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
export declare class GmailClient {
    private account;
    private gmail;
    constructor(account?: string);
    init(): Promise<boolean>;
    getProfile(): Promise<{
        email: string;
        messagesTotal: number;
    } | null>;
    listEmails(options?: {
        maxResults?: number;
        query?: string;
        labelIds?: string[];
    }): Promise<Email[]>;
    getEmail(id: string, includeBody?: boolean): Promise<Email | null>;
    private extractBody;
    sendEmail(options: SendEmailOptions): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    replyToEmail(originalId: string, body: string, options?: {
        replyAll?: boolean;
    }): Promise<{
        success: boolean;
        messageId?: string;
        error?: string;
    }>;
    draftReply(originalId: string, body: string): Promise<{
        success: boolean;
        draftId?: string;
        error?: string;
    }>;
    createDraft(options: SendEmailOptions): Promise<{
        success: boolean;
        draftId?: string;
        error?: string;
    }>;
    searchEmails(query: string, maxResults?: number): Promise<Email[]>;
    markAsRead(id: string): Promise<boolean>;
    markAsUnread(id: string): Promise<boolean>;
    modifyLabels(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<boolean>;
    trash(id: string): Promise<boolean>;
    listFilters(): Promise<GmailFilter[]>;
    getFilter(id: string): Promise<GmailFilter | null>;
    createFilter(options: CreateFilterOptions): Promise<{
        success: boolean;
        filterId?: string;
        error?: string;
    }>;
    deleteFilter(id: string): Promise<boolean>;
    listLabels(): Promise<{
        id: string;
        name: string;
        type: string;
    }[]>;
    createLabel(name: string): Promise<{
        success: boolean;
        labelId?: string;
        error?: string;
    }>;
    deleteLabel(id: string): Promise<boolean>;
    private parseFilter;
}
