import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "./ensure-redis.mjs";

// 抓取受限访问的 Confluence 页面，把正文转成 Markdown，再通过现有
// POST /knowledge/documents/upload 接口写入本地知识库（走和手动上传完全一致的
// 解析、切块、embedding、入库链路）。脚本只负责“抓 + 转 + 上传”，索引由 Worker 异步完成。
//
// 两段式用法：默认 list 模式只列出种子页面里提取到的链接，确认无误后再加 --ingest 真正入库。
// 原因：受限页面脚本作者看不到，先列出来让人确认“截图那部分”的链接集合，避免抓错页面。

const DEFAULT_CONFLUENCE_BASE_URL = "https://doc.huanleguang.com";
const DEFAULT_API_BASE_URL = "http://localhost:4001";
const DEFAULT_SEED_PAGE_ID = "52773412";
const DEFAULT_DELAY_MS = 300;

function readEnvFile(path) {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// 和 ensure-ollama.mjs 保持一致的优先级：shell > 根 .env > apps/api/.env
function loadDevEnv(cwd = process.cwd()) {
  const rootEnv = readEnvFile(resolve(cwd, ".env"));
  const apiEnv = readEnvFile(resolve(cwd, "apps", "api", ".env"));
  return { ...apiEnv, ...rootEnv, ...process.env };
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildConfluenceClient({ baseUrl, username, password }) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: basicAuthHeader(username, password) };

  async function getPage(pageId, expand) {
    const expandParam = expand ? `?expand=${expand}` : "";
    const response = await fetchWithTimeout(
      `${normalizedBase}/rest/api/content/${pageId}${expandParam}`,
      { headers, timeoutMs: 30_000 }
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Confluence 鉴权失败（${response.status}），请检查 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD。`);
    }
    if (response.status === 404) {
      throw new Error(`Confluence 页面不存在：${pageId}`);
    }
    if (!response.ok) {
      throw new Error(`Confluence 请求失败：${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  // Confluence storage 里的页面链接只有 space-key + content-title，没有 pageId，
  // 所以需要用 space+title 反查页面。返回 results 数组，取第一条。
  async function getPageByTitle(spaceKey, title) {
    const params = new URLSearchParams({ spaceKey, title, expand: "body.storage,version" });
    const response = await fetchWithTimeout(
      `${normalizedBase}/rest/api/content?${params.toString()}`,
      { headers, timeoutMs: 30_000 }
    );

    if (response.status === 401 || response.status === 403) {
      throw new Error(`Confluence 鉴权失败（${response.status}），请检查 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD。`);
    }
    if (!response.ok) {
      throw new Error(`Confluence 按标题查询失败：${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const result = data?.results?.[0];
    if (!result) {
      throw new Error(`未找到页面：${spaceKey} / ${title}`);
    }
    return result;
  }

  return { getPage, getPageByTitle, baseUrl: normalizedBase };
}

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  // Confluence 制度文档的审批表格里常见这些符号实体，不解码会让表格变成乱码字符串。
  "&radic;": "√",
  "&ge;": "≥",
  "&le;": "≤",
  "&ne;": "≠",
  "&asymp;": "≈",
  "&times;": "×",
  "&divide;": "÷",
  "&plusmn;": "±",
  "&deg;": "°",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&middot;": "·",
  "&bull;": "•",
  "&darr;": "↓",
  "&uarr;": "↑",
  "&rarr;": "→",
  "&larr;": "←",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™"
};

export function decodeHtmlEntities(text) {
  if (!text) {
    return "";
  }
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-zA-Z]+;/g, (match) => HTML_ENTITIES[match] ?? match);
}

// 从 Confluence storage XHTML 里提取“指向其它页面”的链接。
// Confluence storage 格式的页面链接是 <ac:link><ri:page ri:space-key="..." ri:content-title="..." />
//   <ac:plain-text-link-body><![CDATA[显示文本]]></ac:plain-text-link-body></ac:link>，
// 没有 pageId，只有 space-key + content-title，所以这里提取这两个字段，抓取时再反查。
// 按 spaceKey:contentTitle 去重并保留出现顺序。
export function extractPageLinks(storageHtml) {
  if (!storageHtml) {
    return [];
  }

  const links = [];
  const seen = new Set();
  // 匹配整个 ac:link 块；ri:page 的属性可能以任意顺序出现。
  const linkPattern = /<ac:link>\s*<ri:page\s+([^>]*?)\/>([\s\S]*?)<\/ac:link>/gi;
  let match;

  while ((match = linkPattern.exec(storageHtml)) !== null) {
    const attrs = match[1];
    const inner = match[2];
    // ri:page 的属性值里可能带 HTML 实体（例如 &mdash;），反查前必须解码，否则标题对不上。
    const spaceKey = decodeHtmlEntities(matchAttr(attrs, "ri:space-key") ?? matchAttr(attrs, "space-key") ?? "");
    const contentTitle = decodeHtmlEntities(matchAttr(attrs, "ri:content-title") ?? matchAttr(attrs, "content-title") ?? "");

    if (!contentTitle) {
      continue;
    }

    const key = `${spaceKey}:${contentTitle}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const anchorText = extractLinkBodyText(inner) || contentTitle;
    links.push({ spaceKey, contentTitle, anchorText });
  }

  return links;
}

// 从 ac:link 的内部提取显示文本。优先取 CDATA 内容，再退回到 plain-text-link-body 文本。
function extractLinkBodyText(inner) {
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  if (cdata) {
    return cdata[1].trim();
  }
  const body = inner.match(/<ac:plain-text-link-body[^>]*>([\s\S]*?)<\/ac:plain-text-link-body>/i);
  if (body) {
    return decodeHtmlEntities(body[1]).trim();
  }
  return "";
}

// 从属性字符串里按名取值，兼容双引号和单引号。属性名里的冒号、连字符都不是正则元字符，可直接匹配。
function matchAttr(attrs, name) {
  const re = new RegExp(`${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const m = attrs.match(re);
  return m ? m[2] : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 把 Confluence storage（XHTML）转成可读、利于切块的纯文本/轻量 Markdown。
// 不追求完美还原文档样式，重点保留标题、段落、列表、表格的分行结构，
// 因为知识库 chunker 会把空白折叠成单空格，分行结构才是检索质量的来源。
export function storageToText(storageHtml) {
  if (!storageHtml) {
    return "";
  }

  let html = storageHtml;

  // 先丢掉注释和脚本/样式，避免它们的文本混进正文。
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  // ac:/ri: 宏标签本身是结构信息，去掉标签但保留被包裹的文字（例如链接显示文本）。
  html = html.replace(/<\/?ac:[a-zA-Z][^>]*>/g, "");
  html = html.replace(/<\/?ri:[a-zA-Z][^>]*>/g, "");

  html = html.replace(/<hr\s*\/?>/gi, "\n---\n");
  // 标题转 Markdown 标题，方便人读也方便后续按结构切块。
  html = html.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    const prefix = "#".repeat(Number(level));
    return `\n\n${prefix} ${stripTags(inner).trim()}\n\n`;
  });
  html = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner).trim()}`);
  html = html.replace(/<br\s*\/?>/gi, "\n");
  // 表格单元格用 “ | ” 分隔，行尾换行，保留基本表格可读性。
  html = html.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_, inner) => ` ${stripTags(inner).trim()} |`);
  html = html.replace(/<\/tr>/gi, "\n");

  // 块级元素闭合处补换行，避免相邻段落被挤到一行。
  html = html.replace(/<\/(p|div|section|article|ul|ol|table|blockquote)>/gi, "\n");
  html = html.replace(/<p\b[^>]*>/gi, "\n");

  html = stripTags(html);
  html = decodeHtmlEntities(html);
  // 折叠多余空白，但保留段落级换行。
  html = html.replace(/[ \t]+/g, " ");
  html = html.replace(/\n[ \t]+/g, "\n");
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "");
}

export function sanitizeFileName(title) {
  const cleaned = decodeEntitiesForFileName(title).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
  return (cleaned || "confluence-page").slice(0, 120);
}

function decodeEntitiesForFileName(title) {
  return decodeHtmlEntities(title);
}

// 当用户用 --section 指定“截图那部分”这类关键词时，只保留落在该区块内的链接。
// 区块定义：从关键词位置向后取到下一个标题标签为止，覆盖同一个标题下的内容。
function filterLinksBySection(links, storageHtml, keyword) {
  if (!keyword) {
    return links;
  }
  const lowerHtml = storageHtml.toLowerCase();
  const keywordIndex = lowerHtml.indexOf(keyword.toLowerCase());
  if (keywordIndex === -1) {
    return [];
  }
  const tail = storageHtml.slice(keywordIndex);
  const nextHeading = tail.slice(1).search(/<h[1-6]\b/i);
  const sectionEnd = nextHeading === -1 ? tail.length : nextHeading + 1;
  const sectionHtml = tail.slice(0, sectionEnd);
  return extractPageLinks(sectionHtml);
}

async function uploadDocument({ apiBaseUrl, fileName, markdown, pageUrl }) {
  const body = `# ${fileName.replace(/\.md$/, "")}\n\n> 来源：${pageUrl}\n\n${markdown}\n`;
  const form = new FormData();
  form.append("file", new Blob([body], { type: "text/markdown" }), `${fileName}.md`);

  const response = await fetchWithTimeout(`${apiBaseUrl}/knowledge/documents/upload`, {
    method: "POST",
    body: form,
    timeoutMs: 60_000
  });

  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`上传失败：${response.status} ${response.statusText} ${detail}`);
  }

  return response.json();
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function resolveConfig(env, args) {
  const baseUrl = args.base || env.CONFLUENCE_BASE_URL || DEFAULT_CONFLUENCE_BASE_URL;
  const username = env.CONFLUENCE_USERNAME;
  const password = env.CONFLUENCE_PASSWORD;
  const seedPageId = args.page || env.CONFLUENCE_SEED_PAGE_ID || DEFAULT_SEED_PAGE_ID;
  const apiBaseUrl = (args.api || env.AGENT_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/+$/, "");

  if (!username || !password) {
    throw new Error("缺少 Confluence 凭据，请在 .env 配置 CONFLUENCE_USERNAME 和 CONFLUENCE_PASSWORD。");
  }

  return {
    baseUrl,
    username,
    password,
    seedPageId,
    apiBaseUrl,
    section: args.section,
    only: args.only,
    limit: args.limit,
    delayMs: args.delay
  };
}

function parseArgs(argv) {
  const args = { limit: 0, delay: DEFAULT_DELAY_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i + 1];
    switch (arg) {
      case "--ingest":
        args.ingest = true;
        break;
      case "--page":
        args.page = next();
        i += 1;
        break;
      case "--only":
        args.only = next();
        i += 1;
        break;
      case "--section":
        args.section = next();
        i += 1;
        break;
      case "--api":
        args.api = next();
        i += 1;
        break;
      case "--base":
        args.base = next();
        i += 1;
        break;
      case "--limit":
        args.limit = Number(next()) || 0;
        i += 1;
        break;
      case "--delay":
        args.delay = Number(next()) || DEFAULT_DELAY_MS;
        i += 1;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg && !arg.startsWith("--")) {
          args.page = arg;
        }
    }
  }
  return args;
}

