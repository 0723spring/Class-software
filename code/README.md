# 城市道路突发事件应急抢修仿真与辅助决策系统

## 运行方式

1. 使用 `F:\anaconda3\envs\pytorch_env\python.exe`
2. 进入 `code/`
3. 执行：

```bash
python main.py
```

4. 打开 `http://127.0.0.1:8000`

## 第一轮范围

- FastAPI 后端骨架
- JSON 持久化
- M1-M8 全量接口
- 路网/事件/资源 CRUD
- 基础路径规划、方案生成、仿真推进、报告聚合

## 目录说明

- `main.py`：启动、路由、静态托管
- `models.py`：请求模型与枚举
- `storage.py`：JSON 读写、原子写、默认数据
- `algorithms.py`：路径规划、技能匹配、评分
- `services.py`：业务规则和状态联动
- `data/`：本地 JSON 数据
- `static/`：前端静态页面
