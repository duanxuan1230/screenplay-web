# screenplay-web

基于 [Fountain](https://fountain.io/) 的网页剧本编辑器，手机、电脑都能用。

剧本以纯文本存在服务器上，用 git 记录每一次修改，也方便用 AI 或其他工具直接改文件。

## 功能

- **多剧本**：每个剧本独立的场景和笔记
- **实时预览**：边写边看标准剧本排版，中文友好
- **场景对比**：电脑上左右分两栏，对照前后场景写铺垫和呼应
- **全本通读**：按顺序连起来看整个剧本，点一场就跳过去编辑
- **修改历史**：停止编辑约 1 分钟后自动提交 git，每个剧本单独查看记录和改动
- **外部修改同步**：文件在别处被修改后，页面自动刷新；编辑冲突时提示选择版本
- **自适应布局**：手机上是抽屉式场景列表 + 预览/编辑切换

## 快速开始

需要 Node.js 20+。git 可选，没有 git 时只是不记录历史。

```bash
git clone <仓库地址> screenplay-web
cd screenplay-web
npm ci
npm start
```

打开 <http://127.0.0.1:8444>。首次启动会在 `data/` 里放一个示例剧本。

## 配置

全部通过环境变量设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8444` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址，默认只允许本机访问 |
| `SCREENPLAY_DATA` | `./data` | 剧本数据目录 |
| `SCREENPLAY_PASSWORD` | 空 | 设置后启用 HTTP Basic 认证 |
| `SCREENPLAY_USER` | `writer` | Basic 认证用户名 |

## 远程访问

服务本身**默认只监听本机**。需要在手机上用时，二选一：

**方式一：内置密码**

```bash
HOST=0.0.0.0 SCREENPLAY_PASSWORD='换成强密码' npm start
```

Basic 认证在明文 HTTP 下会暴露密码，建议配合 HTTPS 使用。

**方式二：反向代理（推荐）**

保持默认监听本机，由 nginx 负责 HTTPS 和认证。支持挂在子路径下：

```nginx
location /screenplay-web/ {
    auth_basic "screenplay-web";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://127.0.0.1:8444/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_buffering off;        # 实时同步使用 SSE，必须关闭缓冲
    proxy_read_timeout 1h;
    client_max_body_size 10m;
}
```

## 后台常驻

```bash
npm i -g pm2
pm2 start server.js --name screenplay-web
pm2 save
```

## 数据结构

```text
data/                    独立的 git 仓库，不进本仓库
└── <剧本名>/
    ├── scenes/          正文，一场一个 .fountain 文件，按文件名排序
    │   └── 001-开场.fountain
    └── notes/           一句话梗概、人物小传、分场大纲等（.md / .txt）
        └── 00-一句话梗概.md
```

文件就是普通文本，可以用任何编辑器或脚本修改，页面会自动同步。

## Fountain 速查

```fountain
.1 夜 内 便利店          ← 以 . 开头：场景标题（中文场景必须加 .）

雨很大。                 ← 普通段落：动作描写

小林                     ← 单独一行的角色名（中文名直接写）
(抬头)                   ← 括号：表演提示
关东煮还剩一串。          ← 紧跟角色名：对白

> 切至：                 ← 以 > 开头：转场
```

完整语法见 [fountain.io/syntax](https://fountain.io/syntax)。

## 安全说明

- 服务没有用户体系，能访问页面的人就能读写全部剧本
- 写操作要求自定义请求头，用于防御跨站请求
- 文件路径严格限制在 `data/<剧本>/{scenes,notes}/` 内，只允许 `.fountain`、`.md`、`.txt`

## 致谢

排版解析使用 [fountain-js](https://github.com/jonnygreenwald/fountain-js)。

## 许可证

[MIT](LICENSE)