const HELP = `用法：node scripts/ingest-confluence.mjs [选项]

默认（list 模式）只列出种子页面里提取到的页面链接，确认后再加 --ingest 真正入库。

选项：
  --ingest            实际抓取并上传到知识库（默认只列出链接）
  --page <id>         种子页面 ID，默认 ${DEFAULT_SEED_PAGE_ID}
  --only <id,id,...>  只入库指定的页面 ID（跳过从种子页提取）
  --section <关键词>  只保留种子页面里命中关键词所在区块的链接
  --api <url>         知识库 API 地址，默认 ${DEFAULT_API_BASE_URL}
  --base <url>        Confluence 根地址，默认 ${DEFAULT_CONFLUENCE_BASE_URL}
  --limit <n>         最多入库的页面数量
  --delay <ms>        每次抓取之间的间隔，默认 ${DEFAULT_DELAY_MS}ms
  -h, --help          显示帮助

环境变量（写在 .env）：
  CONFLUENCE_BASE_URL     Confluence 根地址
  CONFLUENCE_USERNAME     登录用户名（HTTP Basic Auth）
  CONFLUENCE_PASSWORD     登录密码
  CONFLUENCE_SEED_PAGE_ID 默认种子页面 ID
  AGENT_API_BASE_URL      知识库 API 地址`;

