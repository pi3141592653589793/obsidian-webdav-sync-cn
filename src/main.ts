import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    normalizePath,
    requestUrl,
} from "obsidian";

/* ------------------------------------------------------------------ */
/* Types & defaults                                                    */
/* ------------------------------------------------------------------ */

type Lang = "zh" | "en";

interface SyncSettings {
    serverUrl: string;
    username: string;
    password: string;
    remoteDir: string;
    autoSyncMinutes: number;
    includeHidden: boolean;
    ignoreList: string;
    lastSyncAt: string;
    lastSyncSummary: string;
    lastTestDetail: string;
    /** Skip single files larger than this (MB); 0 = no limit. */
    maxFileMB: number;
    /** Monthly upload / download budget in MB (Jianguoyun free tier: 1024 / 3072). */
    uploadBudgetMB: number;
    downloadBudgetMB: number;
    /**
     * Day of month (1-28) on which the provider resets the traffic counters.
     * Jianguoyun resets on the signup anniversary, not on the 1st.
     */
    cycleStartDay: number;
    /** Estimated traffic of the current billing cycle. */
    traffic: { month: string; up: number; down: number; warned?: number; calibratedAt?: string };
    /** Baseline mtimes per path from the last successful transfer (l = local, r = remote, 0 = unknown). */
    syncState: Record<string, { l: number; r: number; s?: number; h?: string }>;
    lang: "auto" | "zh" | "en";
}

const DEFAULT_SETTINGS: SyncSettings = {
    serverUrl: "https://dav.jianguoyun.com/dav/",
    username: "",
    password: "",
    remoteDir: "ObsidianSync",
    autoSyncMinutes: 0,
    includeHidden: false,
    ignoreList: ".obsidian\n.trash\n",
    lastSyncAt: "",
    lastSyncSummary: "",
    lastTestDetail: "",
    maxFileMB: 20,
    uploadBudgetMB: 1024,
    downloadBudgetMB: 3072,
    cycleStartDay: 1,
    traffic: { month: "", up: 0, down: 0 },
    syncState: {},
    lang: "auto",
};

/** Bytes in a megabyte, as used by the budget / traffic settings. */
const MB = 1024 * 1024;

interface RemoteEntry {
    path: string;
    isDir: boolean;
    mtime: number;
    size: number;
}

interface LocalEntry {
    path: string;
    mtime: number;
    size: number;
}

type SyncDirection = "both" | "upload" | "download";

const PROPFIND_RESOURCETYPE =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

const PROPFIND_LIST =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propfind xmlns:d="DAV:"><d:prop>' +
    "<d:getlastmodified/><d:getcontentlength/><d:resourcetype/>" +
    "</d:prop></d:propfind>";

/** Jianguoyun returns at most 750 entries per PROPFIND; abort instead of syncing partially. */
const MAX_LISTING = 750;

/* ------------------------------------------------------------------ */
/* i18n                                                               */
/* ------------------------------------------------------------------ */

