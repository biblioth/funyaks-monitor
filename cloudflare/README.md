# Cloudflare 主监控部署

这个 Worker 每分钟检查一次 Funyaks，D1 保存唯一状态，Cloudflare Queues 负责通知重试。GitHub Actions 每 5 分钟从 Cloudflare 外部检查 `/health`；Cron 漏跑时先调用 `/check` 自愈，仍失败才运行 Python 独立兜底。

当前生产地址：<https://funyaks-monitor.spicyao-lakewatch.workers.dev>

## 1. 创建资源

```bash
cd cloudflare
npm ci
npx wrangler login
npx wrangler d1 create funyaks-monitor
npx wrangler queues create funyaks-notifications
npx wrangler queues create funyaks-notifications-dlq
```

本仓库已经填写当前生产 D1 的 `database_id`。如果复制到其他 Cloudflare 账户部署，请改成新建数据库返回的 ID。

初始化数据库：

```bash
npx wrangler d1 execute funyaks-monitor --remote --file=./schema.sql
```

## 2. 配置 Secrets

必须设置管理令牌，并至少选择一种通知：

```bash
npx wrangler secret put ADMIN_TOKEN

# 飞书
npx wrangler secret put FEISHU_WEBHOOK_URL
npx wrangler secret put FEISHU_WEBHOOK_SECRET

# 或 PushPlus
npx wrangler secret put PUSHPLUS_TOKEN
npx wrangler secret put PUSHPLUS_TOPIC
```

生产配置中的 `PUSHPLUS_CHANNELS` 为 `wechat,clawbot`，同一事件会分别投递到 PushPlus 微信和 Clawbot；飞书仍作为独立的第三条通知路径。

## 每周周报

每周日北京时间 10:00（UTC 02:00）发送过去 7 天的监控周报。每分钟 Cron 在 10 点这一小时内都会检查周报是否已创建，D1 的 `weekly_summary:YYYY-MM-DD` 幂等键确保只发送一次。GitHub 的 `Weekly monitor report` 工作流会在 10:10 调用 `/weekly-report` 作为跨平台兜底。

GitHub 仓库还需要配置变量：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_WEEKLY_REPORT_URL` | `https://...workers.dev/weekly-report` |

`ADMIN_TOKEN` 请使用密码管理器生成的长随机字符串，不要提交到仓库。

## 3. 验证并部署

```bash
npm test
npm run check
npx wrangler deploy
```

Cron Trigger 的新增或修改可能需要一段时间传播。部署后不要干等，立即手动建立状态：

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  https://funyaks-monitor.<你的-workers-subdomain>.workers.dev/check

curl https://funyaks-monitor.<你的-workers-subdomain>.workers.dev/health
```

健康接口应返回 HTTP 200 且 `ok: true`。如果通知尚未配置，它会故意返回 HTTP 503。

## 4. 启用 GitHub 外部看门狗

在 GitHub 仓库配置 Variables：

| 名称 | 值 |
| --- | --- |
| `CLOUDFLARE_HEALTH_URL` | `https://...workers.dev/health` |
| `CLOUDFLARE_CHECK_URL` | `https://...workers.dev/check` |

配置 Secrets：

| 名称 | 用途 |
| --- | --- |
| `CLOUDFLARE_ADMIN_TOKEN` | 与 Worker 的 `ADMIN_TOKEN` 完全一致 |
| `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` | GitHub 独立兜底通知 |
| `PUSHPLUS_TOKEN` / `PUSHPLUS_TOPIC` | GitHub 独立兜底的 PushPlus 微信与 Clawbot 通知 |

然后手动运行 `Cloudflare watchdog and fallback`。正常时 GitHub 只读健康状态，不访问预订页；Cloudflare 不健康时才启动独立检查。

## 5. 可选：GitHub 一键部署

配置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 两个 GitHub Secrets 后，可以手动运行 `Deploy Cloudflare monitor`。API Token 至少需要 Worker、D1 和 Queues 对本项目所需的编辑权限。

## 健康判定

以下任一情况会让 `/health` 返回 503：

- 超过 3 分钟没有成功检查；
- 超过 3 分钟 Cron 没有留下任何检查记录；
- 连续 2 个检查周期失败（每个周期内部已重试 3 次）；
- 没有配置通知渠道；
- 通知在队列中积压超过 15 分钟。

Queues 对失败通知最多重试 8 次，之后进入死信队列；D1 中未完成的投递还会保留，后续周期会再次入队，不会把一次发送失败当成已通知。

## 免费版与高可靠性

每分钟 1 次约为每天 1,440 个检查周期；本项目的 D1 读写量远低于免费版每天 500 万行读取、10 万行写入的额度。需要注意的是，Workers Free 的短周期 Cron CPU 上限较紧。代码已经保持轻量并通过 dry-run，但如果“尽可能不漏”比零成本更重要，建议使用 Workers Paid，并同时保留 GitHub 外部看门狗。
