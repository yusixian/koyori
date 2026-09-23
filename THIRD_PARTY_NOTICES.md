# 第三方与来源说明

## Skills Manager

Skills 实现与兼容性研究参考 [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)，检查的版本为 `6ae02e39d9efea0faf75e643b8205f97833a593d`，上游采用 MIT，版权为 Tianliang Zhang。

当前 Koyori 扫描器独立实现，没有引入其源码、测试数据或客户端映射表。实际引入或改编代码时，必须在此添加上游文件与本地文件映射、变更范围，并随源码及安装包附上完整上游许可证。README 中的感谢不能替代许可文本。

## 依赖

包版本由 `pnpm-lock.yaml` 固定。构建时收集桌面运行时依赖的许可原文，以及 Electron 自带的许可和 Chromium 第三方通知，放在应用 `Contents/Resources/licenses`；该目录的 `manifest.json` 记录包名、版本、许可与文件映射。缺少必要许可时构建失败。公开发行前仍须核对安装包所含依赖与其许可证文件，不把此说明当成完整依赖许可清单。

当前更新链路使用以下依赖：

- `electron-updater@6.8.9`：通过 electron-builder 的标准 metadata 检查、下载和安装桌面更新。上游 package 来源为 [`electron-updater@6.8.9`](https://github.com/electron-userland/electron-builder/tree/electron-updater%406.8.9/packages/electron-updater)，对应提交 `5c6cbfdef0a0a34bc45ba3c40342ffca1d852ae7`，许可为 MIT；包内 `LICENSE` 会由收集脚本复制。
- `semver@7.8.5`：core 用于严格版本解析和 preview/stable 渠道识别。上游提交为 [`6e05b7637396ac66522cff8731f07cfe0ef49a29`](https://github.com/npm/node-semver/tree/6e05b7637396ac66522cff8731f07cfe0ef49a29)，许可为 ISC；包内 `LICENSE` 会由收集脚本复制。
- `lazy-val@1.0.5`：`electron-updater` 的运行时依赖，用于延迟值。npm 对应上游提交为 [`b69ad4119f1b19bdab13c61ee2fcc88d46b89071`](https://github.com/develar/lazy-val/tree/b69ad4119f1b19bdab13c61ee2fcc88d46b89071)，上游 `package.json` 声明 MIT 并标注 author attribution 为 Vladimir Krivosheev，但该版本上游提交未包含许可原文或版权通知。收集脚本只对精确的 `lazy-val@1.0.5` 使用 [带来源说明的 SPDX MIT 标准条款 fallback](third-party/licenses/lazy-val@1.0.5.MIT.txt)；其他缺少许可文件的包仍使构建失败。

## 品牌与私有服务

正式 Logo 的来源与使用范围见 [品牌说明](brand/README.md)。私有 Bot 通过未来的服务接口连接，其实现、配置、凭据和素材不属于本仓库内容。