function delay(ms) {
  return new Promise((resolveTimeout) => setTimeout(resolveTimeout, ms));
}

function resolveTargetLinks(config, confluence) {
  // --only 支持两种格式：纯 pageId（如 12345），或 spaceKey:标题（如 ggq:员工手册）。
  // 后者用于补录从种子页提取、但因标题实体未解码等原因失败的页面。
  if (!config.only) {
    return null;
  }
  return config.only
    .split(/,(?![^:]*:)/) // 标题里可能不含逗号，简单按逗号拆分多项
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((entry) => {
      const colonIndex = entry.indexOf(":");
      if (colonIndex > 0 && !/^\d+$/.test(entry)) {
        return {
          spaceKey: entry.slice(0, colonIndex).trim(),
          contentTitle: entry.slice(colonIndex + 1).trim(),
          anchorText: entry.slice(colonIndex + 1).trim()
        };
      }
      return { pageId: entry, anchorText: entry };
    });
}

async function fetchTargetPage(confluence, target) {
  // 从种子页提取出来的链接只有 spaceKey + contentTitle，需要反查；
  // --only 指定的链接直接用 pageId 取。
  if (target.pageId) {
    return confluence.getPage(target.pageId, "body.storage,version");
  }
  return confluence.getPageByTitle(target.spaceKey, target.contentTitle);
}

