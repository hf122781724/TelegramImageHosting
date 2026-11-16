const DEFAULT_TG_API = "https://api.telegram.org";

// 图片宽高上限，可被环境变量 MAX_WIDTH / MAX_HEIGHT 覆盖，0 表示不限制
const DEFAULT_MAX_WIDTH = 1920;
const DEFAULT_MAX_HEIGHT = 1920;

// Telegram Bot API 下载文件上限为 20MB，超出后无法通过 /f/<key> 取回，所以上传阶段就拦截
// 可被环境变量 MAX_BYTES（字节）覆盖，比如 10485760 = 10MB
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

// env 只在请求里才能拿到，所以首次请求时解析一次并缓存，之后全局复用
let CONFIG = null;

function config(env) {
  if (!CONFIG) {
    CONFIG = {
      maxWidth: readLimit(env.MAX_WIDTH, DEFAULT_MAX_WIDTH),
      maxHeight: readLimit(env.MAX_HEIGHT, DEFAULT_MAX_HEIGHT),
      maxBytes: readLimit(env.MAX_BYTES, DEFAULT_MAX_BYTES) || DEFAULT_MAX_BYTES,
    };
  }
  return CONFIG;
}

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
};

const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/upload") {
        if (request.method === "POST") return await handleUpload(request, env, url);
        return page(url, env);
      }

      if (url.pathname === "/api") return json(usage(url, env), 200);

      if (url.pathname.startsWith("/f/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ ok: false, error: "Method Not Allowed" }, 405);
        }
        return await handleFile(request, env, url);
      }

      return json({ ok: false, error: "Not Found" }, 404);
    } catch (err) {
      return json({ ok: false, error: err && err.message ? err.message : String(err) }, 500);
    }
  },
};

/**
 * 上传：把文件转发给 Telegram bot，返回代理链接等基础信息
 * 支持 multipart/form-data（字段 file，任意文件字段亦可）或直接二进制 body + ?name=xxx.jpg
 */
async function handleUpload(request, env, url) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) {
    return json({ ok: false, error: "服务端未配置 BOT_TOKEN / CHAT_ID" }, 500);
  }

  const upload = await readUpload(request, url);
  if (!upload.blob) {
    return json(
      { ok: false, error: "未找到文件：请使用 multipart/form-data 的 file 字段，或直接以二进制 body 上传并带 ?name=" },
      400
    );
  }
  if (upload.blob.size === 0) {
    return json({ ok: false, error: "文件内容为空" }, 400);
  }
  const { maxWidth, maxHeight, maxBytes } = config(env);
  if (upload.blob.size > maxBytes) {
    return json(
      { ok: false, error: `文件过大：${humanSize(upload.blob.size)}，上限为 ${bytesLabel(maxBytes)}` },
      413
    );
  }

  // 图片只做宽高校验，超过上限直接报错，文件原样上传
  let dimensions = null;
  if (isImage(upload.type, upload.name)) {
    dimensions = await imageSize(upload.blob);
    if (dimensions) {
      const tooWide = maxWidth > 0 && dimensions.width > maxWidth;
      const tooHigh = maxHeight > 0 && dimensions.height > maxHeight;
      if (tooWide || tooHigh) {
        return json(
          {
            ok: false,
            error: `图片尺寸超限：${dimensions.width}×${dimensions.height}，最大允许 ${maxWidth}×${maxHeight}`,
            width: dimensions.width,
            height: dimensions.height,
            max_width: maxWidth,
            max_height: maxHeight,
          },
          400
        );
      }
    }
  }

  // mode=photo 走 sendPhoto（Telegram 会压缩）；默认 document 保留原样
  const mode = url.searchParams.get("mode") === "photo" ? "photo" : "document";
  const message = await tgUpload(env, upload, mode);

  const doc = message.document || null;
  const photo = mode === "photo" ? pickLargestPhoto(message.photo) : null;
  const source = doc || photo || {};

  const fileId = source.file_id;
  if (!fileId) {
    return json({ ok: false, error: "Telegram 未返回文件 ID" }, 502);
  }

  const finalName = doc ? doc.file_name || upload.name : upload.name;
  const mime = doc ? doc.mime_type || upload.type : upload.type;
  const size = source.file_size || upload.blob.size;
  const ext = extOf(finalName) || EXT_BY_MIME[mime] || "";
  const key = encodeKey(fileId);
  const uploadedAt = new Date().toISOString();

  const body = {
    ok: true,
    url: `${url.origin}/f/${key}${ext ? "." + ext : ""}`,
    file_id: fileId,
    file_unique_id: source.file_unique_id || null,
    name: finalName,
    mime: mime || null,
    size,
    size_human: humanSize(size),
    uploaded_at: uploadedAt,
    message_id: message.message_id,
    mode,
  };
  if (dimensions) {
    body.width = dimensions.width;
    body.height = dimensions.height;
  }
  return json(body, 201);
}

