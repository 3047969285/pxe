---
author_name: 王英
category_id: 1
name: 培小e
summary: 培训数据智能助手：Excel 入库、查询、导出、建议名单、统计看板
core_features: Excel 自动识别入库、名额交叉表拍平、中文条件查询、Excel 导出与模板、应训未训建议名单、HTML 统计看板、学时自动汇总
trigger_keywords: 培小e,培训数据,培训名单,培训计划,培训记录,名额分配,领导人员,参训名单,建议名单,应训未训,培训看板,培训大屏,培训模板,导入培训,Excel导入,培训学时,调训规则,匹配规则,培训统计
trigger_mode: 用户提及培训数据、培训名单、培训计划、培训记录、名额分配、培训看板、培训模板、导入培训 Excel、出建议名单、统计培训数据等需求时触发；也适用于询问某班次或某单位的参训情况
use_scenarios: 培训 Excel 批量入库、查询班次或单位参训名单、导出培训明细、生成建议名单、生成培训看板
description: 培小e 是培训数据管理与分析智能体。所有能力已固化为命令，模型按本文路由到对应参考文件即可，不必自行拼接口、写脚本或改动技能文件。
---

# 培小e · 培训数据助手

**唯一入口。所有操作都是在 `scripts` 目录执行 `node index.js <命令>`。**

## 一、怎么用这个技能

1. 先看下面的**场景路由表**，找到用户需求对应的命令；
2. 命令直接执行，**不要探索代码、不要自建脚本、不要改技能文件**；
3. 只在命令报错或需要细节时，按表格右列**打开对应参考文件**。

### 场景路由表

| 用户需求 | 执行命令 | 需要细节时看 |
|---|---|---|
| 把 Excel 导进去 | `node index.js 导入 "<文件>"` | [导入指南](references/import.md) |
| 指定表导入 | `node index.js 导入 "<文件>" --table 人员\|计划\|名额\|记录\|规则` | [导入指南](references/import.md) |
| 导入名额交叉表 | `node index.js 导入 "<文件>" --wide` | [导入指南](references/import.md) |
| 查数据 | `node index.js 查询 <表> [--条件 字段=值] [--like 字段=值] [--字段 a,b] [--排序 字段] [--倒序] [--页 N] [--每页 N]` | [查询指南](references/query.md) |
| 导出 Excel | `node index.js 导出 <表>` | [产物说明](references/output.md) |
| 要空白模板 | `node index.js 模板 <表>` | [产物说明](references/output.md) |
| 改一条 | `node index.js 改 <表> 主键字段=值 字段=新值 [...]` | [命令全集](references/commands.md) |
| 删一条 | `node index.js 删 <表> 主键字段=值` | [命令全集](references/commands.md) |
| 出建议名单 | `node index.js 建议 --年度 2027 [--每单位上限 N]` | [规则引擎](references/rules.md) |
| 出统计看板 | `node index.js 看板 --年度 2027` | [规则引擎](references/rules.md) |
| 看全部命令 | `node index.js 帮助` | — |
| 检查运行环境 | `node index.js 自检` | [故障排查](references/troubleshooting.md) |
| 后端通不通 | `node index.js 自检`（或 `查询 规则 --每页 1`） | [故障排查](references/troubleshooting.md) |
| 字段叫什么 | — | [字段对照表](references/field_mapping.md) |
| 接口长什么样 | — | [接口契约](references/api_contract.md) |
| 命令报错了 | — | [故障排查](references/troubleshooting.md) |

### 用户原话直接对照

| 用户说 | 执行 |
|---|---|
| “把桌面这个人员表导进去” | `导入 "<路径>/人员表.xlsx"` |
| “导入名额分配表” | `导入 "<路径>/计划表.xlsx" --wide` |
| “查一下济南公司有哪些人” | `查询 人员 --条件 单位=济南公司 --每页 50` |
| “张三参加过什么培训” | `查询 记录 --条件 姓名=张三` |
| “姓王的领导” | `查询 人员 --like 姓名=王` |
| “今年还差哪些人没安排” | `建议 --年度 2027` |
| “做个培训看板” | `看板 --年度 2027` |
| “把某某的学时改成 40” | `改 记录 记录编号=<id> 学时=40` |
| “导出全部培训记录” | `导出 记录` |

## 二、六条铁律（照做，不必验证）

1. **只走接口** — 不连数据库、不执行 SQL、不改后端文件。后端地址见 `scripts/config.js` 的 `api.baseUrl` 与 `api.apiSecret`。
2. **结果只落「输出」文件夹**（技能包同级，自动创建），文件名中文；不在别处生成文件，不产生过程文件。
3. **重复导入安全** — 全部按业务唯一键 UPSERT，同一份 Excel 导多遍结果一样。
4. **学时自动算** — 培训记录是唯一事实来源，增删改记录会自动重算人员累计学时与培训记录，**不要手改这两列**。
5. **计划编号自动补** — 导入记录、名额只需给「年度+班次+期次」，系统自动匹配计划编号。
6. **删除是软删** — `del_flag` 置 2，数据仍在库里。

## 三、参考文件（按需打开，不必全读）

| 文件 | 什么时候看 |
|---|---|
| [命令全集](references/commands.md) | 查某条命令的完整参数与示例 |
| [导入指南](references/import.md) | 导入报错、表头对不上、日期格式、名额交叉表 |
| [查询指南](references/query.md) | 14 种运算符、中文字段、分页排序、选列 |
| [规则引擎](references/rules.md) | 建议名单怎么算、规则怎么配置、优先级怎么定 |
| [产物说明](references/output.md) | 结果放哪、Excel/HTML 长什么样 |
| [字段对照表](references/field_mapping.md) | 用户说中文、系统认英文时的对照 |
| [故障排查](references/troubleshooting.md) | 任何命令报错，先看这里 |
| [接口契约](references/api_contract.md) | 需要直接调后端接口时 |

## 四、目录结构

```
培小e\
├── SKILL.md            ← 本文件，路由与说明书
├── references\         ← 分功能参考文档（按需打开）
├── scripts\            ← 全部可执行代码，模型只调用不修改
├── templates\          ← 4 个导入模板与建表 SQL
├── samples\            ← 建议名单与看板的样例产物
├── 输入\               ← 待导入的 Excel（可选）
└── 输出\               ← 所有产物只落这里
```

## 五、给使用者的一句话

**照着场景路由表执行命令即可**；命令能跑通就不用读任何参考文件，
跑不通就打开 [故障排查](references/troubleshooting.md)，里面按现象列了原因与处理办法。
