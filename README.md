# 拾光存档 · Chrome / Edge 开源测试版

把当前公开公众号文章保存成可离线打开的单文件 HTML。

[项目主页](https://github.com/xiangxiuchen/shiguang-wechat-article-archiver) · [问题反馈](https://github.com/xiangxiuchen/shiguang-wechat-article-archiver/issues) · [MPL-2.0](./LICENSE.md)

## 这版的边界

- 基础保存功能不连接 AI 模型，模型调用 **0 次**，Token 消耗 **0**。
- 正文整理、图片内嵌和文件生成都在浏览器本机完成。
- 每次只处理用户主动打开的一篇 `mp.weixin.qq.com` 公开文章。
- Beta 版同一时间只运行一个保存任务，避免多标签页任务混淆。
- 不读取 Cookie、聊天记录、公众号后台、浏览历史或其他网页。
- 不包含统计追踪、广告、模型 SDK、API Key 或开发者服务器。
- 首次保存需要联网获取原文图片；生成的 HTML 打开时不会再次请求远程图片。

## 安装测试版

朋友测试版 ZIP 解压后，先双击最外层的 `00-先看这里-安装导航.html`。它是一张完全离线的中文导航页，会根据 Chrome / Edge 分别说明 Windows 与 Mac 的安装、固定图标、首次图片权限、更新和卸载。导航页不加载远程脚本、图片或统计服务。

请使用 Chrome 123+ 或 Edge 123+。这让扩展能在用户点击后可靠地打开刚完成的本地存档，并在系统无法直接打开时回退到文件夹定位。

### Chrome

1. 打开 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 ZIP 解压后的 `shiguang-archive-extension` 文件夹；文件夹内应直接看到 `manifest.json`。
5. 把“拾光存档”固定到浏览器工具栏。

### Edge

1. 打开 `edge://extensions/`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择 ZIP 解压后的 `shiguang-archive-extension` 文件夹；文件夹内应直接看到 `manifest.json`。

## 使用

1. 在 Chrome 或 Edge 打开一篇公开公众号文章。
2. 点击“拾光存档”。
3. 确认文章标题、公众号和图片数量。
4. 点击“保存当前文章”。
5. 首次保存含图片文章时，浏览器会询问是否允许读取微信图片域名；同意后才会下载原图。拒绝时只保存正文，图片位置使用本地占位提示。
6. 等待浏览器下载完成，结果会显示完整成功或部分内容未保留。
7. 点击“打开已保存文章”直接查看离线 HTML；若系统无法直接打开，扩展会回退到“在文件夹中显示”。
8. 遇到问题可点击弹窗底部“复制安全反馈”。反馈只包含版本、平台、浏览器主版本、状态、阶段、错误编号和计数，不含文章内容、链接、文件名或任务标识，也不会自动发送。

## 输出

- 文件名包含发布日期、公众号、文章标题和原文短哈希。
- 重复保存由浏览器自动添加编号，不覆盖旧文件。
- 输出固定保留公众号、作者／发布时间、原文链接和存档时间。
- 脚本、表单、iframe、SVG、事件属性和危险链接会被移除。
- 图片失败或未获图片权限时使用本地占位提示，不保留远程 `src`。
- 检测到背景图、画布、矢量图或互动组件等无法离线保留的内容时，只能标记为部分成功，并显示损失摘要。
- 表单、模板、无脚本区等特殊结构被安全移除时会记录内容损失，不会误报完整成功。

## 当前限制

- 只支持公开公众号文章，不处理登录、付费、删除或访问受限内容。
- 音频、视频、小程序和互动组件不会离线保存。
- 目前只允许下载 `mmbiz.qpic.cn` 的文章图片；其他图片会进入部分成功状态。
- 图片同时受单图体积、像素、帧数、帧像素以及整篇累计像素预算约束；达到上限后剩余图片使用本地占位，避免浏览器异常占用内存。
- 扩展不会把文章转成 PDF；可打开离线 HTML 后使用浏览器打印功能保存 PDF。
- macOS Chrome 已完成最终构建包自动化验证，并完成至少一篇真实公开文章的保存与打开；完整文章矩阵仍未完成。
- macOS Edge、Windows Chrome 和 Windows Edge 均未完成实机验收，不能据此声称已经正式跨平台发布。

## 开发与测试

```bash
npm ci
npm test
npm run test:browser
npm run build
npm run release
```

首次运行浏览器测试前可执行 `npx playwright install chromium`。测试优先使用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定的浏览器，再查找 Playwright 缓存或系统已安装的 Chrome / Edge。

`npm run release` 是唯一发布入口，会依次执行版本一致性、单元与契约测试、最终 `dist` 浏览器测试、可重复打包、解包复测及发布包测试。成功后生成：

- `release/拾光存档-v<版本>-朋友测试版.zip`：ZIP 根目录包含 `00-先看这里-安装导航.html`，旁边的 `shiguang-archive-extension` 是要加载的扩展文件夹；
- `release/拾光存档-v<版本>-Chrome-Web-Store.zip`：`manifest.json` 位于 ZIP 根目录，供商店提交；
- `release/RELEASE-MANIFEST.json` 与 `release/SHA256.txt`：记录两个包的 SHA-256。

自动化通过不等于真实平台验收。Mac / Windows 与 Chrome / Edge 的实机文章矩阵以 `RELEASE-CHECKLIST.md` 为准。

## 开源、支持与隐私

- `pages/privacy.html`：安装包内隐私说明；
- `PERMISSIONS.md`：逐项解释浏览器权限；
- `SUPPORT.md`：安全反馈、卸载和当前实机支持状态；
- `LICENSE.md`：Mozilla Public License 2.0 完整条款；
- `NOTICE.md`：代码与第三方文章、素材之间的权利边界；
- `TRADEMARKS.md`：项目名称、图标和修改版的标识规则；
- `CONTRIBUTING.md` 与 `SECURITY.md`：贡献及私密漏洞报告规则。

项目源代码以 MPL-2.0 提供。修改并分发包含本项目代码的文件时，应继续按 MPL-2.0 提供相应源代码和许可证通知。项目名称、图标以及用户保存的文章内容不因代码开源而自动获得授权。

普通问题通过 [GitHub Issues](https://github.com/xiangxiuchen/shiguang-wechat-article-archiver/issues) 跟踪，安全漏洞通过 [GitHub Private Vulnerability Reporting](https://github.com/xiangxiuchen/shiguang-wechat-article-archiver/security/advisories/new) 私密提交。公开商店发布前仍需完成商店资料和真实跨平台验收。

## 非官方声明与使用边界

拾光存档是独立开发者工具，与微信及腾讯不存在隶属、合作或官方背书关系。请仅用于个人学习和资料备份；转载、再发布或商业使用，请先获得原作者授权。