/**
 * 代理取图：/f/<base64url(file_id)>.<ext> -> 向 Telegram 取文件流
 */
async function handleFile(request, env, url) {
  if (!env.BOT_TOKEN) {
    return json({ ok: false, error: "服务端未配置 BOT_TOKEN" }, 500);
  }

  const segment = url.pathname.slice(3);
  const key = segment.split(".")[0];
  if (!key) return json({ ok: false, error: "缺少文件 ID" }, 400);

  let fileId;
  try {
    fileId = decodeKey(key);
  } catch {
    return json({ ok: false, error: "无效的文件 ID" }, 400);
  }

  const filePath = await tgGetFilePath(env, fileId);
  if (!filePath) return json({ ok: false, error: "文件不存在或已被删除" }, 404);

  const tgRes = await fetch(`${tgApi(env)}/file/bot${env.BOT_TOKEN}/${filePath}`, {
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!tgRes.ok) {
    return json({ ok: false, error: `从 Telegram 读取文件失败：HTTP ${tgRes.status}` }, 502);
  }

  const ext = extOf(filePath) || extOf(segment);
  const headers = new Headers();
  headers.set("content-type", MIME_BY_EXT[ext] || tgRes.headers.get("content-type") || "application/octet-stream");
  const contentLength = tgRes.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("etag", `"${key}"`);
  headers.set("access-control-allow-origin", "*");

  return new Response(request.method === "HEAD" ? null : tgRes.body, { status: 200, headers });
}

async function readUpload(request, url) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    let file = form.get("file");
    if (!isFile(file)) {
      for (const value of form.values()) {
        if (isFile(value)) {
          file = value;
          break;
        }
      }
    }
    if (!isFile(file)) return {};
    const type = file.type || "";
    return { blob: file, name: safeName(file.name || fallbackName(type)), type };
  }

  const blob = await request.blob();
  if (!blob || blob.size === 0) return {};
  const type = contentType.split(";")[0].trim() || blob.type || "";
  const name = safeName(url.searchParams.get("name") || fallbackName(type));
  return { blob, name, type };
}

async function tgUpload(env, upload, mode) {
  const method = mode === "photo" ? "sendPhoto" : "sendDocument";
  const field = mode === "photo" ? "photo" : "document";

  const form = new FormData();
  form.set("chat_id", env.CHAT_ID);
  form.set(field, new File([upload.blob], upload.name, { type: upload.type || "application/octet-stream" }));

  const res = await fetch(`${tgApi(env)}/bot${env.BOT_TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    const reason = data && data.description ? data.description : `HTTP ${res.status}`;
    throw new Error(`Telegram 上传失败：${reason}`);
  }
  return data.result;
}

async function tgGetFilePath(env, fileId) {
  const res = await fetch(`${tgApi(env)}/bot${env.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) return null;
  return (data.result && data.result.file_path) || null;
}

function tgApi(env) {
  return (env.TG_API || DEFAULT_TG_API).replace(/\/+$/, "");
}

function pickLargestPhoto(photos) {
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos[photos.length - 1];
}

function usage(url, env) {
  const { maxWidth, maxHeight, maxBytes } = config(env);
  return {
    ok: true,
    service: "CF + Telegram 图床 API",
    endpoints: {
      "POST /upload": "上传文件，返回链接与基础信息；图片宽高超过上限直接报错",
      "GET /f/<key>": "访问图片（Worker 代理 Telegram 文件流）",
      "GET /api": "接口说明 JSON",
    },
    example: {
      multipart: `curl -F "file=@a.jpg" ${url.origin}/upload`,
      binary: `curl --data-binary @a.jpg -H "Content-Type: image/jpeg" "${url.origin}/upload?name=a.jpg"`,
      photo_mode: `curl -F "file=@a.jpg" "${url.origin}/upload?mode=photo"`,
    },
    limits: {
      max_upload: bytesLabel(maxBytes),
      max_width: maxWidth,
      max_height: maxHeight,
      format: "保持原始格式；0 表示不限制尺寸",
    },
  };
}

function readLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-max-age": "86400",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
  });
}