const STRINGS: Record<Lang, Record<string, string>> = {
    zh: {
        "plugin.name": "WebDAV 同步（坚果云 / 通用）",
        "cmd.sync": "立即双向同步",
        "cmd.upload": "仅上传到云端",
        "cmd.download": "仅从云端下载",
        "notice.syncing": "正在同步…",
        "notice.done": "同步完成：上传 {u} 个（{um} MB），下载 {d} 个（{dm} MB），跳过 {s} 个",
        "notice.failed": "同步失败：{msg}",
        "notice.tooBig": "另有 {n} 个大文件超过单文件上限 {mb} MB，本次未同步",
        "notice.trafficWarn": "⚠️ 本周期上传已用 {p}%（{used} / {total} MB，区间 {range}）。坚果云免费版每周期 1GB，用尽后将无法同步",
        "notice.trafficLocked": "本周期上传流量已接近/超过上限，停止上传剩余 {n} 个文件，以免账号被锁定。下个周期自动恢复",
        "notice.downloadLocked": "本周期下载流量已接近/超过上限，停止下载剩余 {n} 个文件",
        "settings.traffic": "本周期流量（估算）",
        "settings.traffic.desc": "只统计本插件走 WebDAV 的传输量；其它设备的用量请用下面的「校准」对齐。坚果云免费版每个周期上传 1GB / 下载 3GB，用尽后无法同步。",
        "settings.traffic.none": "本周期尚未产生传输",
        "settings.traffic.value": "上传 {up} / {totalUp} MB（{upP}%）　下载 {down} / {totalDown} MB（{downP}%）",
        "settings.traffic.reset": "重置本次周期统计",
        "settings.traffic.cycle": "统计区间：{range}",
        "settings.traffic.calibratedAt": "上次校准：{t}",
        "settings.cycle": "计费周期起始日（每月几号清零）",
        "settings.cycle.desc": "坚果云按账号注册日重置流量，不是自然月。填你的重置日（1-28，超过 28 会被改成 28，避免 2 月没有这一天）。填 1 就是自然月。改动后统计区间按新起始日重算，跨入新周期时会清零。",
        "settings.calibrate": "校准流量（与坚果云网页端对齐）",
        "settings.calibrate.desc": "插件只能统计自己走 WebDAV 的传输，其它设备、网页端上传下载都不在统计里。打开坚果云网页端 → 账户信息 → 流量使用情况，把已用的上传/下载换算成 MB 填进来，点「校准」：插件会用这个真实数字覆盖本地估算，之后在本周期内继续累加。填 0 等于清零。",
        "settings.calibrate.up": "已用上传 MB",
        "settings.calibrate.down": "已用下载 MB",
        "settings.calibrate.btn": "校准",
        "settings.calibrate.invalid": "请输入不小于 0 的数字（单位 MB）",
        "notice.calibrated": "已校准为：上传 {up} MB / 下载 {down} MB，之后在本周期内继续累加",
        "settings.budget.up": "每月上传上限（MB）",
        "settings.budget.up.desc": "免费版 1024（即 1GB）。达到上限后本插件会主动停止上传，避免账号被锁。付费版可调大。",
        "settings.budget.down": "每月下载上限（MB）",
        "settings.budget.down.desc": "免费版 3072（即 3GB）。",
        "settings.maxfile": "单文件上限（MB）",
        "settings.maxfile.desc": "超过该大小的文件本次跳过。默认 20MB——视频/压缩包很容易一次吃光月度配额。填 0 表示不限制。",
        "notice.needConfig": "请先在插件设置里填写服务器地址、账号和应用密码",
        "notice.testOk": "连接成功，云端目录可访问",
        "notice.testFail": "连接失败：{msg}",
        "settings.title": "WebDAV 同步",
        "settings.server": "服务器地址",
        "settings.server.desc": "坚果云固定为 https://dav.jianguoyun.com/dav/ ；其他 WebDAV 同理（如 Alist、群晖、Nextcloud）。",
        "settings.user": "账号",
        "settings.user.desc": "坚果云填登录邮箱。",
        "settings.password": "应用密码",
        "settings.password.desc": "坚果云 → 账户信息 → 安全选项 → 添加应用密码（不要用登录密码）。",
        "settings.remote": "云端目录",
        "settings.remote.desc": "在 WebDAV 根目录下使用的文件夹，不存在会自动创建。",
        "settings.auto": "自动同步间隔（分钟）",
        "settings.auto.desc": "0 表示只在手动执行命令时同步。坚果云免费版有请求频率限制，建议 ≥10 分钟。",
        "settings.hidden": "同步隐藏目录（含 .obsidian 配置）",
        "settings.hidden.desc": "开启后会同步插件设置与外观配置，多端共用一套配置。关闭时只同步笔记与附件。",
        "settings.ignore": "忽略规则",
        "settings.ignore.desc": "每行一条，按路径前缀或包含匹配，例：.trash、附件/大文件、*.mp4。",
        "settings.test": "测试连接",
        "settings.test.btn": "测试",
        "settings.status": "最近一次同步",
        "settings.status.none": "尚未同步",
        "settings.lang": "界面语言",
        "settings.lang.desc": "自动跟随 Obsidian，或强制中文/English。",
        "settings.actualUrl": "实际请求地址",
        "settings.actualUrl.desc": "插件实际使用的地址（会自动补全 /dav/ 与结尾斜杠）。填了别的地址会在这里显示归一化结果。",
        "settings.testDetail": "最近一次连接测试",
        "settings.testDetail.none": "尚未测试",
        "notice.testAuthOk": "认证通过（根目录返回 {s}）",
        "notice.testDirReady": "云端目录「{d}」已就绪",
        "notice.testDirMissing": "云端目录「{d}」尚不存在，首次同步会自动创建",
        "err.badAuth": "HTTP 401：账号或应用密码错误。坚果云必须用「应用密码」（账户信息 → 安全选项 → 添加应用密码），不能用登录密码",
        "err.notDav": "HTTP {code}：这个地址不是可用的 WebDAV 端点。坚果云固定填 https://dav.jianguoyun.com/dav/",
        "err.forbidden": "HTTP 403：服务器拒绝访问（可能是免费版请求频率或流量超限，或该路径无写权限）",
        "err.serverError": "HTTP {code}：服务器错误或暂不可用，请稍后重试",
        "err.tooMany": "目录「{d}」下条目已达 750 条（坚果云单次列表上限），已中止同步以免漏文件",
        "err.requestBudget": "本次同步已发出 {n} 次请求，接近坚果云免费版「每 30 分钟 600 次」上限，建议把同步间隔调大",
        "conflict.suffix": "冲突",
    },
    en: {
        "plugin.name": "WebDAV Sync (Jianguoyun / generic)",
        "cmd.sync": "Sync now (two-way)",
        "cmd.upload": "Upload to cloud only",
        "cmd.download": "Download from cloud only",
        "notice.syncing": "Syncing…",
        "notice.done": "Sync done: {u} uploaded ({um} MB), {d} downloaded ({dm} MB), {s} skipped",
        "notice.failed": "Sync failed: {msg}",
        "notice.tooBig": "{n} file(s) exceeded the {mb} MB per-file limit and were skipped",
        "notice.trafficWarn": "⚠️ This cycle upload is at {p}% ({used} / {total} MB, {range}). Jianguoyun free tier allows 1 GB per cycle; sync stops when exhausted",
        "notice.trafficLocked": "This cycle upload quota is nearly exhausted — stopped uploading the remaining {n} file(s) to protect the account",
        "notice.downloadLocked": "This cycle download quota is nearly exhausted — stopped downloading the remaining {n} file(s)",
        "settings.traffic": "Traffic this cycle (estimated)",
        "settings.traffic.desc": "Counts only this plugin's WebDAV transfers; use Calibrate below to include other devices. Jianguoyun free tier: 1 GB upload / 3 GB download per cycle; sync stops when exhausted.",
        "settings.traffic.none": "No transfer yet this cycle",
        "settings.traffic.value": "Upload {up} / {totalUp} MB ({upP}%)　Download {down} / {totalDown} MB ({downP}%)",
        "settings.traffic.reset": "Reset this cycle",
        "settings.traffic.cycle": "Cycle: {range}",
        "settings.traffic.calibratedAt": "Last calibrated: {t}",
        "settings.cycle": "Billing cycle start day",
        "settings.cycle.desc": "Jianguoyun resets traffic on your signup anniversary, not on the 1st. Enter that day (1-28; larger values fall back to 28 so February always has it). 1 = calendar month. Changing it recomputes the window and clears counters when a new cycle starts.",
        "settings.calibrate": "Calibrate traffic (match the Jianguoyun dashboard)",
        "settings.calibrate.desc": "The plugin only counts its own WebDAV transfers; other devices and web uploads/downloads are invisible to it. Open the Jianguoyun website → Account → traffic usage, convert the used upload/download to MB, paste them here and press Calibrate: the real numbers replace the local estimate and the plugin keeps adding its own transfers on top. Entering 0 clears the counters.",
        "settings.calibrate.up": "Upload used (MB)",
        "settings.calibrate.down": "Download used (MB)",
        "settings.calibrate.btn": "Calibrate",
        "settings.calibrate.invalid": "Enter a number of 0 or more (in MB)",
        "notice.calibrated": "Calibrated: {up} MB up / {down} MB down; the plugin keeps adding transfers on top",
        "settings.budget.up": "Monthly upload budget (MB)",
        "settings.budget.up.desc": "Free tier: 1024 (1 GB). Uploads stop at this limit to protect the account. Increase for paid plans.",
        "settings.budget.down": "Monthly download budget (MB)",
        "settings.budget.down.desc": "Free tier: 3072 (3 GB).",
        "settings.maxfile": "Per-file size limit (MB)",
        "settings.maxfile.desc": "Larger files are skipped for this run. Default 20 MB — one video or archive can eat the whole monthly quota. 0 = unlimited.",
        "notice.needConfig": "Set server URL, username and app password first",
        "notice.testOk": "Connected. Remote folder is reachable.",
        "notice.testFail": "Connection failed: {msg}",
        "settings.title": "WebDAV Sync",
        "settings.server": "Server URL",
        "settings.server.desc": "Jianguoyun: https://dav.jianguoyun.com/dav/ . Any WebDAV works (Alist, Synology, Nextcloud).",
        "settings.user": "Username",
        "settings.user.desc": "Jianguoyun: your login email.",
        "settings.password": "App password",
        "settings.password.desc": "Jianguoyun → Account → Security → Add app password (do not use your login password).",
        "settings.remote": "Remote folder",
        "settings.remote.desc": "Folder under the WebDAV root. Created automatically if missing.",
        "settings.auto": "Auto sync interval (minutes)",
        "settings.auto.desc": "0 = manual only. Jianguoyun free tier is rate-limited; 10+ minutes recommended.",
        "settings.hidden": "Sync hidden folders (.obsidian included)",
        "settings.hidden.desc": "Sync plugin settings and appearance across devices. Off = notes and attachments only.",
        "settings.ignore": "Ignore rules",
        "settings.ignore.desc": "One per line, matched by path prefix or substring, e.g. .trash, large/, *.mp4.",
        "settings.test": "Test connection",
        "settings.test.btn": "Test",
        "settings.status": "Last sync",
        "settings.status.none": "Never synced",
        "settings.lang": "Interface language",
        "settings.lang.desc": "Follow Obsidian, or force Chinese/English.",
        "settings.actualUrl": "Effective URL",
        "settings.actualUrl.desc": "The address actually used (auto-appends /dav/ and the trailing slash).",
        "settings.testDetail": "Last connection test",
        "settings.testDetail.none": "Not tested yet",
        "notice.testAuthOk": "Authenticated (root returned {s})",
        "notice.testDirReady": "Remote folder \"{d}\" is ready",
        "notice.testDirMissing": "Remote folder \"{d}\" does not exist yet; it will be created on first sync",
        "err.badAuth": "HTTP 401: wrong username or app password. Jianguoyun requires an app password (Account → Security → Add app password), not your login password",
        "err.notDav": "HTTP {code}: this address is not a usable WebDAV endpoint. Jianguoyun: https://dav.jianguoyun.com/dav/",
        "err.forbidden": "HTTP 403: access denied (possibly free-tier rate or traffic limit, or no write permission)",
        "err.serverError": "HTTP {code}: server error or temporarily unavailable, retry later",
        "err.tooMany": "Folder \"{d}\" has reached 750 entries (Jianguoyun listing limit); sync aborted to avoid missing files",
        "err.requestBudget": "This sync already sent {n} requests, close to the Jianguoyun free-tier limit (600 per 30 min). Increase the sync interval",
        "conflict.suffix": "conflict",
    },
};

