# 权限说明

| 权限 | 用途 | 不会做什么 |
|---|---|---|
| `activeTab` | 用户点击扩展后，临时访问当前标签页 | 不长期读取其他标签页 |
| `scripting` | 将本地文章提取器临时注入当前文章页 | 不注入所有网页，不加载远程代码 |
| `downloads` | 创建并跟踪离线 HTML 下载 | 不读取或修改其他下载文件 |
| `downloads.open` | 仅在用户点击后打开这次已完成的离线 HTML | 不自动打开文件，不打开其他下载记录 |
| `offscreen` | 在隐藏的本机页面中整理图片和创建 Blob | 不上传数据，不后台遥测 |
| 可选的 `mmbiz.qpic.cn` | 经用户确认后下载文章公开图片 | 不访问任意网站或私网地址 |

扩展没有申请 `tabs`、`cookies`、`history`、`webRequest`、`nativeMessaging`、`unlimitedStorage` 或 `<all_urls>`。
