# Funyaks + 大班楼放位监控

> **运行状态（2026-09-24）：Funyaks 已订到，监控现已暂停。** Cloudflare 不再请求 Funyaks 官网，GitHub 的 Funyaks 外部看门狗与周报工作流也已禁用。历史记录、通知配置和恢复能力均保留；大班楼监控继续运行。

同一个 Cloudflare Worker 监控：

- Dart River Adventures 官网的 **2027-02-02 Funyaks，1 位**；
- 香港大班楼（The Chairman）官网的 **2026-10-30、10-31、11-01，2 位，午餐或晚餐**。

生产 Worker：<https://funyaks-monitor.spicyao-lakewatch.workers.dev>

当前生产设计以 Cloudflare 为主：

```text
Cloudflare Cron（每分钟）
  → Funyaks 官网 HTML 重试检查
  → 大班楼 Queue-it 通行令牌 → 官方订位页检查
  → D1 唯一状态与去重
  → Cloudflare Queues
  → 飞书 / PushPlus 微信 / PushPlus Clawbot

GitHub Actions（每 5 分钟，外部看门狗）
  → /health
  → 异常时调用 /check 自愈
  → 仍异常时运行独立 Python 兜底
```

## 当前房态

2026-09-16 真实检查结果：Funyaks 9:30 AM 显示 `Trip full. Select next available departure.`。

监控精确匹配 Funyaks 和目标日期，不会把同页 Wilderness Jet 的余位误报。页面结构改变、超时或返回陌生格式时会记录为错误，不会伪装成“无位”。

大班楼监控每分钟通过官方 Queue-it 入口获取一次新的通行令牌，再访问官方订位页。官网当前可能返回 `Server Busy` / HTTP 429；这种情况只记录为源站繁忙，不会误报有位，也不会反复发送异常通知。只有目标日期附近出现明确可点击的日期或午/晚餐时段时才发送提醒。

## 可靠性策略

- Cloudflare 每分钟检查，单次最多请求 3 次；
- 大班楼每分钟只走一次 Queue-it + 官网请求，避免给持续限流的源站增加额外压力；
- D1 保存房态、连续失败次数、运行历史和每个通知渠道的投递状态；
- 第一次运行已经有位时立即提醒；持续有位不重复轰炸，重新售罄后再放位会再次提醒；
- 连续 2 个周期失败（共尝试 6 次官网请求）即发送“监控异常”，恢复后发送“监控已恢复”；
- 飞书、PushPlus 微信与 PushPlus Clawbot 分渠道投递，单个渠道失败不会阻塞其他渠道，Cloudflare Queues 负责重试并保留死信；
- `/health` 对调度停止、官网连续失败、通知未配置或通知积压返回 HTTP 503；
- GitHub 从 Cloudflare 外部做健康检查，在异常时运行独立兜底，并通过同一通知渠道发送一次去重后的异常/恢复消息。

当前生产环境已经启用飞书、PushPlus 微信和 PushPlus Clawbot 三条通知路径。这能显著降低静默漏检概率，但任何公网服务、目标网站和通知平台都无法提供绝对零失败保证。

## 每周监控周报

每周日北京时间 10:00 生成一次监控周报，并通过飞书、PushPlus 微信和 PushPlus Clawbot 同时发送。周报包含过去 7 天的检查次数、成功率、异常次数、平均/最大响应耗时、有位/无位观察次数、放位提醒、监控异常与恢复次数，以及当前房态。

周报使用 D1 幂等键去重。Cloudflare 每分钟任务会在周日 10:00–10:59 自动补偿重试；GitHub Actions 在 10:10 再调用一次受管理令牌保护的 `/weekly-report`，主任务已成功时只返回重复状态，不会再次通知。

## 部署

完整步骤见 [Cloudflare 部署说明](cloudflare/README.md)。首次部署的关键步骤：

1. 创建 D1、通知队列和死信队列；
2. 把真实 D1 ID 写入 `cloudflare/wrangler.jsonc`；
3. 配置 `ADMIN_TOKEN` 以及飞书/PushPlus Secrets；
4. 部署 Worker；
5. 手动调用一次 `/check`，确认 `/health` 返回 200；
6. 配置 GitHub 外部看门狗 URL 和兜底通知 Secrets。

## 本地测试

Python 独立监控：

```bash
python3 -m unittest discover -s tests -v
python3 funyaks_monitor.py --no-notify
```

Cloudflare Worker：

```bash
cd cloudflare
npm ci
npm test
npm run check
```

脚本只检查和提醒，不会自动提交订单或付款。