function detectLang(): Lang {
    if (typeof navigator !== "undefined" && navigator.language) {
        return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
    return "en";
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

export default class WebDavSyncPlugin extends Plugin {
    settings: SyncSettings = { ...DEFAULT_SETTINGS };
    private timer: number | null = null;
    private syncing = false;
    private reqCount = 0;
    private createdDirs = new Set<string>();
    private settingTab?: WebDavSyncSettingTab;

    t(key: string, vars?: Record<string, string | number>): string {
        const lang: Lang =
            this.settings.lang === "auto" ? detectLang() : this.settings.lang;
        let text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                text = text.split("{" + k + "}").join(String(v));
            }
        }
        return text;
    }

    async onload(): Promise<void> {
        await this.loadSettings();
        this.settingTab = new WebDavSyncSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);

        this.addCommand({
            id: "sync-both",
            name: this.t("cmd.sync"),
            callback: () => void this.runSync("both"),
        });
        this.addCommand({
            id: "sync-upload",
            name: this.t("cmd.upload"),
            callback: () => void this.runSync("upload"),
        });
        this.addCommand({
            id: "sync-download",
            name: this.t("cmd.download"),
            callback: () => void this.runSync("download"),
        });

        this.applyAutoSync();
    }

    onunload(): void {
        if (this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
    }

    applyAutoSync(): void {
        if (this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
        const minutes = Number(this.settings.autoSyncMinutes);
        if (minutes > 0) {
            this.timer = window.setInterval(
                () => void this.runSync("both", true),
                minutes * 60 * 1000
            );
            this.registerInterval(this.timer);
        }
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) as Partial<SyncSettings> | null;
        this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    /* ------------------------- URL & auth ------------------------- */

    private basicAuth(): string {
        // UTF-8 safe Base64 (usernames can contain non-ASCII characters)
        const raw = `${this.settings.username}:${this.settings.password}`;
        const bytes = new TextEncoder().encode(raw);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return "Basic " + btoa(binary);
    }

    /** Normalize a server URL: add scheme, Jianguoyun /dav/ prefix, trailing slash. */
    static normalizeServerUrl(raw: string): string {
        let url = (raw ?? "").trim();
        if (!url) return DEFAULT_SETTINGS.serverUrl;
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        try {
            const parsed = new URL(url);
            const host = parsed.hostname.toLowerCase();
            if (
                host === "jianguoyun.com" ||
                host === "www.jianguoyun.com" ||
                host === "dav.jianguoyun.com"
            ) {
                parsed.hostname = "dav.jianguoyun.com";
                const path = parsed.pathname.replace(/\/+$/, "");
                if (path === "" || path === "/") {
                    parsed.pathname = "/dav/";
                } else if (/^\/dav(\/|$)/i.test(path)) {
                    parsed.pathname = path;
                } else {
                    parsed.pathname = "/dav" + path;
                }
            }
            url = parsed.toString();
        } catch {
            // keep the raw string if it cannot be parsed
        }
        return url.endsWith("/") ? url : url + "/";
    }

    private baseUrl(): string {
        return WebDavSyncPlugin.normalizeServerUrl(this.settings.serverUrl);
    }

    /** Normalized URL actually used for requests (shown in the settings tab). */
    effectiveUrl(): string {
        return this.baseUrl();
    }

    private remoteRoot(): string {
        const dir = this.settings.remoteDir.trim().replace(/^\/+|\/+$/g, "");
        return dir.length ? dir + "/" : "";
    }

    /** Percent-encode each segment, but keep the trailing slash of a collection URL. */
    private encodePath(path: string): string {
        const trailing = path.endsWith("/");
        const joined = path
            .split("/")
            .filter((segment) => segment.length > 0)
            .map((segment) => encodeURIComponent(segment))
            .join("/");
        if (!joined) return "";
        return trailing ? joined + "/" : joined;
    }

    private remoteUrl(path: string): string {
        return this.baseUrl() + this.encodePath(this.remoteRoot() + path);
    }

    private explainStatus(status: number): string {
        if (status === 401) return this.t("err.badAuth");
        if (status === 403) return this.t("err.forbidden");
        if (status === 404 || status === 501) return this.t("err.notDav", { code: status });
        return this.t("err.serverError", { code: status });
    }

    /** Single HTTP call, with a request counter so we can warn about rate limits. */
    private async request(
        url: string,
        method: string,
        options: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {}
    ) {
        const headers: Record<string, string> = {
            Authorization: this.basicAuth(),
            ...(options.headers ?? {}),
        };
        this.reqCount++;
        const res = await requestUrl({
            url,
            method,
            headers,
            body: options.body,
            throw: false,
        });
        // Some servers return 401 for a missing collection requested without a slash.
        if (res.status === 401 && method.toUpperCase() === "PROPFIND" && !url.endsWith("/")) {
            this.reqCount++;
            return await requestUrl({
                url: url + "/",
                method,
                headers,
                body: options.body,
                throw: false,
            });
        }
        return res;
    }

    private async dav(
        method: string,
        path: string,
        options: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {}
    ) {
        return this.request(this.remoteUrl(path), method, options);
    }

    /* ------------------------- Remote I/O ------------------------- */

    /** Request against an explicit path relative to the WebDAV base (root NOT prepended). */
    private async davAt(
        relToBase: string,
        method: string,
        options: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {}
    ) {
        return this.request(this.baseUrl() + this.encodePath(relToBase), method, options);
    }

    /**
     * Create the sync root (and optionally a sub folder) on the server.
     * @param relPath path relative to the sync root, e.g. "" or "附件/图片"
     */
    private async ensureRemoteDir(relPath: string): Promise<void> {
        const clean = relPath.replace(/^\/+|\/+$/g, "");
        const rootName = this.remoteRoot().replace(/\/$/, "");
        const parts: string[] = rootName ? rootName.split("/") : [];

        if (parts.length) {
            await this.mkcol(parts.join("/"));
        }
        if (clean) {
            for (const segment of clean.split("/").filter(Boolean)) {
                parts.push(segment);
                await this.mkcol(parts.join("/"));
            }
        }
    }

    private async mkcol(relToBase: string): Promise<void> {
        if (this.createdDirs.has(relToBase)) return;
        const url = this.baseUrl() + this.encodePath(relToBase + "/");
        const res = await this.request(url, "MKCOL");
        // 201 created, 405 already exists, 200 ok, 301/302 redirects — all fine
        if ([200, 201, 301, 302, 405].includes(res.status)) {
            this.createdDirs.add(relToBase);
            return;
        }
        // Some servers answer 403/404/409 for a folder that already exists — verify before failing.
        if ([403, 404, 409].includes(res.status)) {
            const probe = await this.request(url, "PROPFIND", {
                body: PROPFIND_RESOURCETYPE,
                headers: { Depth: "0", "Content-Type": "application/xml" },
            });
            if (probe.status === 207 || probe.status === 200) {
                this.createdDirs.add(relToBase);
                return;
            }
        }
        throw new Error(`${this.explainStatus(res.status)} (MKCOL ${url})`);
    }

    private async listRemote(): Promise<Map<string, RemoteEntry>> {
        const result = new Map<string, RemoteEntry>();
        const root = this.remoteRoot().replace(/\/$/, "");

        // Prefix of the WebDAV endpoint path (e.g. "/dav/"), used to turn hrefs into vault-relative paths.
        let basePath = "/";
        try {
            basePath = new URL(this.baseUrl()).pathname;
        } catch {
            basePath = "/";
        }

        /** Convert a DAV href into a path relative to the sync root. */
        const relOf = (href: string): string => {
            let decoded = href;
            try {
                decoded = decodeURIComponent(href);
            } catch {
                // keep raw href if it is not valid percent-encoding
            }
            if (/^https?:\/\//i.test(decoded)) {
                try {
                    decoded = new URL(decoded).pathname;
                } catch {
                    // ignore
                }
            }
            if (basePath !== "/" && decoded.startsWith(basePath)) {
                decoded = decoded.slice(basePath.length);
            } else {
                decoded = decoded.replace(/^\/+/, "");
            }
            if (root) {
                if (decoded === `${root}/` || decoded === root) return "";
                if (decoded.startsWith(`${root}/`)) decoded = decoded.slice(root.length + 1);
            }
            return decoded.replace(/\/$/, "");
        };

        const visited = new Set<string>();

        const walk = async (dir: string): Promise<void> => {
            if (visited.has(dir)) return; // circular hrefs must not recurse forever
            visited.add(dir);
            const res = await this.dav("PROPFIND", dir === root ? "" : dir + "/", {
                body: PROPFIND_LIST,
                headers: { Depth: "1", "Content-Type": "application/xml" },
            });
            if (res.status === 404) return; // folder missing yet
            if (res.status !== 207 && res.status !== 200) {
                throw new Error(
                    `${this.explainStatus(res.status)} (PROPFIND ${this.remoteUrl(
                        dir === root ? "" : dir + "/"
                    )})`
                );
            }
            const doc = new DOMParser().parseFromString(res.text, "text/xml");
            const responses = Array.from(
                doc.getElementsByTagNameNS("DAV:", "response")
            );
            if (responses.length >= MAX_LISTING) {
                throw new Error(this.t("err.tooMany", { d: dir || "/" }));
            }
            const dirsToVisit: string[] = [];
            for (const node of responses) {
                const href = node.getElementsByTagNameNS("DAV:", "href")[0]?.textContent ?? "";
                if (!href) continue;
                const rel = relOf(href);
                if (!rel) continue; // the folder itself
                if (rel === dir) continue; // self entry of a sub folder that was just walked
                const isDir = node.getElementsByTagNameNS("DAV:", "collection").length > 0;
                const mtimeText =
                    node.getElementsByTagNameNS("DAV:", "getlastmodified")[0]
                        ?.textContent ?? "";
                const sizeText =
                    node.getElementsByTagNameNS("DAV:", "getcontentlength")[0]
                        ?.textContent ?? "0";
                if (isDir) {
                    result.set(rel + "/", { path: rel, isDir: true, mtime: 0, size: 0 });
                    dirsToVisit.push(rel);
                } else {
                    result.set(rel, {
                        path: rel,
                        isDir: false,
                        mtime: mtimeText ? Date.parse(mtimeText) : 0,
                        size: Number(sizeText) || 0,
                    });
                }
            }
            for (const sub of dirsToVisit) {
                await walk(sub);
            }
        };

        await walk(root);
        return result;
    }

    /* ------------------------- Local I/O -------------------------- */

    private async listLocal(): Promise<Map<string, LocalEntry>> {
        const result = new Map<string, LocalEntry>();
        const adapter = this.app.vault.adapter;

        const walk = async (dir: string): Promise<void> => {
            const listing = await adapter.list(dir);
            for (const folder of listing.folders) {
                await walk(folder);
            }
            for (const file of listing.files) {
                const stat = await adapter.stat(file);
                if (!stat) continue;
                const rel = file.replace(/^\/+/, "");
                result.set(rel, {
                    path: rel,
                    mtime: stat.mtime,
                    size: stat.size ?? 0,
                });
            }
        };

        await walk("");
        return result;
    }

    private isIgnored(path: string): boolean {
        const rules = this.settings.ignoreList
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (!this.settings.includeHidden) rules.push(".obsidian", ".trash");
        return rules.some((rule) => {
            if (rule.startsWith("*.")) return path.endsWith(rule.slice(1));
            return path === rule || path.startsWith(rule + "/") || path.includes(rule);
        });
    }


    /* ------------------------ Traffic budget ---------------------- */

    /**
     * Jianguoyun resets traffic on the signup anniversary, not on the 1st of
     * the month. `cycleStartDay` (1-28) stores that day, so every month has it
     * (no Feb-30 style edge cases).
     */
    private cycleStartDay(): number {
        const raw = Math.trunc(Number(this.settings.cycleStartDay) || 1);
        return Math.min(28, Math.max(1, raw));
    }

    /** First moment of the billing cycle that contains `now`. */
    private cycleStart(now = new Date()): Date {
        const day = this.cycleStartDay();
        const start = new Date(now.getFullYear(), now.getMonth(), day, 0, 0, 0, 0);
        if (now.getTime() < start.getTime()) start.setMonth(start.getMonth() - 1);
        return start;
    }

    private static ymd(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
            date.getDate()
        ).padStart(2, "0")}`;
    }

    private cycleKey(): string {
        return WebDavSyncPlugin.ymd(this.cycleStart());
    }

    /** "2026-10-20 → 2026-11-19" (inclusive last day of the cycle). */
    cycleLabel(): string {
        const start = this.cycleStart();
        const end = new Date(start.getTime());
        end.setMonth(end.getMonth() + 1);
        end.setDate(end.getDate() - 1);
        return `${WebDavSyncPlugin.ymd(start)} → ${WebDavSyncPlugin.ymd(end)}`;
    }

    /** Roll the counters over when the billing cycle changes. */
    private rollTraffic(): void {
        const key = this.cycleKey();
        if (!this.settings.traffic || this.settings.traffic.month !== key) {
            this.settings.traffic = { month: key, up: 0, down: 0 };
        }
    }

    /**
     * Align the counters with what the provider actually reports.
     *
     * The plugin can only see its own WebDAV transfers, while the Jianguoyun
     * dashboard also counts other devices, web downloads, etc. Calibration
     * overwrites the local estimate with the real number, and the plugin keeps
     * adding its own transfers on top from there.
     */
    calibrate(upMB: number, downMB: number, silent = false): void {
        this.rollTraffic();
        const up = Math.max(0, Number(upMB) || 0) * MB;
        const down = Math.max(0, Number(downMB) || 0) * MB;
        this.settings.traffic.up = up;
        this.settings.traffic.down = down;
        this.settings.traffic.calibratedAt = new Date().toISOString();
        // Remember the warning level we would have fired, so calibrating to a
        // high value does not immediately re-trigger the same warning.
        this.settings.traffic.warned = this.warnLevel(up);
        if (!silent) {
            new Notice(
                this.t("notice.calibrated", {
                    up: WebDavSyncPlugin.mb(up),
                    down: WebDavSyncPlugin.mb(down),
                })
            );
        }
    }

    private warnLevel(upBytes: number): number {
        const budget = this.upBudgetBytes();
        if (budget <= 0) return 0;
        const pct = (upBytes / budget) * 100;
        if (pct >= 90) return 90;
        if (pct >= 70) return 70;
        return 0;
    }

    private upBudgetBytes(): number {
        return Math.max(0, Number(this.settings.uploadBudgetMB) || 0) * 1024 * 1024;
    }

    private downBudgetBytes(): number {
        return Math.max(0, Number(this.settings.downloadBudgetMB) || 0) * 1024 * 1024;
    }

    private maxFileBytes(): number {
        const mb = Number(this.settings.maxFileMB) || 0;
        return mb > 0 ? mb * 1024 * 1024 : Number.POSITIVE_INFINITY;
    }

    /** FNV-1a over raw bytes: good enough to tell "same content" apart from "mtime touched". */
    private static hashBuffer(buf: ArrayBuffer): string {
        const bytes = new Uint8Array(buf);
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16) + ":" + bytes.length;
    }

    static mb(bytes: number): string {
        return (bytes / (1024 * 1024)).toFixed(2);
    }

    /* ------------------------- Sync core -------------------------- */

    async runSync(direction: SyncDirection, silent = false): Promise<void> {
        if (this.syncing) return;
        if (!this.settings.username || !this.settings.password) {
            new Notice(this.t("notice.needConfig"));
            return;
        }
        this.syncing = true;
        this.reqCount = 0;
        this.createdDirs.clear();
        this.rollTraffic();
        if (!silent) new Notice(this.t("notice.syncing"));

        let uploaded = 0;
        let downloaded = 0;
        let skipped = 0;
        let upBytes = 0;
        let downBytes = 0;
        let tooBig = 0;
        let blockedUp = 0;
        let blockedDown = 0;
        try {
            await this.ensureRemoteDir("");
            const [local, remote] = await Promise.all([
                this.listLocal(),
                this.listRemote(),
            ]);

            const remoteFiles = new Map(
                Array.from(remote.values())
                    .filter((entry) => !entry.isDir)
                    .map((entry) => [entry.path, entry])
            );

            const paths = new Set<string>([...local.keys(), ...remoteFiles.keys()]);
            const adapter = this.app.vault.adapter;

            for (const path of paths) {
                if (this.isIgnored(path)) {
                    skipped++;
                    continue;
                }
                const l = local.get(path);
                const r = remoteFiles.get(path);
                const prev = this.settings.syncState[path];
                const lMtime = l?.mtime ?? 0;
                const rMtime = r?.mtime ?? 0;
                const lSame = prev !== undefined && Math.abs(prev.l - lMtime) < 1;
                const rSame =
                    prev !== undefined &&
                    r !== undefined &&
                    (prev.r === 0 || Math.abs(prev.r - rMtime) < 1000);

                let action: "upload" | "download" | "skip" = "skip";
                if (l && !r) {
                    action = "upload";
                } else if (!l && r) {
                    action = "download";
                } else if (l && r) {
                    if (prev && lSame && rSame) {
                        action = "skip";
                    } else if (prev && !lSame && rSame) {
                        action = "upload"; // only the local copy changed
                    } else if (prev && lSame && !rSame) {
                        action = "download"; // only the remote copy changed
                    } else if (lMtime > rMtime + 3000) {
                        action = "upload";
                    } else if (rMtime > lMtime + 3000) {
                        action = "download";
                    } else {
                        // First sync of this file, or both sides changed by the same amount:
                        // treat them as identical and record the baseline.
                        this.settings.syncState[path] = { ...prev, l: lMtime, r: rMtime };
                    }
                    // We uploaded earlier and never learned the remote mtime — record it now
                    // so future remote edits are detected (and clocks never cause re-uploads).
                    if (action === "skip" && prev && prev.r === 0) {
                        this.settings.syncState[path] = { ...prev, l: lMtime, r: rMtime };
                    }
                }

                // Direction is a filter, not a "force everything" switch: unchanged files stay skipped.
                if (direction === "upload" && action === "download") action = "skip";
                if (direction === "download" && action === "upload") action = "skip";

                if (action === "upload" && l) {
                    // Never spend quota on files above the per-file limit.
                    if (l.size > this.maxFileBytes()) {
                        tooBig++;
                        skipped++;
                        continue;
                    }
                    // Stop before crossing the monthly upload budget.
                    if (
                        this.upBudgetBytes() > 0 &&
                        this.settings.traffic.up + l.size > this.upBudgetBytes()
                    ) {
                        blockedUp++;
                        skipped++;
                        continue;
                    }
                    const data = await adapter.readBinary(path);
                    // Some adapters report size 0; re-check with the real byte length.
                    if (data.byteLength > this.maxFileBytes()) {
                        tooBig++;
                        skipped++;
                        continue;
                    }
                    if (data.byteLength !== l.size) {
                        this.settings.syncState[path] = { ...prev, l: lMtime };
                    }
                    const hash = WebDavSyncPlugin.hashBuffer(data);
                    // mtime changed but bytes identical (editor touched the file): no transfer needed.
                    if (prev?.h === hash) {
                        this.settings.syncState[path] = {
                            l: lMtime,
                            r: prev.r,
                            s: l.size,
                            h: hash,
                        };
                        skipped++;
                        continue;
                    }
                    const remoteFolder = path.includes("/")
                        ? path.slice(0, path.lastIndexOf("/"))
                        : "";
                    if (remoteFolder) await this.ensureRemoteDir(remoteFolder);
                    const res = await this.dav("PUT", path, {
                        body: data,
                        headers: { "Content-Type": "application/octet-stream" },
                    });
                    if (res.status >= 200 && res.status < 300) {
                        uploaded++;
                        upBytes += data.byteLength;
                        this.settings.traffic.up += data.byteLength;
                        // Remote mtime unknown until the next listing.
                        this.settings.syncState[path] = { l: lMtime, r: 0, s: l.size, h: hash };
                    } else {
                        throw new Error(`${this.explainStatus(res.status)} (PUT ${path})`);
                    }
                } else if (action === "download" && r) {
                    const size = r.size || 0;
                    if (
                        this.downBudgetBytes() > 0 &&
                        this.settings.traffic.down + size > this.downBudgetBytes()
                    ) {
                        blockedDown++;
                        skipped++;
                        continue;
                    }
                    const res = await this.dav("GET", path);
                    if (res.status === 200 && res.arrayBuffer) {
                        const parent = path.includes("/")
                            ? path.slice(0, path.lastIndexOf("/"))
                            : "";
                        if (parent) {
                            const folder = normalizePath(parent);
                            if (!(await adapter.exists(folder))) {
                                await adapter.mkdir(folder);
                            }
                        }
                        await adapter.writeBinary(path, res.arrayBuffer);
                        const after = await adapter.stat(path);
                        const sizeGot = res.arrayBuffer.byteLength;
                        downBytes += sizeGot;
                        this.settings.traffic.down += sizeGot;
                        this.settings.syncState[path] = {
                            l: after?.mtime ?? Date.now(),
                            r: rMtime,
                            s: sizeGot,
                            h: WebDavSyncPlugin.hashBuffer(res.arrayBuffer),
                        };
                        downloaded++;
                    } else if (res.status !== 404) {
                        throw new Error(`${this.explainStatus(res.status)} (GET ${path})`);
                    }
                } else {
                    skipped++;
                }
            }

            this.settings.lastSyncAt = new Date().toLocaleString();
            this.settings.lastSyncSummary = this.t("notice.done", {
                u: uploaded,
                d: downloaded,
                s: skipped,
                um: WebDavSyncPlugin.mb(upBytes),
                dm: WebDavSyncPlugin.mb(downBytes),
            });
            await this.saveSettings();
            if (!silent) {
                new Notice(this.settings.lastSyncSummary, 6000);
            } else {
                new Notice(this.settings.lastSyncSummary, 4000);
            }
            // Jianguoyun free tier allows 600 requests per 30 minutes.
            if (this.reqCount > 500) {
                new Notice(this.t("err.requestBudget", { n: this.reqCount }), 10000);
            }
            if (tooBig > 0) {
                new Notice(
                    this.t("notice.tooBig", { n: tooBig, mb: this.settings.maxFileMB }),
                    10000
                );
            }
            if (blockedUp > 0) {
                new Notice(this.t("notice.trafficLocked", { n: blockedUp }), 14000);
            }
            if (blockedDown > 0) {
                new Notice(this.t("notice.downloadLocked", { n: blockedDown }), 14000);
            }
            // Warn at 70 % and again at 90 % of the upload budget for this cycle.
            const upBudget = this.upBudgetBytes();
            if (upBudget > 0) {
                const pct = Math.round((this.settings.traffic.up / upBudget) * 100);
                const level = this.warnLevel(this.settings.traffic.up);
                // Only warn when a new threshold is crossed, otherwise auto-sync would spam notices.
                if (level > (this.settings.traffic.warned ?? 0)) {
                    this.settings.traffic.warned = level;
                    await this.saveSettings();
                    new Notice(
                        this.t("notice.trafficWarn", {
                            p: pct,
                            used: WebDavSyncPlugin.mb(this.settings.traffic.up),
                            total: WebDavSyncPlugin.mb(upBudget),
                            range: this.cycleLabel(),
                        }),
                        14000
                    );
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(this.t("notice.failed", { msg: message }), 10000);
        } finally {
            this.syncing = false;
        }
    }

    async testConnection(): Promise<void> {
        const lines: string[] = [];
        const original = this.settings.serverUrl.trim();
        const normalized = WebDavSyncPlugin.normalizeServerUrl(original);
        if (normalized !== original) {
            this.settings.serverUrl = normalized;
            await this.saveSettings();
            lines.push(`${this.t("settings.actualUrl")}：${normalized}`);
        }

        this.reqCount = 0;
        this.createdDirs.clear();
        const dirPath = this.remoteRoot().replace(/\/$/, "");
        const root = this.baseUrl();

        let authOk = false;
        let dirReady = false;

        // Step 1: authenticate against the WebDAV root (never a folder that may not exist yet).
        try {
            const res = await this.request(root, "PROPFIND", {
                body: PROPFIND_RESOURCETYPE,
                headers: { Depth: "0", "Content-Type": "application/xml" },
            });
            lines.push(`1) PROPFIND ${root} → HTTP ${res.status}`);
            if (res.status === 207 || res.status === 200) {
                authOk = true;
                lines.push("   " + this.t("notice.testAuthOk", { s: res.status }));
            } else if (res.status === 401) {
                lines.push("   " + this.t("err.badAuth"));
            } else if (res.status === 403) {
                lines.push("   " + this.t("err.forbidden"));
            } else {
                lines.push("   " + this.explainStatus(res.status));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lines.push(`1) PROPFIND ${root} → ${message}`);
        }

        // Step 2: make sure the target folder exists (this is what a real sync does first).
        if (authOk) {
            try {
                await this.ensureRemoteDir("");
                const res = await this.dav("PROPFIND", "", {
                    body: PROPFIND_RESOURCETYPE,
                    headers: { Depth: "0", "Content-Type": "application/xml" },
                });
                lines.push(`2) PROPFIND ${this.remoteUrl("")} → HTTP ${res.status}`);
                dirReady = res.status === 207 || res.status === 200;
                lines.push(
                    "   " +
                        (dirReady
                            ? this.t("notice.testDirReady", { d: dirPath || "/" })
                            : this.explainStatus(res.status))
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                lines.push(`2) MKCOL ${this.remoteUrl("")} → ${message}`);
            }
        }

        lines.push(`Σ ${this.reqCount} requests`);
        const detail = lines.join("\n");
        this.settings.lastTestDetail = detail;
        await this.saveSettings();
        this.settingTab?.display();

        if (authOk && dirReady) {
            new Notice(`${this.t("notice.testOk")}\n${detail}`, 8000);
        } else if (authOk) {
            new Notice(
                `${this.t("notice.testDirMissing", { d: dirPath || "/" })}\n${detail}`,
                12000
            );
        } else {
            new Notice(`${this.t("notice.testFail", { msg: lines[0] ?? "" })}\n${detail}`, 15000);
        }
    }

    /** Human readable traffic lines for the settings tab. */
    trafficSummary(): string {
        this.rollTraffic();
        const traffic = this.settings.traffic;
        const upBudget = this.upBudgetBytes();
        const downBudget = this.downBudgetBytes();
        const pct = (value: number, budget: number) =>
            budget > 0 ? Math.round((value / budget) * 100) : 0;
        const lines: string[] = [];
        lines.push(this.t("settings.traffic.cycle", { range: this.cycleLabel() }));
        if (traffic.up === 0 && traffic.down === 0) {
            lines.push(this.t("settings.traffic.none"));
        } else {
            lines.push(
                this.t("settings.traffic.value", {
                    up: WebDavSyncPlugin.mb(traffic.up),
                    totalUp: WebDavSyncPlugin.mb(upBudget),
                    upP: pct(traffic.up, upBudget),
                    down: WebDavSyncPlugin.mb(traffic.down),
                    totalDown: WebDavSyncPlugin.mb(downBudget),
                    downP: pct(traffic.down, downBudget),
                })
            );
        }
        if (traffic.calibratedAt) {
            const when = new Date(traffic.calibratedAt);
            lines.push(
                this.t("settings.traffic.calibratedAt", {
                    t: Number.isNaN(when.getTime())
                        ? traffic.calibratedAt
                        : `${WebDavSyncPlugin.ymd(when)} ${String(when.getHours()).padStart(2, "0")}:${String(
                              when.getMinutes()
                          ).padStart(2, "0")}`,
                })
            );
        }
        lines.push(this.t("settings.traffic.desc"));
        return lines.join("\n");
    }

    resetTraffic(): void {
        this.settings.traffic = { month: this.cycleKey(), up: 0, down: 0 };
    }

    /** Update the reset day and immediately roll the window if it changed. */
    setCycleStartDay(day: number): void {
        const next = Math.min(28, Math.max(1, Math.trunc(Number(day) || 1)));
        this.settings.cycleStartDay = next;
        this.rollTraffic();
    }
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                       */
/* ------------------------------------------------------------------ */

class WebDavSyncSettingTab extends PluginSettingTab {
    plugin: WebDavSyncPlugin;

    constructor(app: App, plugin: WebDavSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: this.plugin.t("settings.title") });

        new Setting(containerEl)
            .setName(this.plugin.t("settings.lang"))
            .setDesc(this.plugin.t("settings.lang.desc"))
            .addDropdown((dropdown) =>
                dropdown
                    .addOption("auto", "Auto")
                    .addOption("zh", "中文")
                    .addOption("en", "English")
                    .setValue(this.plugin.settings.lang)
                    .onChange(async (value) => {
                        this.plugin.settings.lang = value as SyncSettings["lang"];
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.server"))
            .setDesc(this.plugin.t("settings.server.desc"))
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.serverUrl)
                    .setPlaceholder("https://dav.jianguoyun.com/dav/")
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value.trim();
                        await this.plugin.saveSettings();
                    })
            )
            .addExtraButton((button) =>
                button
                    .setIcon("reset")
                    .setTooltip(this.plugin.t("settings.actualUrl"))
                    .onClick(async () => {
                        this.plugin.settings.serverUrl =
                            WebDavSyncPlugin.normalizeServerUrl(
                                this.plugin.settings.serverUrl
                            );
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        // Read-only: what the plugin will actually request (helps debugging 404s).
        new Setting(containerEl)
            .setName(this.plugin.t("settings.actualUrl"))
            .setDesc(
                (() => {
                    const fragment = document.createDocumentFragment();
                    const code = document.createElement("code");
                    code.textContent = this.plugin.effectiveUrl();
                    fragment.appendChild(code);
                    const hint = document.createElement("div");
                    hint.className = "setting-item-description";
                    hint.textContent = this.plugin.t("settings.actualUrl.desc");
                    fragment.appendChild(hint);
                    return fragment;
                })()
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.user"))
            .setDesc(this.plugin.t("settings.user.desc"))
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.username)
                    .onChange(async (value) => {
                        this.plugin.settings.username = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.password"))
            .setDesc(this.plugin.t("settings.password.desc"))
            .addText((text) => {
                text.inputEl.type = "password";
                text
                    .setValue(this.plugin.settings.password)
                    .onChange(async (value) => {
                        this.plugin.settings.password = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName(this.plugin.t("settings.remote"))
            .setDesc(this.plugin.t("settings.remote.desc"))
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.remoteDir)
                    .onChange(async (value) => {
                        this.plugin.settings.remoteDir = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.auto"))
            .setDesc(this.plugin.t("settings.auto.desc"))
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text
                    .setValue(String(this.plugin.settings.autoSyncMinutes))
                    .onChange(async (value) => {
                        const minutes = Math.max(0, Number(value) || 0);
                        this.plugin.settings.autoSyncMinutes = minutes;
                        await this.plugin.saveSettings();
                        this.plugin.applyAutoSync();
                    });
            });

        new Setting(containerEl)
            .setName(this.plugin.t("settings.hidden"))
            .setDesc(this.plugin.t("settings.hidden.desc"))
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.includeHidden)
                    .onChange(async (value) => {
                        this.plugin.settings.includeHidden = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ---- traffic budget ------------------------------------------------
        const numberSetting = (
            name: string,
            desc: string,
            value: number,
            apply: (value: number) => void
        ) =>
            new Setting(containerEl)
                .setName(name)
                .setDesc(desc)
                .addText((text) => {
                    text.inputEl.type = "number";
                    text.inputEl.min = "0";
                    text.setValue(String(value)).onChange((raw) => {
                        apply(Math.max(0, Number(raw) || 0));
                    });
                });

        numberSetting(
            this.plugin.t("settings.maxfile"),
            this.plugin.t("settings.maxfile.desc"),
            this.plugin.settings.maxFileMB,
            (value) => {
                this.plugin.settings.maxFileMB = value;
                void this.plugin.saveSettings();
            }
        );

        numberSetting(
            this.plugin.t("settings.budget.up"),
            this.plugin.t("settings.budget.up.desc"),
            this.plugin.settings.uploadBudgetMB,
            (value) => {
                this.plugin.settings.uploadBudgetMB = value;
                void this.plugin.saveSettings();
            }
        );

        numberSetting(
            this.plugin.t("settings.budget.down"),
            this.plugin.t("settings.budget.down.desc"),
            this.plugin.settings.downloadBudgetMB,
            (value) => {
                this.plugin.settings.downloadBudgetMB = value;
                void this.plugin.saveSettings();
            }
        );

        numberSetting(
            this.plugin.t("settings.cycle"),
            this.plugin.t("settings.cycle.desc"),
            this.plugin.settings.cycleStartDay,
            (value) => {
                this.plugin.setCycleStartDay(value);
                void this.plugin.saveSettings();
            }
        );

        // ---- calibration against the provider dashboard ---------------------
        let calibrateUp = WebDavSyncPlugin.mb(this.plugin.settings.traffic.up);
        let calibrateDown = WebDavSyncPlugin.mb(this.plugin.settings.traffic.down);

        new Setting(containerEl)
            .setName(this.plugin.t("settings.calibrate"))
            .setDesc(this.plugin.t("settings.calibrate.desc"))
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.step = "any";
                text.inputEl.style.width = "96px";
                text.setPlaceholder(this.plugin.t("settings.calibrate.up"))
                    .setValue(calibrateUp)
                    .onChange((value) => {
                        calibrateUp = value;
                    });
                text.inputEl.setAttribute("aria-label", this.plugin.t("settings.calibrate.up"));
            })
            .addText((text) => {
                text.inputEl.type = "number";
                text.inputEl.min = "0";
                text.inputEl.step = "any";
                text.inputEl.style.width = "96px";
                text.setPlaceholder(this.plugin.t("settings.calibrate.down"))
                    .setValue(calibrateDown)
                    .onChange((value) => {
                        calibrateDown = value;
                    });
                text.inputEl.setAttribute("aria-label", this.plugin.t("settings.calibrate.down"));
            })
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("settings.calibrate.btn"))
                    .onClick(async () => {
                        const up = Number(calibrateUp);
                        const down = Number(calibrateDown);
                        if (
                            !Number.isFinite(up) ||
                            !Number.isFinite(down) ||
                            up < 0 ||
                            down < 0
                        ) {
                            new Notice(this.plugin.t("settings.calibrate.invalid"));
                            return;
                        }
                        this.plugin.calibrate(up, down);
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.traffic"))
            .setDesc(
                (() => {
                    const fragment = document.createDocumentFragment();
                    for (const line of this.plugin.trafficSummary().split("\n")) {
                        const div = document.createElement("div");
                        div.className = "setting-item-description";
                        div.textContent = line;
                        fragment.appendChild(div);
                    }
                    return fragment;
                })()
            )
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("settings.traffic.reset"))
                    .onClick(async () => {
                        this.plugin.resetTraffic();
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.ignore"))
            .setDesc(this.plugin.t("settings.ignore.desc"))
            .addTextArea((area) => {
                area.setValue(this.plugin.settings.ignoreList).onChange(async (value) => {
                    this.plugin.settings.ignoreList = value;
                    await this.plugin.saveSettings();
                });
                area.inputEl.rows = 4;
            });

        new Setting(containerEl)
            .setName(this.plugin.t("settings.test"))
            .setDesc(
                (() => {
                    const fragment = document.createDocumentFragment();
                    const label = document.createElement("div");
                    label.className = "setting-item-description";
                    label.textContent = this.plugin.t("settings.testDetail");
                    fragment.appendChild(label);
                    const detail = this.plugin.settings.lastTestDetail;
                    if (detail) {
                        const pre = document.createElement("pre");
                        pre.textContent = detail;
                        pre.style.whiteSpace = "pre-wrap";
                        pre.style.fontSize = "0.8em";
                        pre.style.userSelect = "text";
                        fragment.appendChild(pre);
                    } else {
                        const none = document.createElement("div");
                        none.className = "setting-item-description";
                        none.textContent = this.plugin.t("settings.testDetail.none");
                        fragment.appendChild(none);
                    }
                    return fragment;
                })()
            )
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.t("settings.test.btn"))
                    .setCta()
                    .onClick(async () => {
                        button.setDisabled(true);
                        button.setButtonText("…");
                        try {
                            await this.plugin.testConnection();
                        } finally {
                            button.setDisabled(false);
                            button.setButtonText(this.plugin.t("settings.test.btn"));
                        }
                    })
            );

        new Setting(containerEl)
            .setName(this.plugin.t("settings.status"))
            .setDesc(
                this.plugin.settings.lastSyncAt
                    ? `${this.plugin.settings.lastSyncAt}\n${this.plugin.settings.lastSyncSummary}`
                    : this.plugin.t("settings.status.none")
            );
    }
}