function isFile(value) {
  return typeof File !== "undefined" && value instanceof File;
}

function safeName(name) {
  const cleaned = String(name).replace(/[\\/\r\n"']/g, "_").trim();
  return (cleaned || "file").slice(0, 120);
}

function fallbackName(type) {
  const ext = EXT_BY_MIME[type] || "bin";
  return `upload-${Date.now()}.${ext}`;
}

function extOf(name) {
  const match = /\.([a-z0-9]{1,8})$/i.exec(String(name || ""));
  return match ? match[1].toLowerCase() : "";
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// 配置项展示用，整 MB 时不带小数
function bytesLabel(bytes) {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MB` : humanSize(bytes);
}

function encodeKey(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeKey(key) {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------- 图片宽高：只解析文件头，不解码整张图 ----------

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|tiff?|heic|jfif)$/i;
const HEAD_BYTES = 1024 * 1024;

function isImage(type, name) {
  return Boolean(type && type.startsWith("image/")) || IMAGE_EXT.test(name || "");
}

async function imageSize(blob) {
  const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
  const size = parseSize(head);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

function parseSize(b) {
  const len = b.length;
  if (len < 26) return null;

  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }

  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }

  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) {
    return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)) };
  }

  // WebP
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 " && len >= 30) {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    if (chunk === "VP8L" && len >= 25) {
      const b0 = b[21];
      const b1 = b[22];
      const b2 = b[23];
      const b3 = b[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8X" && len >= 30) {
      return {
        width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
    return null;
  }

  // JPEG：逐段扫描 SOF
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= len) {
      if (b[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = b[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x00) {
        offset += 2;
        continue;
      }
      const segmentLength = (b[offset + 2] << 8) | b[offset + 3];
      if (segmentLength < 2) return null;
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (offset + 9 > len) return null;
        return {
          width: (b[offset + 7] << 8) | b[offset + 8],
          height: (b[offset + 5] << 8) | b[offset + 6],
        };
      }
      offset += 2 + segmentLength;
    }
  }

  return null;
}

function u32be(b, i) {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function u16le(b, i) {
  return b[i] | (b[i + 1] << 8);
}

function i32le(b, i) {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
}

function ascii(b, start, length) {
  let text = "";
  for (let i = start; i < start + length && i < b.length; i += 1) {
    text += String.fromCharCode(b[i]);
  }
  return text;
}

// ---------- 前端页面 ----------

function page(url, env) {
  const { maxWidth, maxHeight, maxBytes } = config(env);
  const limitText =
    maxWidth > 0 && maxHeight > 0
      ? `${maxWidth} × ${maxHeight}`
      : maxWidth > 0
        ? `宽 ≤ ${maxWidth}`
        : maxHeight > 0
          ? `高 ≤ ${maxHeight}`
          : "不限";
  const configured = Boolean(env.BOT_TOKEN && env.CHAT_ID);
  const origin = url.origin;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram 图床</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--line:#e5e7eb;--text:#1f2328;--muted:#6b7280;--primary:#2563eb;--danger:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:780px;margin:0 auto;padding:32px 20px 56px}
  h1{font-size:22px;margin:0 0 6px}
  h2{font-size:15px;margin:0 0 12px}
  .sub{color:var(--muted);font-size:13px;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
  .warn{background:#fef2f2;border-color:#fecaca;color:#b91c1c;font-size:13px}
  .drop{border:2px dashed #cbd5e1;border-radius:10px;padding:34px 16px;text-align:center;color:var(--muted);cursor:pointer;transition:.15s}
  .drop:hover,.drop.over{border-color:var(--primary);background:#eff6ff;color:var(--primary)}
  .drop b{color:var(--text)}
  .hint{font-size:12px;color:var(--muted);margin-top:10px}
  .hint code{background:#f1f5f9;border-radius:4px;padding:1px 5px}
  #status{font-size:13px;color:var(--muted);margin-top:12px;display:none}
  .err{color:var(--danger);font-size:13px;margin-top:12px;white-space:pre-wrap;display:none}
  #result{display:none;margin-top:16px;border-top:1px solid var(--line);padding-top:16px}
  #preview{max-width:100%;max-height:260px;border-radius:8px;border:1px solid var(--line);display:block;margin-bottom:14px}
  .row{display:flex;gap:8px;align-items:center;margin:7px 0}
  .row label{width:72px;color:var(--muted);font-size:12px;flex:none}
  .row input{flex:1;min-width:0;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;background:#fafafa;color:var(--text)}
  button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--text);padding:5px 12px}
  button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
  .tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
  .tabs button{font-size:12px;padding:4px 10px}
  .tabs button.active{background:#eef2ff;border-color:#c7d2fe;color:#3730a3}
  pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;overflow:auto;font-size:12px;line-height:1.7;margin:0 0 10px;font-family:Consolas,Monaco,monospace}
  .pre-wrap{position:relative}
  .pre-wrap button{position:absolute;top:8px;right:8px;font-size:11px;padding:3px 8px;background:#1e293b;border-color:#334155;color:#cbd5e1}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:500}
  .ok{color:#059669;font-size:12px;margin-left:6px}
  .foot{color:var(--muted);font-size:12px;text-align:center;margin-top:22px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Telegram 图床</h1>
  <p class="sub">图片经 Cloudflare Worker 转发到 Telegram 保存，上传后返回可直接引用的链接。</p>

  ${configured ? "" : '<div class="card warn">当前 Worker 还未配置 <b>BOT_TOKEN</b> 或 <b>CHAT_ID</b>，上传会失败。请在 Cloudflare 控制台的 Settings → Variables and Secrets 里添加后重新部署。</div>'}

  <div class="card">
    <div id="drop" class="drop">把图片拖到这里，或 <b>点击选择文件</b>
      <div class="hint">单文件最大 ${bytesLabel(maxBytes)}，图片尺寸上限 ${limitText}</div>
    </div>
    <input id="file" type="file" accept="image/*" hidden>
    <div id="status">上传中…</div>
    <div id="err" class="err"></div>

    <div id="result">
      <img id="preview" alt="">
      <div class="row"><label>链接</label><input id="url" readonly><button id="copy">复制</button></div>
      <div class="row"><label>文件名</label><input id="name" readonly></div>
      <div class="row"><label>大小</label><input id="size" readonly></div>
      <div class="row"><label>尺寸</label><input id="dim" readonly></div>
      <div class="row"><label>上传时间</label><input id="time" readonly></div>
    </div>
  </div>

  <div class="card">
    <h2>调用 API</h2>
    <div class="tabs">
      <button data-tab="curl" class="active">curl</button>
      <button data-tab="fetch">JavaScript fetch</button>
      <button data-tab="python">Python</button>
    </div>
    <div class="pre-wrap">
      <pre class="code" data-tab="curl">curl -F "file=@a.jpg" ${origin}/upload</pre>
      <pre class="code" data-tab="fetch" hidden>const form = new FormData();
form.append("file", fileInput.files[0]);

const res = await fetch("${origin}/upload", { method: "POST", body: form });
const data = await res.json();
console.log(data.url);</pre>
      <pre class="code" data-tab="python" hidden>import requests

with open("a.jpg", "rb") as f:
    r = requests.post("${origin}/upload", files={"file": f})
print(r.json()["url"])</pre>
      <button id="copyCode">复制</button>
    </div>
    <p class="hint">接口：<code>POST /upload</code>，multipart/form-data 字段名 <code>file</code>，也可以直接二进制 body 并带 <code>?name=a.jpg</code>。返回 JSON，取其中的 <code>url</code> 即可。</p>
  </div>

  <div class="card">
    <h2>返回字段</h2>
    <table>
      <tr><th>字段</th><th>说明</th></tr>
      <tr><td>url</td><td>图片访问链接，长期有效</td></tr>
      <tr><td>name / mime / size</td><td>文件名、类型、字节数</td></tr>
      <tr><td>width / height</td><td>图片宽高（能识别格式时返回）</td></tr>
      <tr><td>uploaded_at</td><td>上传时间，ISO 格式</td></tr>
      <tr><td>file_id / message_id</td><td>Telegram 文件标识和消息 ID</td></tr>
    </table>
  </div>

  <p class="foot">接口无鉴权，请勿把地址公开给不可信的人。</p>
</div>

<script>
(function(){
  var drop = document.getElementById("drop");
  var input = document.getElementById("file");
  var statusEl = document.getElementById("status");
  var errEl = document.getElementById("err");
  var resultEl = document.getElementById("result");
  var currentUrl = "";

  function setErr(text){
    errEl.textContent = text || "";
    errEl.style.display = text ? "block" : "none";
  }

  function fill(id, value){
    document.getElementById(id).value = value;
  }

  function show(data){
    currentUrl = data.url;
    document.getElementById("preview").src = data.url;
    fill("url", data.url);
    fill("name", data.name || "");
    fill("size", data.size_human || String(data.size || ""));
    fill("dim", data.width ? data.width + " × " + data.height : "—");
    fill("time", data.uploaded_at ? new Date(data.uploaded_at).toLocaleString() : "");
    resultEl.style.display = "block";
  }

  function upload(file){
    if (!file) return;
    setErr("");
    resultEl.style.display = "none";
    statusEl.style.display = "block";
    statusEl.textContent = "上传中… " + file.name;

    var form = new FormData();
    form.append("file", file);

    fetch("/upload", { method: "POST", body: form })
      .then(function(res){
        return res.json().then(function(data){ return { status: res.status, data: data }; });
      })
      .then(function(out){
        statusEl.style.display = "none";
        if (!out.data || !out.data.ok) {
          setErr((out.data && out.data.error) || ("上传失败，HTTP " + out.status));
          return;
        }
        show(out.data);
      })
      .catch(function(e){
        statusEl.style.display = "none";
        setErr("网络错误：" + e.message);
      });
  }

  drop.addEventListener("click", function(){ input.click(); });
  input.addEventListener("change", function(){ upload(input.files[0]); input.value = ""; });

  ["dragenter","dragover"].forEach(function(name){
    drop.addEventListener(name, function(e){ e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave","drop"].forEach(function(name){
    drop.addEventListener(name, function(e){ e.preventDefault(); drop.classList.remove("over"); });
  });
  drop.addEventListener("drop", function(e){
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files[0]) upload(files[0]);
  });

  function copyText(text){
    if (!text) return;
    navigator.clipboard.writeText(text).then(function(){
      var btn = document.getElementById("copy");
      btn.textContent = "已复制";
      setTimeout(function(){ btn.textContent = "复制"; }, 1200);
    }).catch(function(){ setErr("复制失败，请手动选择文本复制"); });
  }

  document.getElementById("copy").addEventListener("click", function(){ copyText(currentUrl); });
  document.getElementById("copyCode").addEventListener("click", function(){
    var active = document.querySelector("pre.code:not([hidden])");
    if (active) copyText(active.textContent);
  });

  var tabs = document.querySelectorAll(".tabs button");
  Array.prototype.forEach.call(tabs, function(btn){
    btn.addEventListener("click", function(){
      Array.prototype.forEach.call(tabs, function(b){ b.classList.remove("active"); });
      btn.classList.add("active");
      Array.prototype.forEach.call(document.querySelectorAll("pre.code"), function(pre){
        pre.hidden = pre.getAttribute("data-tab") !== btn.getAttribute("data-tab");
      });
    });
  });
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
