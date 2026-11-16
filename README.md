# Cloudflare + Telegram 图床 部署教程（网页端操作，无需命令行）

全程在浏览器里完成：Cloudflare 控制台粘贴代码、配置变量，Telegram 里建机器人。不需要安装 Node.js，不需要执行任何命令。

部署完成后你会得到：

- 一个网页上传页：打开就能拖图上传，直接拿到链接
- 一个 HTTP API：`POST /upload`，任何脚本/App 都能调用
- 图片保存在你的 Telegram 频道里，链接走 Cloudflare 域名，长期有效

---

## 一、准备工作

| 需要 | 说明 |
|---|---|
| Cloudflare 账号 | 免费注册，不需要信用卡 |
| Telegram 账号 | 用来创建机器人、建一个存图的频道 |
| 本项目代码 | 就是 [`src/index.js`](./src/index.js) 这一个文件，全部逻辑都在里面 |

> 整个项目只有一个 JS 文件，没有依赖、没有构建步骤，所以可以直接粘到 Cloudflare 的在线编辑器里运行。

---

## 二、创建 Telegram 机器人

1. 在 Telegram 搜索 **@BotFather**，点开，发送 `/newbot`
2. 按提示输入机器人显示名、用户名（用户名必须以 `bot` 结尾）
3. BotFather 会返回一串 Token，长这样：

```
1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

这串就是 `BOT_TOKEN`，先记下来，**不要发给别人**。

---

## 三、获取 CHAT_ID（纯浏览器操作）

机器人需要知道把图片发到哪个会话。推荐用私有频道，图片集中好管理。

### 步骤

1. Telegram 新建一个**私有频道**
2. 频道 → 管理员 → 添加你刚创建的机器人 → 勾选「发布消息」并保存
3. 在频道里随便发一条消息（比如「test」）
4. 浏览器新标签页打开下面这个地址，把 `<TOKEN>` 换成你的机器人 Token：

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

5. 页面会返回一段 JSON，在里面找：

```json
"chat": { "id": -1001234567890, "title": "我的图床", "type": "channel" }
```

这个以 `-100` 开头的负数就是 `CHAT_ID`。

> 如果返回 `{"ok":true,"result":[]}`，说明机器人还没收到任何消息，回频道再发一条，刷新页面。
>
> 也可以和自己机器人私聊：先点「开始」发一条消息，再访问上面的地址，`chat.id` 就是你的用户 ID（正数）。

---

## 四、在 Cloudflare 网页端创建 Worker

1. 浏览器打开 <https://dash.cloudflare.com> 并登录
2. 左侧菜单点 **Workers & Pages**
3. 点 **Create**（创建）→ 选 **Workers** 标签 → **Create Worker**
4. 给 Worker 起个名字，比如 `cf-tg-imagebed`（这个名字会出现在访问域名里）
5. 点 **Deploy**（部署），先让它创建一个默认的 Hello World 版本
6. 部署完成后点 **Edit code**（编辑代码），进入在线编辑器

> 第一次使用 Workers 时，控制台会让你注册一个 `workers.dev` 子域，随便起一个，例如 `myimg`，之后地址就是 `https://cf-tg-imagebed.myimg.workers.dev`。

---

## 五、粘贴代码并部署

1. 用任意编辑器打开本项目的 [`src/index.js`](./src/index.js)
2. **全选 → 复制**（Ctrl+A、Ctrl+C）
3. 回到 Cloudflare 在线编辑器，把左侧 `worker.js` 里的默认代码**全部删掉**
4. 粘贴刚才复制的内容
5. 右上角点 **Deploy**（部署）

部署成功后，点编辑器上方的访问链接，或在浏览器打开：

```
https://cf-tg-imagebed.<你的子域>.workers.dev
```

此时会看到图床页面，但顶部有红色提示「还未配置 BOT_TOKEN / CHAT_ID」，这是正常的，下一步填配置。

> 注意：粘贴后不要改动 `export default { ... }` 这个结构，Cloudflare 靠它识别入口。

---

## 六、配置变量与密钥

在 Worker 详情页：

1. 点 **Settings**（设置）→ **Variables and Secrets**（变量和密钥）
2. 依次点 **Add**（添加），添加下面四项：

