# 第三方与来源说明

## Skills Manager

Skills 实现与兼容性研究参考 [xingkongliang/skills-manager](https://github.com/xingkongliang/skills-manager)，检查的版本为 `6ae02e39d9efea0faf75e643b8205f97833a593d`，上游采用 MIT，版权为 Tianliang Zhang。

当前 Koyori 扫描器独立实现，没有引入其源码、测试数据或客户端映射表。实际引入或改编代码时，必须在此添加上游文件与本地文件映射、变更范围，并随源码及安装包附上完整上游许可证。README 中的感谢不能替代许可文本。

## 依赖

包版本由 `pnpm-lock.yaml` 固定。构建时收集桌面运行时依赖的许可原文，以及 Electron 自带的许可和 Chromium 第三方通知，放在应用 `Contents/Resources/licenses`；该目录的 `manifest.json` 记录包名、版本、许可与文件映射。缺少必要许可时构建失败。公开发行前仍须核对安装包所含依赖与其许可证文件，不把此说明当成完整依赖许可清单。

## 品牌与私有服务

正式 Logo 的来源与使用范围见 [品牌说明](brand/README.md)。私有 Bot 通过未来的服务接口连接，其实现、配置、凭据和素材不属于本仓库内容。
