# macOS Preview 签名与发布

首版面向 macOS 13 及以上的 Apple Silicon Mac。根 `package.json` 是版本来源；签名候选的具体版本以后续发布提交为准。本文描述配置流程，不代表证书、公证或公开发行已经完成。

## Apple 凭据

需要 **Developer ID Application** 证书及其私钥，导出为带密码的 `.p12`。`iPhone Distribution`、`Apple Development` 和 `Mac App Distribution` 都不能代替它来分发站外 macOS 应用。创建 Developer ID 证书需要账户持有人；拥有 App 管理角色不代表拥有此权限。

可以由构建维护者在本机生成私钥和 CSR，将 **CSR 公钥申请文件**交给账户持有人。持有人在 Apple Developer 的 Certificates 页面选择 Developer ID Application，上传 CSR 后返回 `.cer`。私钥留在生成 CSR 的机器，将 `.cer` 与对应私钥组合导出 `.p12`。不要仅下载证书公钥后误认为拥有签名私钥，也不要撤销其他应用正在使用的证书。

公证使用 App Store Connect **团队 API 密钥**：需要 `.p8` 文件、Key ID 和 Issuer ID，并拥有提交公证所需权限。个人 API 密钥与团队密钥的参数不同，此流程只接入团队密钥。不使用订阅的“共享密钥”作为公证凭据。

## GitHub 环境

在仓库的 `preview-release` Environment 中配置以下 Secrets，并将部署分支限制为 `main`。凭据通过 GitHub Settings 或 `gh secret set --env preview-release` 从文件/标准输入上传，不写入仓库、Release 正文或命令行参数。

| Secret | 内容 |
| --- | --- |
| `CSC_LINK` | Developer ID Application `.p12` 的 Base64 内容 |
| `CSC_KEY_PASSWORD` | `.p12` 密码 |
| `APPLE_API_KEY_P8` | 公证团队 API 密钥 `.p8` 原文 |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |

签名任务在临时 macOS runner 中运行。`.p8` 只在签名步骤写入权限受限的临时文件，任务结束后删除；公共 PR 检查不获得这些 Secrets。应用安装包不包含任何签名私钥或公证凭据。

## 构建模式

- `pnpm package:mac`：本地未签名候选，不包含更新源配置，不会发布。
- 可信发布流水线选择 `manual` 时，以 `KOYORI_MANUAL_PREVIEW=1` 构建干净提交的未签名候选。它只支持下载后手动安装，不包含更新源配置；发布清单必须标明未签名。
- 签名任务设置 `KOYORI_SIGNED_RELEASE=1` 后运行同一命令：要求干净工作树、alpha 版本和全部凭据；启用 Developer ID 签名、Hardened Runtime、公证及 app ticket 验证。缺少身份或公证失败就中止。

签名候选同时生成 DMG、ZIP、blockmap 和 `alpha-mac.yml`。DMG 和 ZIP 内含已签名、公证的应用；DMG 容器本身不额外签名。`artifacts/candidate.json` 记录源码 commit、版本、架构和每份发行文件的摘要，不能仅凭生成了这个 JSON 就跳过安装验收。

## 发布与更新

发布流水线只接受 `main` 上 CI 成功的不可变提交。选择手动或签名模式后构建并验收同一份应用，再上传 draft Release 并回读校验资产。校验通过才公开 Release，最后生成供网站推广的发布清单。同版本 tag 或安装包不覆盖。手动模式没有应用内更新元数据，不宣称自动更新可用。

应用使用 `electron-updater` 的 GitHub provider 与打包器生成的元数据。Preview 使用 alpha 渠道，稳定渠道不自动收到 Preview，禁止降级。启动后检查新版；用户选择下载、取消或重试，下载完成后点击“重启并安装”。安装先阻止新任务、等待当前操作安全结束并保存 Agent 数据。普通退出不触发安装。

首次发行没有上一公开版本，升级验收记为不适用。后续版本必须补充真实的签名包升级与数据保留证据；单元测试和未签名候选不能作为自动安装已验收的证明。

## 参考

- [Apple Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [electron-builder 自动更新](https://www.electron.build/v26/docs/features/auto-update/)
- [electron-builder macOS 公证参数](https://www.electron.build/v26/docs/mac/)