| 名称 | 类型 | 值 |
|---|---|---|
| `BOT_TOKEN` | Secret（密钥） | 第二步拿到的机器人 Token |
| `CHAT_ID` | Secret（密钥） | 第三步拿到的 `-100...` |
| `MAX_WIDTH` | Text（文本） | `1920` |
| `MAX_HEIGHT` | Text（文本） | `1920` |
| `MAX_BYTES` | Text（文本） | 可不填，默认 `20971520`（20MB） |

3. 点 **Save and deploy**（保存并部署）让配置生效

说明：

- `BOT_TOKEN`、`CHAT_ID` 选 **Secret**，保存后页面不再显示明文，更安全
- `MAX_WIDTH` / `MAX_HEIGHT` 是图片宽高上限，超过就拒绝上传；填 `0` 表示该方向不限制
- `MAX_BYTES` 是单文件字节上限，默认 20MB（`20971520`），想限制更小就填字节数，例如 10MB 填 `10485760`
- 注意 Telegram 官方 Bot API 的下载上限是 20MB，`MAX_BYTES` 调得比 20MB 大时，超过 20MB 的文件能传上去但链接取不回来
- 改完变量如果只点了保存没部署，页面上不会生效，记得点部署

---

## 七、测试：打开网页上传

刷新 Worker 域名首页，红色提示应该消失了，页面从上到下是：

1. **上传区**：把图片拖进去，或点击选择文件，上传成功后自动展示预览、链接、文件名、大小、尺寸、上传时间，链接右侧有「复制」按钮
2. **调用 API**：curl / JavaScript fetch / Python 三种示例，代码里已经填好你当前的域名，可一键复制
3. **返回字段**：接口返回值的说明
4. 底部提示：接口没有鉴权

拖一张 1920×1920 以内的图片进去，出现「复制」成功提示就说明整条链路通了。

试一张超大图，页面会显示：

```
图片尺寸超限：4000×3000，最大允许 1920×1920
```

---

## 八、接口调用说明

### 1. 上传接口

```
POST https://<你的域名>/upload
```

两种提交方式，二选一：

**multipart/form-data（推荐）**

```bash
curl -F "file=@a.jpg" https://<你的域名>/upload
```

字段名固定为 `file`（其他字段名也会被识别为文件，但建议用 `file`）。

**直接二进制 body**

```bash
curl --data-binary "@a.jpg" -H "Content-Type: image/jpeg" "https://<你的域名>/upload?name=a.jpg"
```

这种方式必须用 `?name=` 指定文件名，否则会用默认名。

### 2. 前端 / Node.js 调用

```js
const form = new FormData();
form.append("file", fileInput.files[0]);

const res = await fetch("https://<你的域名>/upload", { method: "POST", body: form });
const data = await res.json();

if (data.ok) {
  console.log(data.url);
} else {
  console.log(data.error);
}
```

### 3. Python 调用

```python
import requests

with open("a.jpg", "rb") as f:
    r = requests.post("https://<你的域名>/upload", files={"file": f})
print(r.json()["url"])
```

### 4. 成功返回示例（HTTP 201）

```json
{
  "ok": true,
  "url": "https://<你的域名>/f/RkFLRV9GSUxFX0lEXzEyMw.jpg",
  "file_id": "AgACAgEAAxkBAA...",
  "file_unique_id": "AQAD...",
  "name": "a.jpg",
  "mime": "image/jpeg",
  "size": 182734,
  "size_human": "178.4 KB",
  "uploaded_at": "2026-11-14T14:20:00.000Z",
  "message_id": 42,
  "mode": "document",
  "width": 1280,
  "height": 853
}
```

拿 `url` 就能直接用在 `<img src>`、Markdown、CSS 背景里。

| 字段 | 说明 |
|---|---|
| `url` | 图片访问链接，长期有效 |
| `name` / `mime` / `size` | 文件名、MIME 类型、字节数 |
| `size_human` | 可读大小 |
| `width` / `height` | 图片宽高（能识别格式时才有） |
| `uploaded_at` | 上传时间（UTC） |
| `file_id` / `message_id` | Telegram 侧的文件和消息标识 |
| `mode` | `document`（原图）或 `photo`（Telegram 会压缩） |

