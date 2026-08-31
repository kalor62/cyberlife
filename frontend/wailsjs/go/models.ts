export namespace addons {
	
	export class AgentToolDecl {
	    name: string;
	    description: string;
	    schema?: number[];
	
	    static createFrom(source: any = {}) {
	        return new AgentToolDecl(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.schema = source["schema"];
	    }
	}
	export class PageDecl {
	    id: string;
	    label: string;
	    icon?: string;
	
	    static createFrom(source: any = {}) {
	        return new PageDecl(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.icon = source["icon"];
	    }
	}
	export class ModuleDecl {
	    id: string;
	    label: string;
	    icon?: string;
	    pages?: PageDecl[];
	
	    static createFrom(source: any = {}) {
	        return new ModuleDecl(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.icon = source["icon"];
	        this.pages = this.convertValues(source["pages"], PageDecl);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WidgetDecl {
	    id: string;
	    title: string;
	    icon?: string;
	    description?: string;
	    dashboard?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WidgetDecl(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.icon = source["icon"];
	        this.description = source["description"];
	        this.dashboard = source["dashboard"];
	    }
	}
	export class Addon {
	    id: string;
	    name: string;
	    icon?: string;
	    version: string;
	    description?: string;
	    author?: string;
	    category?: string;
	    tags?: string[];
	    entry?: string;
	    permissions?: string[];
	    widgets?: WidgetDecl[];
	    modules?: ModuleDecl[];
	    homepage?: string;
	    hosts?: string[];
	    agentTools?: AgentToolDecl[];
	    dir?: string;
	    builtIn?: boolean;
	    enabled: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Addon(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.version = source["version"];
	        this.description = source["description"];
	        this.author = source["author"];
	        this.category = source["category"];
	        this.tags = source["tags"];
	        this.entry = source["entry"];
	        this.permissions = source["permissions"];
	        this.widgets = this.convertValues(source["widgets"], WidgetDecl);
	        this.modules = this.convertValues(source["modules"], ModuleDecl);
	        this.homepage = source["homepage"];
	        this.hosts = source["hosts"];
	        this.agentTools = this.convertValues(source["agentTools"], AgentToolDecl);
	        this.dir = source["dir"];
	        this.builtIn = source["builtIn"];
	        this.enabled = source["enabled"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace claude {
	
	export class SessionInfo {
	    sessionId: string;
	    pid: number;
	    status: string;
	    waitingFor: string;
	    updatedAt: number;
	    cwd: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.pid = source["pid"];
	        this.status = source["status"];
	        this.waitingFor = source["waitingFor"];
	        this.updatedAt = source["updatedAt"];
	        this.cwd = source["cwd"];
	    }
	}

}

export namespace git {
	
	export class ChangedFile {
	    path: string;
	    status: string;
	    staged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ChangedFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.status = source["status"];
	        this.staged = source["staged"];
	    }
	}
	export class FileDiff {
	    path: string;
	    oldContent: string;
	    newContent: string;
	    diffContent: string;
	
	    static createFrom(source: any = {}) {
	        return new FileDiff(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.oldContent = source["oldContent"];
	        this.newContent = source["newContent"];
	        this.diffContent = source["diffContent"];
	    }
	}

}

export namespace gmail {
	
	export class AttachmentMeta {
	    messageId: string;
	    attachmentId: string;
	    filename: string;
	    mimeType: string;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new AttachmentMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.messageId = source["messageId"];
	        this.attachmentId = source["attachmentId"];
	        this.filename = source["filename"];
	        this.mimeType = source["mimeType"];
	        this.size = source["size"];
	    }
	}
	export class Contact {
	    name: string;
	    email: string;
	    count: number;
	
	    static createFrom(source: any = {}) {
	        return new Contact(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.email = source["email"];
	        this.count = source["count"];
	    }
	}
	export class DraftInfo {
	    draftId: string;
	    messageId: string;
	    threadId: string;
	    to: string;
	    subject: string;
	    bodyText: string;
	    bodyHtml: string;
	
	    static createFrom(source: any = {}) {
	        return new DraftInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.draftId = source["draftId"];
	        this.messageId = source["messageId"];
	        this.threadId = source["threadId"];
	        this.to = source["to"];
	        this.subject = source["subject"];
	        this.bodyText = source["bodyText"];
	        this.bodyHtml = source["bodyHtml"];
	    }
	}
	export class Label {
	    id: string;
	    name: string;
	    type: string;
	    color?: string;
	    textColor?: string;
	    unread: number;
	    total: number;
	    hidden: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Label(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.color = source["color"];
	        this.textColor = source["textColor"];
	        this.unread = source["unread"];
	        this.total = source["total"];
	        this.hidden = source["hidden"];
	    }
	}
	export class MessageDetail {
	    id: string;
	    from: string;
	    to: string;
	    cc: string;
	    dateText: string;
	    subject: string;
	    bodyHtml: string;
	    bodyText: string;
	    unread: boolean;
	    attachments: AttachmentMeta[];
	
	    static createFrom(source: any = {}) {
	        return new MessageDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.from = source["from"];
	        this.to = source["to"];
	        this.cc = source["cc"];
	        this.dateText = source["dateText"];
	        this.subject = source["subject"];
	        this.bodyHtml = source["bodyHtml"];
	        this.bodyText = source["bodyText"];
	        this.unread = source["unread"];
	        this.attachments = this.convertValues(source["attachments"], AttachmentMeta);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ThreadDetail {
	    id: string;
	    messages: MessageDetail[];
	
	    static createFrom(source: any = {}) {
	        return new ThreadDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.messages = this.convertValues(source["messages"], MessageDetail);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ThreadSummary {
	    id: string;
	    snippet: string;
	    subject: string;
	    from: string;
	    fromEmail: string;
	    dateUnix: number;
	    dateText: string;
	    unread: boolean;
	    starred: boolean;
	    msgCount: number;
	    labelIds: string[];
	
	    static createFrom(source: any = {}) {
	        return new ThreadSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.snippet = source["snippet"];
	        this.subject = source["subject"];
	        this.from = source["from"];
	        this.fromEmail = source["fromEmail"];
	        this.dateUnix = source["dateUnix"];
	        this.dateText = source["dateText"];
	        this.unread = source["unread"];
	        this.starred = source["starred"];
	        this.msgCount = source["msgCount"];
	        this.labelIds = source["labelIds"];
	    }
	}
	export class ThreadPage {
	    threads: ThreadSummary[];
	    nextPageToken: string;
	    resultEstimate: number;
	
	    static createFrom(source: any = {}) {
	        return new ThreadPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.threads = this.convertValues(source["threads"], ThreadSummary);
	        this.nextPageToken = source["nextPageToken"];
	        this.resultEstimate = source["resultEstimate"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace health {
	
	export class CheckDef {
	    id: string;
	    title: string;
	    description: string;
	    stack: string;
	    category: string;
	    kind: string;
	    custom?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CheckDef(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.stack = source["stack"];
	        this.category = source["category"];
	        this.kind = source["kind"];
	        this.custom = source["custom"];
	    }
	}
	export class HealthCheckItem {
	    name: string;
	    passed: boolean;
	    status?: string;
	    detail?: string;
	    description?: string;
	    manual?: boolean;
	    manualId?: string;
	
	    static createFrom(source: any = {}) {
	        return new HealthCheckItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.passed = source["passed"];
	        this.status = source["status"];
	        this.detail = source["detail"];
	        this.description = source["description"];
	        this.manual = source["manual"];
	        this.manualId = source["manualId"];
	    }
	}
	export class HealthCategory {
	    name: string;
	    icon: string;
	    items: HealthCheckItem[];
	    passed: number;
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new HealthCategory(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.items = this.convertValues(source["items"], HealthCheckItem);
	        this.passed = source["passed"];
	        this.total = source["total"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class ProjectHealthReport {
	    projectName: string;
	    projectPath: string;
	    categories: HealthCategory[];
	
	    static createFrom(source: any = {}) {
	        return new ProjectHealthReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.projectName = source["projectName"];
	        this.projectPath = source["projectPath"];
	        this.categories = this.convertValues(source["categories"], HealthCategory);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace iterm {
	
	export class ITermTab {
	    windowId: number;
	    tabIndex: number;
	    sessionId: string;
	    name: string;
	    path: string;
	    isActive: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ITermTab(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.windowId = source["windowId"];
	        this.tabIndex = source["tabIndex"];
	        this.sessionId = source["sessionId"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isActive = source["isActive"];
	    }
	}
	export class ITermStatus {
	    running: boolean;
	    tabs: ITermTab[];
	
	    static createFrom(source: any = {}) {
	        return new ITermStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.running = source["running"];
	        this.tabs = this.convertValues(source["tabs"], ITermTab);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SessionInfo {
	    name: string;
	    profileName: string;
	    columns: number;
	    rows: number;
	    currentCommand: string;
	    jobPid: number;
	    isProcessing: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.profileName = source["profileName"];
	        this.columns = source["columns"];
	        this.rows = source["rows"];
	        this.currentCommand = source["currentCommand"];
	        this.jobPid = source["jobPid"];
	        this.isProcessing = source["isProcessing"];
	    }
	}

}

export namespace main {
	
	export class AddonsInfo {
	    addons: addons.Addon[];
	    dir: string;
	    categories: string[];
	
	    static createFrom(source: any = {}) {
	        return new AddonsInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.addons = this.convertValues(source["addons"], addons.Addon);
	        this.dir = source["dir"];
	        this.categories = source["categories"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AgentSkillInfo {
	    id: string;
	    title: string;
	    description: string;
	    enabled: boolean;
	    available: boolean;
	    note?: string;
	
	    static createFrom(source: any = {}) {
	        return new AgentSkillInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.enabled = source["enabled"];
	        this.available = source["available"];
	        this.note = source["note"];
	    }
	}
	export class CalendarInfo {
	    id: string;
	    name: string;
	    primary?: boolean;
	    readOnly?: boolean;
	    shared: boolean;
	    color?: string;
	
	    static createFrom(source: any = {}) {
	        return new CalendarInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.primary = source["primary"];
	        this.readOnly = source["readOnly"];
	        this.shared = source["shared"];
	        this.color = source["color"];
	    }
	}
	export class CalendarAccountInfo {
	    email: string;
	    calendars: CalendarInfo[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new CalendarAccountInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	        this.calendars = this.convertValues(source["calendars"], CalendarInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class DependencyStatus {
	    id: string;
	    name: string;
	    ok: boolean;
	    required: boolean;
	    path?: string;
	    purpose: string;
	    hint: string;
	
	    static createFrom(source: any = {}) {
	        return new DependencyStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.ok = source["ok"];
	        this.required = source["required"];
	        this.path = source["path"];
	        this.purpose = source["purpose"];
	        this.hint = source["hint"];
	    }
	}
	export class GmailAccountInfo {
	    email: string;
	    mcpEnabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GmailAccountInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	        this.mcpEnabled = source["mcpEnabled"];
	    }
	}
	export class GmailConfig {
	    enabled: boolean;
	    mcpEnabled: boolean;
	    clientId: string;
	    clientSecret: string;
	    accounts: GmailAccountInfo[];
	
	    static createFrom(source: any = {}) {
	        return new GmailConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.mcpEnabled = source["mcpEnabled"];
	        this.clientId = source["clientId"];
	        this.clientSecret = source["clientSecret"];
	        this.accounts = this.convertValues(source["accounts"], GmailAccountInfo);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class HealthLibrary {
	    stacks: string[];
	    checks: health.CheckDef[];
	
	    static createFrom(source: any = {}) {
	        return new HealthLibrary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.stacks = source["stacks"];
	        this.checks = this.convertValues(source["checks"], health.CheckDef);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class JiraSyncResult {
	    created: number;
	    updated: number;
	    total: number;
	    project: string;
	
	    static createFrom(source: any = {}) {
	        return new JiraSyncResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.created = source["created"];
	        this.updated = source["updated"];
	        this.total = source["total"];
	        this.project = source["project"];
	    }
	}
	export class KanbanBoard {
	    columns: state.KanbanColumn[];
	    tasks: state.KanbanTask[];
	
	    static createFrom(source: any = {}) {
	        return new KanbanBoard(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.columns = this.convertValues(source["columns"], state.KanbanColumn);
	        this.tasks = this.convertValues(source["tasks"], state.KanbanTask);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectRepo {
	    name: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new ProjectRepo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	    }
	}

}

export namespace state {
	
	export class Dashboard {
	    id: string;
	    name: string;
	    icon?: string;
	    widgets: string[];
	
	    static createFrom(source: any = {}) {
	        return new Dashboard(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.widgets = source["widgets"];
	    }
	}
	export class WidgetSettings {
	    sidebar?: string[];
	    collapsed?: boolean;
	    width?: number;
	    moduleWidths?: Record<string, number>;
	
	    static createFrom(source: any = {}) {
	        return new WidgetSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sidebar = source["sidebar"];
	        this.collapsed = source["collapsed"];
	        this.width = source["width"];
	        this.moduleWidths = source["moduleWidths"];
	    }
	}
	export class AutomationRun {
	    id: string;
	    ruleId: string;
	    ruleName: string;
	    projectId?: string;
	    taskId?: string;
	    sessionId?: string;
	    mailThreadId?: string;
	    trigger: string;
	    status: string;
	    detail?: string;
	    // Go type: time
	    startedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new AutomationRun(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.ruleId = source["ruleId"];
	        this.ruleName = source["ruleName"];
	        this.projectId = source["projectId"];
	        this.taskId = source["taskId"];
	        this.sessionId = source["sessionId"];
	        this.mailThreadId = source["mailThreadId"];
	        this.trigger = source["trigger"];
	        this.status = source["status"];
	        this.detail = source["detail"];
	        this.startedAt = this.convertValues(source["startedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AutomationAction {
	    type: string;
	    runner?: string;
	    prompt?: string;
	    workDir?: string;
	    column?: string;
	    text?: string;
	    title?: string;
	    message?: string;
	    account?: string;
	    to?: string;
	    subject?: string;
	    body?: string;
	    url?: string;
	    method?: string;
	    event?: string;
	
	    static createFrom(source: any = {}) {
	        return new AutomationAction(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.runner = source["runner"];
	        this.prompt = source["prompt"];
	        this.workDir = source["workDir"];
	        this.column = source["column"];
	        this.text = source["text"];
	        this.title = source["title"];
	        this.message = source["message"];
	        this.account = source["account"];
	        this.to = source["to"];
	        this.subject = source["subject"];
	        this.body = source["body"];
	        this.url = source["url"];
	        this.method = source["method"];
	        this.event = source["event"];
	    }
	}
	export class AutomationTrigger {
	    type: string;
	    column?: string;
	    everyMinutes?: number;
	    dailyAt?: string;
	    account?: string;
	    fromContains?: string;
	    subjectContains?: string;
	    slug?: string;
	
	    static createFrom(source: any = {}) {
	        return new AutomationTrigger(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.type = source["type"];
	        this.column = source["column"];
	        this.everyMinutes = source["everyMinutes"];
	        this.dailyAt = source["dailyAt"];
	        this.account = source["account"];
	        this.fromContains = source["fromContains"];
	        this.subjectContains = source["subjectContains"];
	        this.slug = source["slug"];
	    }
	}
	export class AutomationRule {
	    id: string;
	    name: string;
	    projectId?: string;
	    enabled: boolean;
	    trigger: AutomationTrigger;
	    actions: AutomationAction[];
	    // Go type: time
	    lastRunAt?: any;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new AutomationRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.projectId = source["projectId"];
	        this.enabled = source["enabled"];
	        this.trigger = this.convertValues(source["trigger"], AutomationTrigger);
	        this.actions = this.convertValues(source["actions"], AutomationAction);
	        this.lastRunAt = this.convertValues(source["lastRunAt"], null);
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CustomHealthCheck {
	    id: string;
	    title: string;
	    description?: string;
	    stack: string;
	    category: string;
	
	    static createFrom(source: any = {}) {
	        return new CustomHealthCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.stack = source["stack"];
	        this.category = source["category"];
	    }
	}
	export class Runner {
	    id: string;
	    name: string;
	    command: string;
	    args?: string;
	    env?: Record<string, string>;
	    icon?: string;
	    color?: string;
	    builtIn?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Runner(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.command = source["command"];
	        this.args = source["args"];
	        this.env = source["env"];
	        this.icon = source["icon"];
	        this.color = source["color"];
	        this.builtIn = source["builtIn"];
	    }
	}
	export class CalendarAccount {
	    email: string;
	    tokenJson: string;
	    clientId?: string;
	    clientSecret?: string;
	    shared?: string[];
	
	    static createFrom(source: any = {}) {
	        return new CalendarAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	        this.tokenJson = source["tokenJson"];
	        this.clientId = source["clientId"];
	        this.clientSecret = source["clientSecret"];
	        this.shared = source["shared"];
	    }
	}
	export class CalendarSettings {
	    accounts: CalendarAccount[];
	
	    static createFrom(source: any = {}) {
	        return new CalendarSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accounts = this.convertValues(source["accounts"], CalendarAccount);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class GmailAccount {
	    email: string;
	    tokenJson: string;
	    clientId?: string;
	    clientSecret?: string;
	    mcpEnabled?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GmailAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.email = source["email"];
	        this.tokenJson = source["tokenJson"];
	        this.clientId = source["clientId"];
	        this.clientSecret = source["clientSecret"];
	        this.mcpEnabled = source["mcpEnabled"];
	    }
	}
	export class GmailSettings {
	    enabled: boolean;
	    mcpEnabled: boolean;
	    clientId: string;
	    clientSecret: string;
	    accounts: GmailAccount[];
	
	    static createFrom(source: any = {}) {
	        return new GmailSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.mcpEnabled = source["mcpEnabled"];
	        this.clientId = source["clientId"];
	        this.clientSecret = source["clientSecret"];
	        this.accounts = this.convertValues(source["accounts"], GmailAccount);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class JiraSettings {
	    enabled: boolean;
	    baseUrl: string;
	    email: string;
	    apiToken: string;
	
	    static createFrom(source: any = {}) {
	        return new JiraSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.enabled = source["enabled"];
	        this.baseUrl = source["baseUrl"];
	        this.email = source["email"];
	        this.apiToken = source["apiToken"];
	    }
	}
	export class ClaudeAccount {
	    id: string;
	    name: string;
	    configDir: string;
	
	    static createFrom(source: any = {}) {
	        return new ClaudeAccount(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.configDir = source["configDir"];
	    }
	}
	export class PomodoroSettings {
	    sessionMinutes: number;
	    breakMinutes: number;
	
	    static createFrom(source: any = {}) {
	        return new PomodoroSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionMinutes = source["sessionMinutes"];
	        this.breakMinutes = source["breakMinutes"];
	    }
	}
	export class WindowState {
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	    maximized: boolean;
	
	    static createFrom(source: any = {}) {
	        return new WindowState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.maximized = source["maximized"];
	    }
	}
	export class ProjectGroup {
	    id: string;
	    name: string;
	    icon: string;
	    color?: string;
	    collapsed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new ProjectGroup(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.icon = source["icon"];
	        this.color = source["color"];
	        this.collapsed = source["collapsed"];
	    }
	}
	export class KanbanComment {
	    id: string;
	    author: string;
	    text: string;
	    // Go type: time
	    createdAt: any;
	
	    static createFrom(source: any = {}) {
	        return new KanbanComment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.author = source["author"];
	        this.text = source["text"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class KanbanTask {
	    id: string;
	    title: string;
	    description?: string;
	    columnId: string;
	    order: number;
	    category?: string;
	    priority?: string;
	    blocked?: boolean;
	    archived?: boolean;
	    pinned?: boolean;
	    // Go type: time
	    dueDate?: any;
	    jiraKey?: string;
	    comments?: KanbanComment[];
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new KanbanTask(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.description = source["description"];
	        this.columnId = source["columnId"];
	        this.order = source["order"];
	        this.category = source["category"];
	        this.priority = source["priority"];
	        this.blocked = source["blocked"];
	        this.archived = source["archived"];
	        this.pinned = source["pinned"];
	        this.dueDate = this.convertValues(source["dueDate"], null);
	        this.jiraKey = source["jiraKey"];
	        this.comments = this.convertValues(source["comments"], KanbanComment);
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class KanbanColumn {
	    id: string;
	    name: string;
	    order: number;
	    wipLimit?: number;
	    collapsed?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new KanbanColumn(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.order = source["order"];
	        this.wipLimit = source["wipLimit"];
	        this.collapsed = source["collapsed"];
	    }
	}
	export class PromptCategory {
	    id: string;
	    name: string;
	    order: number;
	    isGlobal: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PromptCategory(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.order = source["order"];
	        this.isGlobal = source["isGlobal"];
	    }
	}
	export class Prompt {
	    id: string;
	    title: string;
	    content: string;
	    category: string;
	    usageCount: number;
	    pinned: boolean;
	    isGlobal: boolean;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Prompt(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.content = source["content"];
	        this.category = source["category"];
	        this.usageCount = source["usageCount"];
	        this.pinned = source["pinned"];
	        this.isGlobal = source["isGlobal"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class TaskRepoState {
	    repoName: string;
	    repoPath: string;
	    worktreePath: string;
	    branch: string;
	
	    static createFrom(source: any = {}) {
	        return new TaskRepoState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.repoName = source["repoName"];
	        this.repoPath = source["repoPath"];
	        this.worktreePath = source["worktreePath"];
	        this.branch = source["branch"];
	    }
	}
	export class TaskState {
	    id: string;
	    projectId: string;
	    name: string;
	    jiraKey?: string;
	    status: string;
	    branch: string;
	    worktreePath: string;
	    repos?: TaskRepoState[];
	    claudeSessionId: string;
	    claudeConfigDir?: string;
	    sessionStarted: boolean;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    lastOpened: any;
	
	    static createFrom(source: any = {}) {
	        return new TaskState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.projectId = source["projectId"];
	        this.name = source["name"];
	        this.jiraKey = source["jiraKey"];
	        this.status = source["status"];
	        this.branch = source["branch"];
	        this.worktreePath = source["worktreePath"];
	        this.repos = this.convertValues(source["repos"], TaskRepoState);
	        this.claudeSessionId = source["claudeSessionId"];
	        this.claudeConfigDir = source["claudeConfigDir"];
	        this.sessionStarted = source["sessionStarted"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.lastOpened = this.convertValues(source["lastOpened"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProjectState {
	    id: string;
	    name: string;
	    path: string;
	    color: string;
	    icon: string;
	    pinned: boolean;
	    groupId?: string;
	    claudeConfigDir?: string;
	    defaultRunner?: string;
	    tasks?: TaskState[];
	    notes: string;
	    prompts: Prompt[];
	    promptCategories: PromptCategory[];
	    kanbanColumns?: KanbanColumn[];
	    kanbanTasks?: KanbanTask[];
	    jiraProject?: string;
	    jiraFilter?: string;
	    healthSelected?: string[];
	    sidebarWidgets?: string[];
	    envVars: Record<string, string>;
	    // Go type: time
	    lastOpened: any;
	    // Go type: time
	    createdAt: any;
	
	    static createFrom(source: any = {}) {
	        return new ProjectState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.path = source["path"];
	        this.color = source["color"];
	        this.icon = source["icon"];
	        this.pinned = source["pinned"];
	        this.groupId = source["groupId"];
	        this.claudeConfigDir = source["claudeConfigDir"];
	        this.defaultRunner = source["defaultRunner"];
	        this.tasks = this.convertValues(source["tasks"], TaskState);
	        this.notes = source["notes"];
	        this.prompts = this.convertValues(source["prompts"], Prompt);
	        this.promptCategories = this.convertValues(source["promptCategories"], PromptCategory);
	        this.kanbanColumns = this.convertValues(source["kanbanColumns"], KanbanColumn);
	        this.kanbanTasks = this.convertValues(source["kanbanTasks"], KanbanTask);
	        this.jiraProject = source["jiraProject"];
	        this.jiraFilter = source["jiraFilter"];
	        this.healthSelected = source["healthSelected"];
	        this.sidebarWidgets = source["sidebarWidgets"];
	        this.envVars = source["envVars"];
	        this.lastOpened = this.convertValues(source["lastOpened"], null);
	        this.createdAt = this.convertValues(source["createdAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AppState {
	    version: number;
	    activeProjectId: string;
	    projects: Record<string, ProjectState>;
	    projectGroups?: ProjectGroup[];
	    globalPrompts: Prompt[];
	    globalPromptCategories: PromptCategory[];
	    terminalTheme: string;
	    terminalFontSize: number;
	    allViewFontSize: number;
	    voiceLang: string;
	    voiceAutoSubmit?: boolean;
	    transcriptionEngine: string;
	    elevenLabsApiKey: string;
	    dashboardFullscreen: boolean;
	    pinnedTerminals?: Record<string, string>;
	    terminalNameOverrides?: Record<string, string>;
	    terminalAccounts?: Record<string, string>;
	    window?: WindowState;
	    pomodoro?: PomodoroSettings;
	    globalPromptPrefix: string;
	    globalPromptSuffix: string;
	    claudeAccounts?: ClaudeAccount[];
	    jira?: JiraSettings;
	    gmail?: GmailSettings;
	    calendar?: CalendarSettings;
	    agentSkills?: Record<string, boolean>;
	    runners?: Runner[];
	    defaultRunner?: string;
	    terminalRunners?: Record<string, string>;
	    customHealthChecks?: CustomHealthCheck[];
	    automations?: AutomationRule[];
	    automationRuns?: AutomationRun[];
	    widgets?: WidgetSettings;
	    moduleOrder?: string[];
	    hiddenModules?: string[];
	    dashboards?: Dashboard[];
	    addonsEnabled?: Record<string, boolean>;
	    addonData?: Record<string, any>;
	    sampleSeeded?: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AppState(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.activeProjectId = source["activeProjectId"];
	        this.projects = this.convertValues(source["projects"], ProjectState, true);
	        this.projectGroups = this.convertValues(source["projectGroups"], ProjectGroup);
	        this.globalPrompts = this.convertValues(source["globalPrompts"], Prompt);
	        this.globalPromptCategories = this.convertValues(source["globalPromptCategories"], PromptCategory);
	        this.terminalTheme = source["terminalTheme"];
	        this.terminalFontSize = source["terminalFontSize"];
	        this.allViewFontSize = source["allViewFontSize"];
	        this.voiceLang = source["voiceLang"];
	        this.voiceAutoSubmit = source["voiceAutoSubmit"];
	        this.transcriptionEngine = source["transcriptionEngine"];
	        this.elevenLabsApiKey = source["elevenLabsApiKey"];
	        this.dashboardFullscreen = source["dashboardFullscreen"];
	        this.pinnedTerminals = source["pinnedTerminals"];
	        this.terminalNameOverrides = source["terminalNameOverrides"];
	        this.terminalAccounts = source["terminalAccounts"];
	        this.window = this.convertValues(source["window"], WindowState);
	        this.pomodoro = this.convertValues(source["pomodoro"], PomodoroSettings);
	        this.globalPromptPrefix = source["globalPromptPrefix"];
	        this.globalPromptSuffix = source["globalPromptSuffix"];
	        this.claudeAccounts = this.convertValues(source["claudeAccounts"], ClaudeAccount);
	        this.jira = this.convertValues(source["jira"], JiraSettings);
	        this.gmail = this.convertValues(source["gmail"], GmailSettings);
	        this.calendar = this.convertValues(source["calendar"], CalendarSettings);
	        this.agentSkills = source["agentSkills"];
	        this.runners = this.convertValues(source["runners"], Runner);
	        this.defaultRunner = source["defaultRunner"];
	        this.terminalRunners = source["terminalRunners"];
	        this.customHealthChecks = this.convertValues(source["customHealthChecks"], CustomHealthCheck);
	        this.automations = this.convertValues(source["automations"], AutomationRule);
	        this.automationRuns = this.convertValues(source["automationRuns"], AutomationRun);
	        this.widgets = this.convertValues(source["widgets"], WidgetSettings);
	        this.moduleOrder = source["moduleOrder"];
	        this.hiddenModules = source["hiddenModules"];
	        this.dashboards = this.convertValues(source["dashboards"], Dashboard);
	        this.addonsEnabled = source["addonsEnabled"];
	        this.addonData = source["addonData"];
	        this.sampleSeeded = source["sampleSeeded"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	
	

}

export namespace structure {
	
	export class FileNode {
	    name: string;
	    path: string;
	    isDir: boolean;
	    children?: FileNode[];
	    fileCount?: number;
	
	    static createFrom(source: any = {}) {
	        return new FileNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.isDir = source["isDir"];
	        this.children = this.convertValues(source["children"], FileNode);
	        this.fileCount = source["fileCount"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

