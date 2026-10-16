# 培小e 培训数据接口契约

> 本文档是技能包与后端之间的唯一契约，**以真实后端代码为准**。
> 后端：`com.xlsj.project.controller.HuangDaoTrainingController`
> 数据源：第四数据源 `zuzhibu_db`（生产 `20.40.199.18:13306`）

## 一、基本信息

- Base URL：`{baseUrl}/api/HuangDao/training`（本地 `http://127.0.0.1:7529/api/HuangDao/training`）
- 传输：HTTP **POST**，`Content-Type: application/json`
- 认证分两层，**缺一不可**：
  1. HTTP Header `Authorization` = 后端配置 `app.api-secret` 的值（**不加 `Bearer` 前缀**）
  2. 请求体 `data.account` 与 `data.credential`

## 二、四个接口

| 接口 | 路径 | 说明 |
|---|---|---|
| 查询 | `POST /query` | 分页查询，支持实体字段条件 + 动态筛选 + 排序 + 选列 |
| 新增或更新 | `POST /create` | **UPSERT**：按业务唯一键有则更新、无则新增 |
| 修改 | `POST /update` | 按主键定位，只更新提交的字段 |
| 软删除 | `POST /delete` | `del_flag` 置 `2`，不物理删除 |

## 三、请求体结构

```json
{
  "table": "pxe_training_plan",
  "data": {
    "account": "admin",
    "credential": "******",
    "planYear": "2027",
    "className": "四级领导人员进修班"
  },
  "rows": [
    { "account": "admin", "credential": "******", "planYear": "2027", "className": "…" }
  ],
  "filters": [
    { "field": "empName", "operator": "LIKE", "value": "张" }
  ],
  "columns": ["empId", "empName", "unitName"],
  "pageNum": 1,
  "pageSize": 20,
  "orderBy": "empId",
  "orderDirection": "ASC"
}
```

| 字段 | 适用接口 | 说明 |
|---|---|---|
| `table` | 全部 | 必填。表名或简写：`leader` / `plan` / `quota` / `record` / `rule` |
| `data` | 全部 | 单条业务数据，**必须含 `account` 与 `credential`**；查询时作为实体字段条件 |
| `rows` | create | 批量数据，最多 500 条，与 `data` 互斥 |
| `filters` | query | 动态筛选条件数组 |
| `columns` | query | 返回字段，缺省返回全部 |
| `pageNum` / `pageSize` | query | 页码默认 1，每页默认 20、最大 500 |
| `orderBy` / `orderDirection` | query | 排序字段（默认主键）与方向（`ASC`/`DESC`） |

## 四、五张表

| 表 | 表名 | 主键 | 业务唯一键 |
|---|---|---|---|
| 领导人员信息 | `pxe_leader_info` | `leaderId` | `empId` |
| 培训计划 | `pxe_training_plan` | `planId` | `planYear` + `className` + `sessionNo` |
| 名额分配 | `pxe_quota_alloc` | `quotaId` | `planId` + `unitName` |
| 培训记录 | `pxe_train_record` | `recordId` | `empId` + `planYear` + `className` + `sessionNo` |
| 通用规则 | `pxe_training_rule` | `ruleId` | `ruleCode` |

**主键由服务端生成 UUID**（时间有序），提交时留空即可。

各表业务字段：

- `pxe_leader_info`：`seqNo` `regionName` `unitName` `empName` `empId` `idCard` `gender` `age` `assistDate` `bRole` `cadreLevel` `staffGrade` `isPartySec` `trainedRecords` `totalHours` `isProdHead` `remark`
- `pxe_training_plan`：`batchId` `planYear` `seqNo` `className` `sessionNo` `trainPeriod` `startDate` `endDate` `trainPlace` `planCount` `targetGroup` `ruleDesc` `ruleKey` `remark`
- `pxe_quota_alloc`：`planId` `unitName` `quotaCount` `remark`
- `pxe_train_record`：`planId` `empId` `empName` `planYear` `className` `classType` `sessionNo` `startDate` `endDate` `hours` `unitAtTime` `dataSource` `remark`
- `pxe_training_rule`：`ruleType` `ruleCode` `ruleName` `ruleContent` `priority` `enabled` `remark`

