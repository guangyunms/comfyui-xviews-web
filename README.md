# ComfyXViews Web

在 iPad Safari 中查看手动导入的 ComfyXViews 数据库。纯静态网页，无账号、登录或自动同步。
数据库及媒体保存在浏览器本地，不上传到 GitHub 或其他服务器。

## 在 iPad 上使用

1. 建议使用 iPadOS 17 或更新版本，用 Safari 打开 GitHub Pages 的 HTTPS 网址。
2. 如需从主屏幕启动，先用 Safari 分享菜单选择“添加到主屏幕”，随后在主屏幕版本中导入。
   Safari 标签页与主屏幕 App 的存储可能分开，请固定使用同一个入口。
3. 点“导入数据库”，选择已完整下载到 iPad“文件”中的 `.db` 文件。
4. 导入期间保持页面前台，等待数据库导入和离线程序缓存完成。首次加载需要网络。
5. 以后可离线浏览；手动下载新版数据库后重新导入。

支持按根目录、文件夹、分类和媒体类型筛选，空格分词搜索、分页、参数详情、提示词复制、
图片触摸缩放，以及数据库中 H.264/AAC MP4 预览的声音和进度控制。
旧库没有 MP4 预览时回退到已存储的动画 WebP。

数据库会复制到浏览器的本地存储。首次导入需要额外约一个数据库大小的空闲空间；
更新导入时暂时保留新旧两份，失败保留旧库。清理网站数据会清除本地副本，原文件不受影响。
一次只在一个标签页或主屏幕窗口中打开查看器。单个媒体预览的读取上限为 128 MiB。

尚未完成真实 iPad 的兼容性验证；浏览器可用空间、存储清理及视频解码能力可能因设备而异。

## 发布到 GitHub Pages

网页使用独立的公开仓库，与桌面端及安卓端的源码仓库分开。
公开仓库只保存查看器程序，不保存数据库、生成的图片视频、测试样本或私人项目的 Git 历史。

独立网页仓库提供 `.github/workflows/deploy.yml`：

1. 在仓库 Settings → Pages 中，将 Source 设为 GitHub Actions。
2. 推送到 `main`，或手动运行 `Deploy GitHub Pages` 工作流。
3. 工作流运行 `python stage.py`，只把明确列出的程序资源放入 `_site` 后发布。

使用相对路径，可部署到 GitHub Pages 的仓库子路径，无需域名配置、第三方运行时或 CDN。

## 本地开发

网页是 HTML、CSS 和 JavaScript ES Modules，无前端构建依赖。在独立网页仓库根目录运行：

```sh
python -m http.server 8765 --bind 127.0.0.1
```

电脑浏览器打开 `http://localhost:8765`。iPad 访问普通局域网 HTTP 地址不属于安全上下文，
不能可靠使用本地存储和离线功能；iPad 应通过 HTTPS 打开。直接在“文件”中打开 HTML 不是启动方式。

## 隐私与依赖

- 没有上传、统计分析、云盘授权或登录接口；数据库文件不会成为 HTTP 请求。
- 数据库在 Worker 内分块导入 OPFS；查询连接只读，列表查询不读取媒体 BLOB。
- service worker 只缓存查看器自身资源，数据库与缓存分开保存在设备本地。
- SQLite 官方 canonical WASM **3.54.0** 依赖随网页分发，不从 CDN 动态下载。
- 发行包地址及 SHA3-256 校验值在 `vendor/package-info.json`，原始上游说明在 `vendor/UPSTREAM-README.txt`。
- SQLite 源码属于公有领域；相关说明见 [SQLite 版权说明](https://sqlite.org/copyright.html)。
  SQLite WASM 随包源码保留原有版权与许可声明。

上游文档：[SQLite WASM](https://sqlite.org/wasm/)、[OPFS 持久化](https://sqlite.org/wasm/doc/trunk/persistence.md)。
