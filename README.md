# PWA Walkie Talkie

这是一个适合 XAMPP 的 PHP 8.3+、Vanilla JavaScript、WebRTC 音频和 PWA 示例。它不使用数据库，房间状态保存在 `storage/rooms` 的 JSON 文件中，并通过文件锁保证 PTT 抢占操作不会同时成功。

## 安装

1. 将项目放到 `C:\xampp\htdocs\project14_walkie_talkie`。
2. 复制 `.env.example` 为 `.env`，并将 `SIGNAL_SECRET` 改成随机长字符串。
3. 确认 Apache 已启用 `mod_rewrite`，启动 Apache。
4. 打开 `http://localhost/project14_walkie_talkie/`。
5. 两个浏览器使用相同频道名测试，并允许麦克风。

如果线上控制台显示 `app.css`、`app.js` 或 `manifest.webmanifest` 404，请确认整个项目目录已上传（特别是 `assets/`、`icons/` 和 `manifest.webmanifest`），并让网站 Document Root 指向本项目目录。新版入口也提供了 `index.php?asset=...` 回退路径，不依赖 Apache rewrite；部署后可直接测试 `/index.php?asset=app.css`。

生产环境和手机麦克风通常要求 HTTPS。仅使用 STUN 无法保证所有 NAT/企业网络都能连通；生产部署应增加 TURN 服务器，并把 ICE 配置移到服务端生成的配置中。此基础版本为 2–8 人 mesh 音频，人数更多时应改用 SFU。

## 目录

- `index.php`：页面、路由、认证、JSON 房间和信令 API
- `assets/app.js`：加入、轮询、PTT、WebRTC mesh 和音量条
- `assets/app.css`：响应式深色界面
- `manifest.webmanifest`、`sw.js`：PWA
- `icons/`：手机和电脑安装时使用的应用图标
- `storage/rooms`、`storage/logs`：运行时目录，不应提交真实会话数据

加入页面会显示二维码。二维码只包含公开应用地址，不包含昵称、频道、会话 Token 或麦克风信息。用手机扫描后即可打开页面，再点击安装按钮；如果是 iPhone Safari，请使用“分享 → 添加到主屏幕”。

## 下载 / 安装到手机或电脑

项目采用 PWA 安装模式，不需要打包成 EXE 或 APK。用手机或电脑浏览器打开网站后，点击页面上的 `DOWNLOAD / INSTALL APP`：

- Android Chrome：确认安装，应用会出现在应用列表和主屏幕。
- Windows / macOS Chrome 或 Edge：确认 `Install Walkie Talkie`，应用会以独立窗口运行。
- iPhone / iPad Safari：点击浏览器的“分享”，选择“添加到主屏幕”。Safari 不会触发 Windows/Android 那种安装弹窗，这是正常行为。

安装功能需要从 `localhost` 或 HTTPS 域名访问。手机测试时不要使用电脑的 `localhost`，应使用电脑局域网 IP，例如 `https://192.168.1.20/project14_walkie_talkie/`；生产环境必须配置 HTTPS 才能可靠使用麦克风和 PWA。

## 故障排查

- 麦克风不可用：使用 HTTPS、允许浏览器麦克风权限，确认没有其他应用占用。
- 房间满：修改 `.env` 的 `SIGNAL_MAX_PEERS`。
- 房间关闭：所有成员点击离开后，房间 JSON 文件会被删除；如果浏览器异常关闭，服务端会在 `SIGNAL_PEER_TIMEOUT_SECONDS` 秒没有心跳后清除成员，最后一名成员超时后房间也会自动删除。
- 无法听到对方：检查浏览器控制台、网络防火墙，并配置 TURN。
- PWA 不安装：必须从 HTTPS 或 localhost 访问，且确认 manifest 与 service worker 可访问。