日期字段（`assistDate` / `startDate` / `endDate`）使用 `yyyy-MM-dd` 格式。

## 五、筛选条件（filters）

```
{ "field": "字段名", "operator": "运算符", "value": 条件值 }
```

**支持 14 种运算符**：

| 类别 | 运算符 | value |
|---|---|---|
| 比较 | `EQ` `NE` `GT` `GE` `LT` `LE` | 单值 |
| 模糊 | `LIKE` `NOT_LIKE` | 单值（自动加 `%`） |
| 集合 | `IN` `NOT_IN` | 数组，≤5000 个 |
| 区间 | `BETWEEN` | 双元素数组 |
| 空值 | `IS_NULL` `IS_NOT_NULL` | 不需要 value |

- 多条件之间是 **AND**
- 单次最多 50 个条件
- 字段名支持驼峰（`empName`）或下划线（`emp_name`），后端按白名单校验，非法字段报 40000
- 普通用户不能用 `del_flag`、`id_card` 作为筛选字段

## 六、权限规则

| 表 | 管理员 | 普通用户（姓名 + 身份证后四位） |
|---|---|---|
| 领导人员信息 | 全部读写 | 只读本人、只能改本人资料（不能改身份/认证/归属字段） |
| 培训计划 | 全部读写 | 只读「本单位已分配名额的计划」 |
| 名额分配 | 全部读写 | 只读本单位 |
| 培训记录 | 全部读写 | 只查/增/改/删本人记录 |
| 通用规则 | 全部读写 | 只读 |

- `id_card` 对普通用户返回脱敏值（保留后四位）
- 删除一律软删（`del_flag='2'`）

## 七、响应与错误码

统一响应体：

```json
{ "code": 0, "data": {}, "message": "ok" }
```

查询成功时 `data` 为 `{ rows, total, pageNum, pageSize }`；写入成功时 `data` 为受影响行数。

| 错误码 | 含义 |
|---|---|
| `0` | 成功 |
| `40100` | 身份参数不完整或凭据格式不正确 |
| `40101` | 身份校验失败 / 越权 |
| `40000` | 参数错误（表名、字段名、运算符、必填缺失等） |
| `50000` | 系统异常 |

HTTP **401** 由全局拦截器返回，表示 `Authorization` 头缺失或不匹配（响应体为 `{"code":"300","message":"未授权！"}`）。

## 八、培训记录的业务联动

写入、修改或删除 `pxe_train_record` 时，后端会**自动回写**对应人员的汇总：

- `pxe_leader_info.total_hours` = 该人员全部有效培训记录的学时合计
- `pxe_leader_info.trained_records` = 该人员全部有效培训记录的班次名称（顿号分隔、去重）
- 软删除一条培训记录后，汇总会同步重算（实测：记录全部删除后 `total_hours` 归零、`trained_records` 置空）

因此**不要手工维护这两个字段**，它们由培训记录驱动。

## 九、实测补充（2026-10-16 对真实后端验证）

以下为接口测试实测到的、契约未写明的后端行为，技能侧已据此适配：

1. **培训记录引用计划的存在性校验**：写入 `pxe_train_record` 时，后端会按「计划年度 + 班次名称 + 期次」校验对应培训计划必须已存在，不存在则返回 `40000 培训计划不存在`。→ **导入顺序必须先是培训计划、再是培训记录**；技能侧已加预检，无计划的记录跳过并提示。

2. **软删行对一切查询不可见**：删除后既查不到该行，用 `del_flag='2'` 作筛选也查不到（查询层硬过滤 `del_flag='0'`）。`del_flag` 字段可读（结果中字段名为 `delFlag`，正常行为 `'0'`），但无法通过接口复核已被软删的数据，也不建议在筛选里用。

3. **UPSERT 的 `data` 返回值是 MySQL 影响行数**：新增返回 `1`、更新返回 `2`（`ON DUPLICATE KEY UPDATE` 语义，值未变化时可能为 `0`），**不是记录条数**。技能侧统计条数一律以提交的行数（`rows.length`）为准，不取 `data`。

4. **错误信息含内部细节**：数据库连接类异常时 `50000` 会把底层报错（如 `Communications link failure`）原样返回。属后端待优化项（建议脱敏），技能侧仅展示 `message`，不追加额外堆栈。
