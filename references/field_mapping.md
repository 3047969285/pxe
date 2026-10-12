# 字段对照表

用户写中文，系统认英文。命令行与 Excel 都会自动翻译，此表供排查用。

## 领导人员信息

| 中文 | 后端字段 | 说明 |
|---|---|---|
| 序号 | seqNo | 仅排序用 |
| 地区 | regionName | 只填单位时系统自动派生 |
| 单位 | unitName | 必填 |
| 人员姓名、姓名 | empName | 必填 |
| 员工ID、员工编号 | empId | 必填，唯一，保留前导零 |
| 身份证号 | idCard | 普通用户查询脱敏 |
| 性别 / 年龄 | gender / age | |
| 协理时间 | assistDate | yyyy-MM-dd |
| 入职时间 | hireDate | 可只填年月 |
| B角 | bRole | 互为 AB 角者培训时间重叠会冲突 |
| 干部级别 / 职员职级 | cadreLevel / staffGrade | |
| 是否为党支部书记 | isPartySec | 是 / 否 |
| 培训记录 | trainedRecords | **由培训记录自动汇总，勿手填** |
| 累计培训学时 | totalHours | **由培训记录自动汇总，勿手填** |
| 是否为生产分管负责人 | isProdHead | 为是时培训须避开春秋检 |

## 培训计划

| 中文 | 后端字段 |
|---|---|
| 批次标识 | batchId |
| 计划年度 | planYear |
| 序号 | seqNo |
| 班次名称 | className |
| 期次 | sessionNo |
| 参培时间 | trainPeriod |
| 开始日期 / 结束日期 | startDate / endDate |
| 培训地点 | trainPlace |
| 计划人数 | planCount |
| 参培对象 | targetGroup |
| 调训规则 | ruleDesc |
| 规则标识 | ruleKey |

## 名额分配

| 中文 | 后端字段 |
|---|---|
| 计划年度 / 班次名称 / 期次 | 用于匹配计划，不入库 |
| 计划编号 | planId（可留空，系统自动匹配） |
| 单位 | unitName |
| 名额 | quotaCount |

## 培训记录

| 中文 | 后端字段 |
|---|---|
| 员工ID / 人员姓名 | empId / empName |
| 培训年度 | planYear |
| 班次名称 / 班次类别 | className / classType |
| 期次 | sessionNo |
| 参培时间 / 开始日期 / 结束日期 | trainPeriod / startDate / endDate |
| 学时 | hours |
| 参培时所在单位 | unitAtTime |
| 数据来源 | dataSource |
| 计划编号 | planId（可留空，系统自动匹配） |

## 通用规则

| 中文 | 后端字段 |
|---|---|
| 规则类型 | ruleType（硬规则 / 软规则） |
| 规则名称 | ruleName |
| 规则内容 | ruleContent |
| 是否启用 | enabled（1 启用 / 0 停用） |
| 规则编码 | ruleCode（**模板不展示，系统按名称自动生成**） |
| 优先级 | priority（**模板不展示，按行序自动编排**） |

## 权限说明

| 身份 | 范围 |
|---|---|
| 管理员 `admin` | 五张表全量 |
| 普通用户（姓名 + 身份证后四位） | 本人资料与记录、本单位名额、本单位已分配名额的计划 |

普通用户不能：新增/删除人员、写计划表、写名额表、写规则表。
身份证号对普通用户自动脱敏（保留后四位）。
