# 剧本工作台

基于 Fountain 的网页剧本编辑器，适配手机和电脑。

- `server.js`：Node 服务（无框架），默认监听 `127.0.0.1:8444`
- `public/`：前端页面，排版用 [fountain-js](https://www.npmjs.com/package/fountain-js)
- `data/`：剧本数据，独立 git 仓库，不进本仓库；每个剧本一个子目录 `data/<剧本>/{scenes,notes}`

功能：多剧本、实时预览、左右对比、全本通读、按剧本查看修改历史（编辑停止约 1 分钟后自动提交）。

环境变量：`PORT`、`HOST`、`SCREENPLAY_DATA`（数据目录，默认 `./data`）。

```bash
npm ci        # 会自动 build fountain.bundle.js
npm start
```
