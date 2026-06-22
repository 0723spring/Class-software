# 开发记录与已处理问题

本文档记录后端第一轮开发过程中遇到的关键问题、处理方式和后续建议，便于课程总结与答辩复盘。

## 1. 环境问题

- `pytorch_env` 初始缺少 `fastapi`
  - 处理：安装 `fastapi`
  - 影响：未安装前无法启动后端服务

- `uvicorn` 依赖的 `click` 包损坏
  - 现象：导入 `uvicorn` 时出现 `module 'click' has no attribute 'Choice'`
  - 排查结果：`site-packages/click/` 目录存在，但缺少 `__init__.py`
  - 处理：强制重装 `click`
  - 影响：未修复前 `python main.py` 无法启动

## 2. 后端实现问题

- 统一响应包装最初未生效
  - 现象：接口返回的不是统一 `{code, message, data}` 结构
  - 原因：装饰器未保留原函数元信息，导致 FastAPI 路由解析异常
  - 处理：在 `handle_service` 中增加 `@wraps(func)`

- 方案生成时 `planId` 有撞车风险
  - 现象：同一次生成的三个方案可能出现相同 `planId`
  - 风险：前端选择某个方案后，后端可能实际启动成另一方案
  - 处理：重写方案 ID 分配逻辑，保证单次生成的三个方案 ID 唯一

## 3. 已验证主流程

已跑通以下链路：

- `GET /api/state`
- `POST /api/events`
- `POST /api/plans/generate`
- `POST /api/simulation/start`
- `POST /api/simulation/step`
- `GET /api/report/{eventId}`

已验证以下异常：

- `running` 事件不可删除
- `busy` 队伍不可删除

## 4. 当前已知限制

- 第一轮前端页面只提供了最小静态页，用于确认 FastAPI 托管正常
- 仿真日志目前是基础版，可在第二轮继续细化
- 报告页目前是后端聚合数据，前端展示样式仍待接入

## 5. 第二轮建议

- 补充前端六个 Tab 的正式页面骨架
- 细化导入导出校验和错误提示
- 丰富仿真日志阶段信息
- 增加更多异常测试与联调测试记录

## 6. 第二轮已补强问题

- 协同方案不再天然占优
  - 处理：方案生成时按事件类型计算队伍技能匹配系数，非匹配队伍只提供有限效率贡献
  - 结果：`skill_first`、`nearest`、`collaboration` 会根据事件类型和队伍组合动态竞争，不再总是推荐最后一张方案卡

- 仿真恢复效果改为渐进式
  - 处理：仿真过程新增 `phase`、`currentAffectedVehicles`、`teamPositions`
  - 结果：前端可按步骤展示队伍移动、道路修复过程、影响车辆数下降

- 物资正式进入业务链路
  - 处理：方案阶段返回 `requiredMaterials`，仿真启动时校验库存并扣减，重置仿真时回滚库存
  - 结果：库存不足会阻止仿真启动，报告可展示消耗材料

- 支持多事件并行管理
  - 处理：允许多个事件同时存在，并允许最多 10 个 `running/paused` 仿真并行
  - 限制：同一事件同一时刻只允许一个活动仿真；同一队伍被占用后不可重复分配

## 7. 仓库整理建议

当前仓库已提交以下不应长期保留的中间产物：

- `_review_extracts/`
- `_review_extracts_ascii/`
- `code/__pycache__/`

建议后续增加 `.gitignore`，并在合适时机清理这些文件，避免仓库变乱。