### 5. 访问图片

```
GET https://<你的域名>/f/<key>.<ext>
```

由 Worker 从 Telegram 取流转发，带长期缓存头，可以放心做图床外链。

### 6. 查看接口说明 JSON

浏览器直接打开 `https://<你的域名>/api`，会返回接口列表、当前尺寸上限和调用示例，适合给其他程序看。

### 7. 可选参数

| 参数 | 说明 |
|---|---|
| `mode=photo` | 用 Telegram 的 `sendPhoto` 发送，图片会被压缩，图床不建议用 |
| `name=xxx.jpg` | 二进制上传时指定文件名 |

### 8. 错误返回

| 状态码 | 含义 |
|---|---|
| 400 | 没带文件 / 图片宽高超限 / 文件 ID 无效 |
| 404 | 文件不存在或被删除 |
| 413 | 文件超过 `MAX_BYTES`（默认 20MB） |
| 500 | 未配置 `BOT_TOKEN` 或 `CHAT_ID` |
| 502 | Telegram 报错（Token 错、机器人无权限等） |

尺寸超限时的返回：

```json
{
  "ok": false,
  "error": "图片尺寸超限：4000×3000，最大允许 1920×1920",
  "width": 4000,
  "height": 3000,
  "max_width": 1920,
  "max_height": 1920
}
```

---

## 九、以后修改代码或配置

全部在 Cloudflare 控制台完成：

**改代码**
1. Workers & Pages → 点你的 Worker → **Edit code**
2. 修改后用本地最新的 `src/index.js` 整体覆盖粘贴（避免漏改）
3. 点 **Deploy**

**改配置**
1. Settings → Variables and Secrets
2. 编辑 `MAX_WIDTH` / `MAX_HEIGHT`，或重新设置 `BOT_TOKEN` / `CHAT_ID`
3. 点 **Save and deploy**

**看运行日志**
1. Worker 详情页 → **Logs**（实时日志）
2. 上传一次图片，能看到请求路径、状态码和错误信息，排查问题时很有用

---

## 十、自定义域名（可选）

1. Worker 详情页 → **Settings** → **Domains & Routes**
2. 点 **Add** → **Custom domain**
3. 输入你的域名（需已托管在同一个 Cloudflare 账号下），按提示确认

绑定后把接口地址换成自己的域名即可，路径不变。

---

## 十一、常见问题

**Q：页面上传报「服务端未配置 BOT_TOKEN / CHAT_ID」**
变量没加或没部署。到 Settings → Variables and Secrets 检查名称拼写（全大写、带下划线），保存后点 Deploy。

**Q：报 `chat not found`**
`CHAT_ID` 不对，或者机器人不在那个会话里。频道方式确认机器人是管理员且有「发布消息」权限；私聊方式要先给机器人发过消息。

**Q：报 `401 Unauthorized` 或 `Telegram 上传失败：Unauthorized`**
`BOT_TOKEN` 填错了，重新设置一遍。

**Q：图片上传成功但链接打不开**
- 文件超过 `MAX_BYTES`：默认 20MB，这是 Telegram Bot API 的下载上限，上传时已拦截
- 频道里的那条消息被删了，文件也会失效

**Q：为什么不自动缩小图片？**
当前策略是「超过上限直接报错」，不做服务端压缩，节省 CPU。需要传大图就先把 `MAX_WIDTH` / `MAX_HEIGHT` 调大（比如 4096），或本地压好再传。

**Q：免费额度够用吗？**
只解析图片文件头判断宽高，不做转码，CPU 消耗极低。免费版每天 10 万次请求，个人图床绰绰有余。

**Q：安全吗？**
接口目前**没有鉴权**，任何知道域名的人都能上传，图片会进入你的 Telegram 频道。建议不要把域名公开传播；如果需要，可以后续给上传接口加一个 Token 校验。

---

## 十二、文档同步约定

本项目后续如果调整了接口、配置项或部署方式，会同步更新本教程，保持「教程 = 当前代码行为」。

当前版本对应：单文件 Worker、无转码、超尺寸报错、`MAX_WIDTH` / `MAX_HEIGHT` 默认 1920、`MAX_BYTES` 默认 20MB。