function targetLabel(target) {
  if (target.pageId) {
    return `${target.pageId}\t${target.anchorText}`;
  }
  return `${target.spaceKey}:${target.contentTitle}\t${target.anchorText}`;
}

async function listMode(config, confluence) {
  const forced = resolveTargetLinks(config, confluence);
  if (forced) {
    console.log("已用 --only 指定页面，跳过种子页提取：");
    for (const link of forced) {
      console.log(`  - ${targetLabel(link)}`);
    }
    console.log("\n加 --ingest 即可入库这些页面。");
    return;
  }

  console.log(`正在读取种子页面 ${config.seedPageId} ...`);
  const seed = await confluence.getPage(config.seedPageId, "body.storage");
  const storageHtml = seed?.body?.storage?.value ?? "";
  let links = extractPageLinks(storageHtml);

  if (config.section) {
    links = filterLinksBySection(links, storageHtml, config.section);
    console.log(`按区块关键词“${config.section}”过滤后剩余 ${links.length} 个链接。`);
  }

  console.log(`\n种子页面：${seed.title ?? config.seedPageId}`);
  console.log(`提取到 ${links.length} 个页面链接：\n`);
  for (const link of links) {
    console.log(`  ${link.spaceKey}\t${link.contentTitle}\t${link.anchorText}`);
  }
  console.log(`\n确认无误后执行：node scripts/ingest-confluence.mjs --ingest${config.section ? ` --section "${config.section}"` : ""}`);
}

async function ingestMode(config, confluence) {
  let targets = resolveTargetLinks(config, confluence);

  if (!targets) {
    console.log(`正在读取种子页面 ${config.seedPageId} 提取链接 ...`);
    const seed = await confluence.getPage(config.seedPageId, "body.storage");
    const storageHtml = seed?.body?.storage?.value ?? "";
    targets = extractPageLinks(storageHtml);
    if (config.section) {
      targets = filterLinksBySection(targets, storageHtml, config.section);
      console.log(`按区块关键词“${config.section}”过滤后剩余 ${targets.length} 个链接。`);
    }
  }

  if (config.limit > 0) {
    targets = targets.slice(0, config.limit);
  }

  if (targets.length === 0) {
    console.log("没有待入库的页面。");
    return;
  }

  console.log(`准备入库 ${targets.length} 个页面到 ${config.apiBaseUrl} ...\n`);

  let success = 0;
  const failures = [];

  for (const target of targets) {
    const label = targetLabel(target);
    try {
      const page = await fetchTargetPage(confluence, target);
      const text = storageToText(page?.body?.storage?.value ?? "");
      if (!text) {
        throw new Error("页面没有可索引的文本内容");
      }
      const title = page.title || target.contentTitle || target.anchorText || target.pageId;
      const fileName = sanitizeFileName(title);
      const pageUrl = `${confluence.baseUrl}/pages/viewpage.action?pageId=${page.id}`;
      const result = await uploadDocument({ apiBaseUrl: config.apiBaseUrl, fileName, markdown: text, pageUrl });
      success += 1;
      console.log(`[OK]   ${label} -> ${result.document?.id ?? "?"}（${fileName}.md）`);
    } catch (error) {
      failures.push({ target, message: error instanceof Error ? error.message : String(error) });
      console.error(`[FAIL] ${label} -> ${failures[failures.length - 1].message}`);
    }
    await delay(config.delayMs);
  }

  console.log(`\n完成：成功 ${success}，失败 ${failures.length}。`);
  if (success > 0) {
    console.log("文档已进入知识库索引队列，确保 API 与 Worker 都在运行，状态变 ready 后即可被检索。");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }

  const config = resolveConfig(loadDevEnv(), args);
  const confluence = buildConfluenceClient(config);

  if (args.ingest) {
    await ingestMode(config, confluence);
  } else {
    await listMode(config, confluence);
  }
}

const currentFile = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(`[ingest-confluence] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
