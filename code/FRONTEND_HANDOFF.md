# 前端交接说明

这份文档给前端同学直接使用。当前可以开始开发，不需要等后端第二轮完成。

## 1. 先看哪些文件

阅读顺序：

1. `前后端接口交接说明.docx`
2. `前端执行版说明.docx`
3. `城市道路突发事件应急抢修仿真与辅助决策系统开发总纲.docx`

日常开发主要以前两份为准。

## 2. 当前后端状态

后端当前已完成以下内容：

- `python main.py` 可启动
- 所有接口路径已存在
- 所有字段名已固定
- 所有接口统一返回 `{code, message, data}`
- 路网、事件、资源 CRUD 可真实写入 JSON
- 方案生成、仿真启动、仿真推进、报告聚合均可调用
- 方案会返回 `requiredMaterials`、`materialFeasible`、`materialShortage`
- 仿真会返回 `phase`、`teamPositions`、`currentAffectedVehicles`、`consumedMaterials`
- 支持同时管理多个事件，且允许最多 10 个处于 `running/paused` 的仿真

可以直接开始做前端，不需要等待算法再精修。

## 3. 本轮前端目标

前端这轮重点是把页面和交互搭起来，不需要自己实现业务逻辑。

优先完成：

1. 六个 Tab 框架
2. API 封装
3. `loadState()`
4. SVG 路网渲染
5. 事件管理页面
6. 路网管理页面
7. 资源管理页面
8. 方案卡片与推荐高亮
9. 仿真进度条与日志
10. 报告页展示和导出按钮

## 4. 前端禁止自己处理的逻辑

以下逻辑一律以后端返回为准：

- 路径规划
- 方案评分
- 推荐方案判断
- 仿真进度计算
- 物资是否足够、启动时库存是否扣减
- 道路状态恢复
- 队伍 `busy/idle` 切换

## 5. 当前稳定可依赖的接口

优先使用这些接口开发页面：

- `GET /api/state`
- `GET /api/events`
- `POST /api/events`
- `PUT /api/events/{id}`
- `DELETE /api/events/{id}`
- `GET /api/nodes`
- `GET /api/edges`
- `GET /api/teams`
- `GET /api/depots`
- `POST /api/plans/generate`
- `GET /api/plans/{eventId}`
- `POST /api/simulation/start`
- `POST /api/simulation/step`
- `POST /api/simulation/pause`
- `POST /api/simulation/resume`
- `POST /api/simulation/reset`
- `POST /api/simulation/speed`
- `GET /api/simulation/{simulationId}`
- `GET /api/report/{eventId}`
- `GET /api/report/{eventId}/export`

## 6. 前端开发规则

- 统一用相对路径调用接口
- 每次请求后判断 `result.code`
- `result.code !== 200` 时直接展示 `result.message`
- 所有提交类操作都加 `isSubmitting`
- 方案卡片必须标注“分数越低越优”，不要按“越高越优”理解
- 仿真运行时前端需要自行用定时器轮询调用 `POST /api/simulation/step`
- `simulation.phase` 可用于做图形化动画：`dispatch` / `travel` / `repairing` / `finishing` / `finished`
- `simulation.teamPositions` 可直接驱动 SVG 上队伍位置更新
- `simulation.currentAffectedVehicles` 可直接驱动“影响车辆”数字动态下降
- `plan.materialFeasible=false` 时，前端应禁止或二次确认启动该方案
- 以下操作成功后统一重新调用 `GET /api/state`

需要刷新 `state` 的操作：

- 创建事件
- 编辑事件
- 删除事件
- 加载场景
- 节点/道路新增编辑删除
- 队伍/仓库新增编辑删除
- 导入 `network.json`
- 导入 `resources.json`
- 生成方案
- 启动仿真
- 推进一步
- 暂停仿真
- 继续仿真
- 重置仿真
- 调整仿真倍速

## 7. 运行方式

后端运行：

```bash
cd code
F:\anaconda3\envs\pytorch_env\python.exe main.py
```

浏览器访问：

```text
http://127.0.0.1:8000
```

## 8. 当前结论

前端现在可以正式联调。

建议前端同学先把：

- Tab 结构
- `fetch` 封装
- `loadState()`
- SVG 路网
- 方案与仿真区
- 仿真自动推进计时器

这几块先搭起来，后面再慢慢补样式和细节。
