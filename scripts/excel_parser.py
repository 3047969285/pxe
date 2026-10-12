#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
excel_parser.py —— 培小e Excel 解析/写出桥接脚本

把 Excel 中文表头映射为后端 JSON 字段（驼峰命名，与后端实体一致），
统一输出 JSON 到 stdout，供 Node.js 主流程调用。

用法：
  python excel_parser.py <文件路径> <表名>                 解析数据行
  python excel_parser.py <文件路径> --auto                 自动识别表类型后解析
  python excel_parser.py <文件路径> <表名> --headers       只输出表头映射
  python excel_parser.py <文件路径> --info                 输出文件概要
  python excel_parser.py --export <数据json> <输出xlsx> <表名>   导出数据
  python excel_parser.py --template <输出xlsx> <表名>            生成模板

表名可用简写：leader / plan / quota / record / rule

输出（stdout）：
  {"ok":true, "table":"pxe_xxx", "rows":[...], "totalRows":N, ...}
  或 {"ok":false, "error":"..."}
"""

import sys
import json
import os
import re
import hashlib
from datetime import date, datetime
from openpyxl import load_workbook, Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# =========================================
# 表名简写 → 数据库表名
# =========================================
TABLE_ALIASES = {
    "leader": "pxe_leader_info",
    "plan": "pxe_training_plan",
    "quota": "pxe_quota_alloc",
    "record": "pxe_train_record",
    "rule": "pxe_training_rule",
}

# =========================================
# 中文表头 → 后端字段名（驼峰，与实体属性一致）
# 识别策略：先精确匹配，再模糊包含
# =========================================
FIELD_MAPS = {
    "pxe_leader_info": {
        "序号": "seqNo",
        "地区": "regionName",
        "所属地区": "regionName",
        "单位": "unitName",
        "单位名称": "unitName",
        "姓名": "empName",
        "人员姓名": "empName",
        "员工ID": "empId",
        "员工编号": "empId",
        "员工号": "empId",
        "编号": "empId",
        "人员编号": "empId",
        "身份证号": "idCard",
        "身份证号码": "idCard",
        "身份证": "idCard",
        "性别": "gender",
        "年龄": "age",
        "协理时间": "assistDate",
        "辅助日期": "assistDate",
        "入职时间": "hireDate",
        "入职日期": "hireDate",
        "B角": "bRole",
        "b角": "bRole",
        "角色": "bRole",
        "干部级别": "cadreLevel",
        "干部层级": "cadreLevel",
        "职员职级": "staffGrade",
        "职级": "staffGrade",
        "是否为党支部书记": "isPartySec",
        "是否党支部书记": "isPartySec",
        "是否党委": "isPartySec",
        "培训记录": "trainedRecords",
        "已参加培训班": "trainedRecords",
        "累计培训学时": "totalHours",
        "总学时": "totalHours",
        "培训学时": "totalHours",
        "是否为生产分管负责人": "isProdHead",
        "生产骨干": "isProdHead",
        "备注": "remark",
    },
    "pxe_training_plan": {
        "批次": "batchId",
        "批次标识": "batchId",
        "计划批次": "batchId",
        "计划年度": "planYear",
        "年份": "planYear",
        "年度": "planYear",
        "序号": "seqNo",
        "班次名称": "className",
        "培训班名称": "className",
        "培训班": "className",
        "班次": "className",
        "期次": "sessionNo",
        "期数": "sessionNo",
        "参培时间": "trainPeriod",
        "培训时间": "trainPeriod",
        "培训周期": "trainPeriod",
        "开始日期": "startDate",
        "结束日期": "endDate",
        "培训地点": "trainPlace",
        "地点": "trainPlace",
        "计划人数": "planCount",
        "人数": "planCount",
        "参培对象": "targetGroup",
        "培训对象": "targetGroup",
        "调训规则": "ruleDesc",
        "规则说明": "ruleDesc",
        "规则标识": "ruleKey",
        "规则键": "ruleKey",
        "备注": "remark",
    },
    "pxe_quota_alloc": {
        "计划年度": "planYear",
        "年度": "planYear",
        "年份": "planYear",
        "班次名称": "className",
        "培训班名称": "className",
        "班次": "className",
        "期次": "sessionNo",
        "期数": "sessionNo",
        "计划ID": "planId",
        "培训计划ID": "planId",
        "计划编号": "planId",
        "单位": "unitName",
        "单位名称": "unitName",
        "单位简称": "unitName",
        "名额": "quotaCount",
        "名额数": "quotaCount",
        "名额数量": "quotaCount",
        "备注": "remark",
    },
    "pxe_train_record": {
        "计划ID": "planId",
        "培训计划ID": "planId",
        "员工ID": "empId",
        "员工编号": "empId",
        "员工号": "empId",
        "人员编号": "empId",
        "姓名": "empName",
        "人员姓名": "empName",
        "培训年度": "planYear",
        "计划年度": "planYear",
        "年度": "planYear",
        "年份": "planYear",
        "班次名称": "className",
        "培训班名称": "className",
        "培训班": "className",
        "班次": "className",
        "班次类别": "classType",
        "培训类别": "classType",
        "类别": "classType",
        "期次": "sessionNo",
        "开始日期": "startDate",
        "结束日期": "endDate",
        "参培时间": "trainPeriod",
        "学时": "hours",
        "培训学时": "hours",
        "参培时所在单位": "unitAtTime",
        "参训单位": "unitAtTime",
        "参训时单位": "unitAtTime",
        "单位": "unitAtTime",
        "数据来源": "dataSource",
        "来源": "dataSource",
        "匹配说明": "remark",
        "备注": "remark",
    },
    "pxe_training_rule": {
        "规则类型": "ruleType",
        "类型": "ruleType",
        "规则编码": "ruleCode",
        "规则编号": "ruleCode",
        "规则名称": "ruleName",
        "规则内容": "ruleContent",
        "优先级": "priority",
        "是否启用": "enabled",
        "启用": "enabled",
        "备注": "remark",
    },
}

# 后端可写字段白名单（驼峰）
WHITELIST_FIELDS = {
    "pxe_leader_info": [
        "seqNo", "regionName", "unitName", "empName", "empId", "idCard", "gender", "age",
        "assistDate", "hireDate", "bRole", "cadreLevel", "staffGrade", "isPartySec", "trainedRecords",
        "totalHours", "isProdHead", "remark",
    ],
    "pxe_training_plan": [
        "batchId", "planYear", "seqNo", "className", "sessionNo", "trainPeriod", "startDate",
        "endDate", "trainPlace", "planCount", "targetGroup", "ruleDesc", "ruleKey", "remark",
    ],
    "pxe_quota_alloc": ["planYear", "className", "sessionNo", "planId", "unitName", "quotaCount", "remark"],
    "pxe_train_record": [
        "planId", "empId", "empName", "planYear", "className", "classType", "sessionNo",
        "trainPeriod", "startDate", "endDate", "hours", "unitAtTime", "dataSource", "remark",
    ],
    "pxe_training_rule": ["ruleType", "ruleCode", "ruleName", "ruleContent", "priority", "enabled", "remark"],
}

# 必填字段（驼峰）
REQUIRED_FIELDS = {
    "pxe_leader_info": ("regionName", "unitName", "empName", "empId"),
    "pxe_training_plan": ("planYear", "className", "sessionNo"),
    "pxe_quota_alloc": ("planYear", "className", "sessionNo", "unitName", "quotaCount"),
    "pxe_train_record": ("empId", "empName", "planYear", "className", "sessionNo"),
    "pxe_training_rule": ("ruleType", "ruleCode", "ruleName"),
}

# 需要转数字的字段
NUMERIC_FIELDS = {"seqNo", "planCount", "quotaCount", "hours", "age", "totalHours", "priority"}
# 文本型但可能被 Excel 识别成数字的字段（保留原始字符串，含前导零）
TEXT_KEEP_FIELDS = {"empId", "idCard"}

TABLE_LABELS = {
    "pxe_leader_info": "领导人员信息",
    "pxe_training_plan": "培训计划",
    "pxe_quota_alloc": "名额分配",
    "pxe_train_record": "培训记录",
    "pxe_training_rule": "通用规则",
}

# 整册模板：一个工作簿含多个工作表，与原始数据文件结构一致
BOOK_TEMPLATES = {
    "pxe_training_plan": ["pxe_training_plan", "pxe_quota_alloc"],
}

# 模板中不展示的字段（数据模型保留，只是模板里不列，避免干扰填报）
TEMPLATE_HIDDEN_FIELDS = {"remark"}

# =========================================
# 模板表头固定用词（保证清晰，避免取到映射表里的简称）
# =========================================
PREFERRED_HEADERS = {
    "pxe_leader_info": {
        "seqNo": "序号", "regionName": "地区", "unitName": "单位", "empName": "人员姓名",
        "empId": "员工ID", "idCard": "身份证号", "gender": "性别", "age": "年龄",
        "assistDate": "协理时间", "hireDate": "入职时间", "bRole": "B角",
        "cadreLevel": "干部级别", "staffGrade": "职员职级", "isPartySec": "是否为党支部书记",
        "trainedRecords": "培训记录", "totalHours": "累计培训学时",
        "isProdHead": "是否为生产分管负责人",
    },
    "pxe_training_plan": {
        "batchId": "批次标识", "planYear": "计划年度", "seqNo": "序号", "className": "班次名称",
        "sessionNo": "期次", "trainPeriod": "参培时间", "startDate": "开始日期", "endDate": "结束日期",
        "trainPlace": "培训地点", "planCount": "计划人数", "targetGroup": "参培对象",
        "ruleDesc": "调训规则", "ruleKey": "规则标识",
    },
    "pxe_quota_alloc": {
        "planYear": "计划年度", "className": "班次名称", "sessionNo": "期次", "planId": "计划ID",
        "unitName": "单位", "quotaCount": "名额",
    },
    "pxe_train_record": {
        "planId": "计划ID", "empId": "员工ID", "empName": "人员姓名", "planYear": "培训年度",
        "className": "班次名称", "classType": "班次类别", "sessionNo": "期次", "trainPeriod": "参培时间",
        "startDate": "开始日期", "endDate": "结束日期", "hours": "学时", "unitAtTime": "参培时所在单位",
        "dataSource": "数据来源",
    },
    "pxe_training_rule": {
        "ruleType": "规则类型", "ruleCode": "规则编码", "ruleName": "规则名称",
        "ruleContent": "规则内容", "priority": "优先级", "enabled": "是否启用",
    },
}

# =========================================
# 字段说明（模板批注与「字段说明」工作表使用）
# =========================================
FIELD_NOTES = {
    "pxe_leader_info": {
        "seqNo": "本表内的行号，仅用于排序展示，可留空",
        "regionName": "所属地区，如济南。仅填单位不填地区时，系统自动由单位派生",
        "unitName": "所属单位简称，如济南公司",
        "empName": "人员姓名，需与培训记录中的姓名一致",
        "empId": "员工编号，唯一，作为人员身份标识；文本格式，请保留前导零",
        "idCard": "身份证号，18 位（或 15 位）。普通用户查询时自动脱敏，后四位用作个人登录凭据",
        "gender": "性别，填 男 或 女",
        "age": "年龄，填整数",
        "assistDate": "协理时间（退出实职领导岗位、转任协理的时间）。格式 yyyy-MM-dd，如 2020-05-01",
        "hireDate": "入职时间，可只填到年月，如 2018年7月；系统按当月 1 日存入",
        "bRole": "互为 AB 角的人员姓名。匹配时两人培训时间重叠会冲突，只填其中一人的对应方即可",
        "cadreLevel": "干部级别，如 正科级 / 副科级",
        "staffGrade": "职员职级，如 四级职员",
        "isPartySec": "是否为党支部书记，填 是 或 否",
        "trainedRecords": "该人员已参加过的培训班次，多个用顿号分隔。注意：此列由培训记录自动汇总，不建议手工填写",
        "totalHours": "累计培训学时。注意：此列由培训记录自动汇总，不建议手工填写",
        "isProdHead": "是否为生产分管负责人，填 是 或 否。为是时培训期次需避开春检与秋检",
        "remark": "备注，可留空",
    },
    "pxe_training_plan": {
        "batchId": "批次标识。同一批导入的计划共用，留空时系统自动生成",
        "planYear": "计划年度，4 位年份，如 2027",
        "seqNo": "本表内的行号，仅用于排序展示",
        "className": "班次名称，如 四级领导人员进修班",
        "sessionNo": "期次，填 第一期 / 第二期，或直接填 1 / 2",
        "trainPeriod": "参培时间原文，如 2027年3月16日至3月30日。填写后系统自动拆出开始日期、结束日期与年度",
        "startDate": "开始日期，格式 yyyy-MM-dd。填了参培时间时可留空",
        "endDate": "结束日期，格式 yyyy-MM-dd。填了参培时间时可留空",
        "trainPlace": "培训地点",
        "planCount": "计划人数，填整数",
        "targetGroup": "参培对象，如 2026年新提任四级正职领导人员",
        "ruleDesc": "本班次的调训规则说明，如 近3年未参培优先",
        "ruleKey": "规则标识，用于关联通用规则，如 jxb_normal",
        "remark": "备注，可留空",
    },
    "pxe_quota_alloc": {
        "planYear": "计划年度，4 位年份，如 2027。与班次名称、期次一起定位到具体培训计划，无需填写计划编号",
        "className": "班次名称，需与培训计划工作表里的名称一致，如 四级领导人员进修班",
        "sessionNo": "期次，填 第一期 / 第二期，或直接填 1 / 2",
        "planId": "培训计划编号。留空即可，系统会按上面的年度加班次加期次自动匹配；只有需要精确指定某条计划时才手工填写",
        "unitName": "单位简称，如 济南公司",
        "quotaCount": "该单位在该班次期次的名额数，填整数",
        "remark": "备注，可留空",
    },
    "pxe_train_record": {
        "planId": "培训计划编号，留空即可；系统按下方年度加班次加期次自动匹配计划",
        "empId": "员工编号，需与人员信息表中的编号一致",
        "empName": "姓名，需与人员信息表中该编号对应的姓名一致",
        "planYear": "培训年度，如 2027",
        "className": "班次名称，如 四级领导人员进修班",
        "classType": "班次类别，如 进修班 / 县班子班 / 新提任班，可留空",
        "sessionNo": "期次，填 第一期 或 1",
        "trainPeriod": "参培时间原文，如 2027年3月16日至3月30日。填写后自动拆出起止日期",
        "startDate": "开始日期 yyyy-MM-dd，填了参培时间可留空",
        "endDate": "结束日期 yyyy-MM-dd，填了参培时间可留空",
        "hours": "本次培训学时，填整数。注意：人员信息表里的累计学时由本列自动汇总",
        "unitAtTime": "参培时所在单位，如 济南公司；跨单位交流时用于核对",
        "dataSource": "数据来源，如 自办班 / 送培 / 国网学堂 / 系统匹配确认",
        "remark": "备注，可留空",
    },
    "pxe_training_rule": {
        "ruleType": "规则类型，填 硬规则 或 软规则。硬规则用于剔除不符合条件的人，软规则用于优先排序",
        "ruleCode": "规则编码，可留空；留空时系统按规则名称自动生成，同名规则会复用已有编码",
        "ruleName": "规则名称，如 硬规则一：AB角不得同出",
        "ruleContent": "规则内容，写明判定条件。系统会按内容里的关键词识别到对应执行逻辑",
        "priority": "优先级，数字越小越先执行",
        "enabled": "是否启用，填 1 启用 或 0 停用",
        "remark": "备注，可留空",
    },
}

# =========================================
# 模板样例数据：每表 4 行，覆盖各种取值情况（浅色显示，导入前删除）
# =========================================
SAMPLE_ROWS = {
    "pxe_leader_info": [
        # 情况一：正科级、党支部书记、生产分管负责人、有参培记录与累计学时
        {"seqNo": 1, "regionName": "济南", "unitName": "济南公司", "empName": "张三",
         "empId": "00010001", "idCard": "370102198001011234", "gender": "男", "age": 45,
         "assistDate": "2020-05-01", "hireDate": "2018-07-01", "bRole": "李四",
         "cadreLevel": "正科级", "staffGrade": "", "isPartySec": "是",
         "trainedRecords": "四级领导人员进修班第一期", "totalHours": 120, "isProdHead": "是",
         "remark": "生产分管，培训需避开春秋检"},
        # 情况二：副科级、非书记、从未参培（培训记录与学时留空）、无B角
        {"seqNo": 2, "regionName": "青岛", "unitName": "青岛公司", "empName": "王五",
         "empId": "00010002", "idCard": "370102198503151234", "gender": "女", "age": 39,
         "assistDate": "", "hireDate": "2015年3月", "bRole": "",
         "cadreLevel": "副科级", "staffGrade": "", "isPartySec": "否",
         "trainedRecords": "", "totalHours": "", "isProdHead": "否", "remark": ""},
        # 情况三：四级职员（干部级别留空、填职员职级）、党支部书记、带多个历史班次
        {"seqNo": 3, "regionName": "烟台", "unitName": "烟台公司", "empName": "赵六",
         "empId": "00010003", "idCard": "370102199007201234", "gender": "男", "age": 35,
         "assistDate": "", "hireDate": "2012-09-01", "bRole": "孙七",
         "cadreLevel": "", "staffGrade": "四级职员", "isPartySec": "是",
         "trainedRecords": "县公司领导班子进修班第一期、四级领导人员进修班第五期",
         "totalHours": 240, "isProdHead": "否", "remark": ""},
        # 情况四：满 55 岁（不安排进修班）、正科级、无任何历史记录
        {"seqNo": 4, "regionName": "潍坊", "unitName": "潍坊公司", "empName": "周八",
         "empId": "00010004", "idCard": "370102197003101234", "gender": "男", "age": 56,
         "assistDate": "2025-12-01", "hireDate": "1995年7月", "bRole": "",
         "cadreLevel": "正科级", "staffGrade": "", "isPartySec": "否",
         "trainedRecords": "", "totalHours": 60, "isProdHead": "否",
         "remark": "距退休不足5年，不安排进修班"},
    ],
    "pxe_training_plan": [
        # 情况一：填参培时间原文，起止日期与年度由系统自动拆解
        {"batchId": "", "planYear": "2027", "seqNo": 1, "className": "四级领导人员进修班",
         "sessionNo": "第一期", "trainPeriod": "2027年3月16日至3月30日", "startDate": "", "endDate": "",
         "trainPlace": "临沂校区", "planCount": 70, "targetGroup": "四级领导人员（正科级）",
         "ruleDesc": "近3年未参培优先", "ruleKey": "jxb_normal", "remark": ""},
        # 情况二：不填参培时间，直接给开始/结束日期
        {"batchId": "", "planYear": "2027", "seqNo": 2, "className": "新提任四级正职领导人员任职进修班",
         "sessionNo": "1", "trainPeriod": "", "startDate": "2027-04-10", "endDate": "2027-04-24",
         "trainPlace": "井冈山干部学院", "planCount": 50, "targetGroup": "2026年新提任四级正职领导人员",
         "ruleDesc": "2026年新提任正职全覆盖", "ruleKey": "xinren_zheng", "remark": ""},
        # 情况三：批次标识有值（同一批多条计划共用）
        {"batchId": "PC202701011200001001", "planYear": "2027", "seqNo": 3, "className": "县公司领导班子进修班",
         "sessionNo": "第二期", "trainPeriod": "2027年5月8日至5月22日", "startDate": "", "endDate": "",
         "trainPlace": "临沂校区", "planCount": 70, "targetGroup": "县公司领导班子成员",
         "ruleDesc": "学时缺口优先", "ruleKey": "xgsb", "remark": ""},
        # 情况四：党支部书记专场（第五期）
        {"batchId": "", "planYear": "2027", "seqNo": 4, "className": "四级领导人员进修班",
         "sessionNo": "第五期", "trainPeriod": "2027年11月10日至11月24日", "startDate": "", "endDate": "",
         "trainPlace": "临沂校区", "planCount": 80, "targetGroup": "党支部书记",
         "ruleDesc": "党支部书记专场", "ruleKey": "jxb_secretary", "remark": "书记专场"},
    ],
    "pxe_quota_alloc": [
        # 情况一：只填年度+班次+期次定位计划，计划ID留空
        {"planYear": "2027", "className": "四级领导人员进修班", "sessionNo": "第一期",
         "planId": "", "unitName": "济南公司", "quotaCount": 5, "remark": ""},
        # 情况二：同一班次期次、不同单位
        {"planYear": "2027", "className": "四级领导人员进修班", "sessionNo": "第一期",
         "planId": "", "unitName": "青岛公司", "quotaCount": 6, "remark": ""},
        # 情况三：期次直接填数字
        {"planYear": "2027", "className": "县公司领导班子进修班", "sessionNo": "2",
         "planId": "", "unitName": "烟台公司", "quotaCount": 4, "remark": ""},
        # 情况四：名额为 0（该期次不分配名额）
        {"planYear": "2027", "className": "新提任四级副职领导人员任职进修班", "sessionNo": "第一期",
         "planId": "", "unitName": "莱芜公司", "quotaCount": 0, "remark": "本期不分配"},
    ],
    "pxe_train_record": [
        # 情况一：填参培时间原文，起止日期自动拆解
        {"planId": "", "empId": "00010001", "empName": "张三", "planYear": "2027",
         "className": "四级领导人员进修班", "classType": "进修班", "sessionNo": "第一期",
         "trainPeriod": "2027年3月16日至3月30日", "startDate": "", "endDate": "", "hours": 16,
         "unitAtTime": "济南公司", "dataSource": "国网学堂", "remark": ""},
        # 情况二：直接给起止日期，不填参培时间
        {"planId": "", "empId": "00010002", "empName": "王五", "planYear": "2027",
         "className": "县公司领导班子进修班", "classType": "县班子班", "sessionNo": "第二期",
         "trainPeriod": "", "startDate": "2027-05-08", "endDate": "2027-05-22", "hours": 14,
         "unitAtTime": "青岛公司", "dataSource": "送培", "remark": ""},
        # 情况三：学时留空（源数据只有年度合计）
        {"planId": "", "empId": "00010003", "empName": "赵六", "planYear": "2027",
         "className": "四级领导人员进修班", "classType": "进修班", "sessionNo": "第五期",
         "trainPeriod": "2027年11月10日至11月24日", "startDate": "", "endDate": "", "hours": "",
         "unitAtTime": "烟台公司", "dataSource": "系统匹配确认", "remark": "学时待补"},
        # 情况四：班次类别留空，备注说明
        {"planId": "", "empId": "00010004", "empName": "周八", "planYear": "2027",
         "className": "新提任四级副职领导人员任职进修班", "classType": "", "sessionNo": "第一期",
         "trainPeriod": "2027年6月5日至6月19日", "startDate": "", "endDate": "", "hours": 12,
         "unitAtTime": "潍坊公司", "dataSource": "自办班", "remark": ""},
    ],
    "pxe_training_rule": [
        # 情况一：硬规则、启用、优先级1、自带编码
        {"ruleType": "硬规则", "ruleCode": "HARD_AB_ROLE", "ruleName": "硬规则一：AB角不得同出",
         "ruleContent": "互为AB角（含单向指定）的两名领导人员，外出培训时间存在重叠时不得同时参培",
         "priority": 1, "enabled": "1", "remark": ""},
        # 情况二：硬规则、启用、优先级2、自带编码
        {"ruleType": "硬规则", "ruleCode": "HARD_REPEAT_TRAIN", "ruleName": "硬规则二：重复参培剔除",
         "ruleContent": "同一领导人员2027年度原则上只安排参加1个脱产培训班次，2026年度已参加同类别班次的不再重复安排",
         "priority": 2, "enabled": "1", "remark": ""},
        # 情况三：软规则、启用、优先级4、编码留空（系统按名称自动生成并复用）
        {"ruleType": "软规则", "ruleCode": "", "ruleName": "优先规则一：近3年未参培优先",
         "ruleContent": "近3年未参加任何培训的人员优先安排", "priority": 4, "enabled": "1",
         "remark": "编码留空，系统自动生成"},
        # 情况四：软规则、停用（enabled=0）、优先级9、编码留空
        {"ruleType": "软规则", "ruleCode": "", "ruleName": "优先规则四：临时规则（暂不启用）",
         "ruleContent": "示例：某类人员优先，当前先停用，需要时改 enabled 为 1",
         "priority": 9, "enabled": "0", "remark": "停用状态示例"},
    ],
}

CHINESE_DIGITS = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
                  "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def normalize_table(name):
    """把简写或表名统一成数据库表名"""
    if not name:
        return None
    key = str(name).strip()
    return TABLE_ALIASES.get(key, key)


def normalize_value(field, value):
    """字段值类型规范化"""
    if value is None:
        return None
    if field in TEXT_KEEP_FIELDS:
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        text = str(value).strip()
        return text if text else None
    text = str(value).strip()
    if text == "" or text == "None":
        return None
    if field in NUMERIC_FIELDS:
        clean = "".join(c for c in text if c.isdigit() or c in ".-")
        if clean in ("", "-", "."):
            return text
        try:
            return float(clean) if "." in clean else int(clean)
        except (ValueError, TypeError):
            return text
    return text


def normalize_date(value, field):
    """把日期规范成 yyyy-MM-dd；无法识别时返回原文"""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    if not text:
        return None
    # Excel 日期序列号
    if re.fullmatch(r"\d{5}(\.\d+)?", text):
        try:
            serial = float(text)
            base = datetime(1899, 12, 30)
            from datetime import timedelta
            return (base + timedelta(days=serial)).date().isoformat()
        except (ValueError, OverflowError):
            return text
    match = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", text)
    if match:
        y, m, d = (int(g) for g in match.groups())
        try:
            return date(y, m, d).isoformat()
        except ValueError:
            return text
    # 只有年月，如“2018年7月”，按当月首日处理
    match_ym = re.search(r"^(\d{4})\D+(\d{1,2})\D*$", text)
    if match_ym:
        y, m = int(match_ym.group(1)), int(match_ym.group(2))
        try:
            return date(y, m, 1).isoformat()
        except ValueError:
            return text
    return text


def normalize_session(value):
    """把“第一期/第1期/1”统一成“第一期”风格的中文文本（与库中一致）"""
    text = str(value or "").strip()
    if not text:
        return None
    match = re.search(r"第?\s*([一二两三四五六七八九十\d]+)\s*期?", text)
    if not match:
        return text
    token = match.group(1)
    if token.isdigit():
        return f"第{int(token)}期"
    if token in CHINESE_DIGITS:
        return f"第{token}期"
    if "十" in token:
        if token.startswith("十") and len(token) == 2:
            num = 10 + CHINESE_DIGITS.get(token[1], 0)
            return f"第{num}期"
        if token.endswith("十") and len(token) == 2:
            num = CHINESE_DIGITS.get(token[0], 0) * 10
            return f"第{num}期"
        if len(token) == 3:
            num = CHINESE_DIGITS.get(token[0], 0) * 10 + CHINESE_DIGITS.get(token[2], 0)
            return f"第{num}期"
    return f"第{token}期"


def parse_training_period(value):
    """拆解“2027年3月16日至3月30日”这类日期区间"""
    if isinstance(value, datetime):
        return value.date().isoformat(), value.date().isoformat(), value.year
    if isinstance(value, date):
        return value.isoformat(), value.isoformat(), value.year
    text = str(value or "").strip()
    if not text:
        return None
    match = re.search(
        r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*(?:至|到|—|-|~)\D*(?:(\d{4})\D+)?(\d{1,2})\D+(\d{1,2})", text)
    if not match:
        single = re.search(r"(\d{4})\D+(\d{1,2})\D+(\d{1,2})", text)
        if single:
            y, m, d = (int(g) for g in single.groups())
            try:
                day = date(y, m, d)
                return day.isoformat(), day.isoformat(), y
            except ValueError:
                return None
        return None
    sy, sm, sd, ey, em, ed = match.groups()
    sy, sm, sd = int(sy), int(sm), int(sd)
    ey = int(ey) if ey else sy
    em, ed = int(em), int(ed)
    if not match.group(4) and (em, ed) < (sm, sd):
        ey += 1
    try:
        return date(sy, sm, sd).isoformat(), date(ey, em, ed).isoformat(), sy
    except ValueError:
        return None


def build_field_map(headers, table_name):
    """构建 中文列名 → 后端字段名 的映射"""
    mapping = FIELD_MAPS.get(table_name, {})
    result = {}
    unmatched = []
    for header in headers:
        text = str(header or "").strip()
        if not text:
            continue
        if text in mapping:
            result[text] = mapping[text]
            continue
        found = None
        for cn, en in mapping.items():
            if cn in text or text in cn:
                found = en
                break
        if found:
            result[text] = found
        else:
            unmatched.append(text)
    return result, unmatched


def detect_header_row(ws, table_name, scan_rows=12):
    """在前若干行里找字段命中数最高的行作为表头"""
    best = None
    # read_only 模式下 max_row 不可靠，按顺序试读直到读空
    for row_number in range(1, scan_rows + 1):
        values = next(ws.iter_rows(min_row=row_number, max_row=row_number, values_only=True), None)
        if values is None:
            break
        headers = [str(c or "").strip() for c in values]
        field_map, unmatched = build_field_map(headers, table_name)
        score = len(field_map)
        if best is None or score > best[0]:
            best = (score, row_number, headers, field_map, unmatched)
    if not best or best[0] == 0:
        return None
    return best[1], best[2], best[3], best[4]


def detect_table(filepath):
    """按工作表表头自动判断文件属于哪张表"""
    try:
        wb = load_workbook(filepath, data_only=True)
    except Exception as exc:
        return {"ok": False, "error": f"无法打开 Excel: {exc}"}
    best = None
    for ws in wb.worksheets:
        for table_name in FIELD_MAPS:
            detected = detect_header_row(ws, table_name)
            if not detected:
                continue
            score = len(detected[2])
            if best is None or score > best[0]:
                best = (score, table_name, ws.title, detected[0])
    wb.close()
    if not best or best[0] < 2:
        return {"ok": False, "error": "无法自动识别表类型，请显式指定表名（leader/plan/quota/record/rule）"}
    return {"ok": True, "table": best[1], "sheet": best[2], "headerRow": best[3], "score": best[0]}


def parse_excel(filepath, table_name, mode="data", sheet_name=None):
    """主解析函数"""
    table_name = normalize_table(table_name)
    if not os.path.exists(filepath):
        return {"ok": False, "error": f"文件不存在: {filepath}"}
    if table_name not in FIELD_MAPS:
        return {"ok": False, "error": f"未知表名: {table_name}，可用: {list(FIELD_MAPS.keys())}"}
    try:
        wb = load_workbook(filepath, data_only=True)
    except Exception as exc:
        return {"ok": False, "error": f"无法打开 Excel: {exc}"}

    if mode == "info":
        sheets = [{"name": item.title, "rows": item.max_row, "columns": item.max_column}
                  for item in wb.worksheets]
        wb.close()
        return {"ok": True, "mode": "info", "sheets": sheets}

    if sheet_name:
        if sheet_name not in wb.sheetnames:
            wb.close()
            return {"ok": False, "error": f"工作表不存在: {sheet_name}"}
        candidates = [wb[sheet_name]]
    else:
        candidates = wb.worksheets

    detected_sheets = []
    for candidate in candidates:
        detected = detect_header_row(candidate, table_name)
        if detected:
            detected_sheets.append((len(detected[2]), candidate, detected))
    if not detected_sheets:
        wb.close()
        return {"ok": False, "error": "前12行未识别到可映射表头"}
    _, ws, detected = max(detected_sheets, key=lambda item: item[0])
    header_row, raw_headers, field_map, unmatched = detected

    if mode == "headers":
        wb.close()
        return {"ok": True, "mode": "headers", "table": table_name, "sheet": ws.title,
                "headerRow": header_row, "rawHeaders": raw_headers, "fieldMap": field_map,
                "unmatched": unmatched}

    whitelist = WHITELIST_FIELDS.get(table_name, [])
    rows = []
    warnings = []
    row_index = header_row
    for row in ws.iter_rows(min_row=header_row + 1, values_only=True):
        row_index += 1
        if all(c is None or str(c).strip() == "" for c in row):
            continue
        obj = {}
        for i, value in enumerate(row):
            if i >= len(raw_headers):
                continue
            if value is None or (isinstance(value, str) and value.strip() == ""):
                continue
            header = raw_headers[i]
            field = field_map.get(header)
            if not field or field not in whitelist:
                continue
            if field in {"startDate", "endDate", "assistDate", "hireDate"}:
                obj[field] = normalize_date(value, field)
            elif field == "trainPeriod":
                period = parse_training_period(value)
                if period and table_name in {"pxe_training_plan", "pxe_train_record"}:
                    obj["startDate"], obj["endDate"], plan_year = period
                    obj.setdefault("planYear", str(plan_year))
                elif period:
                    obj["startDate"], obj["endDate"], _ = period
            elif field == "sessionNo":
                obj[field] = normalize_session(value)
            else:
                obj[field] = normalize_value(field, value)
        if table_name == "pxe_training_plan" and not obj.get("planYear") and obj.get("startDate"):
            obj["planYear"] = str(obj["startDate"])[:4]
        # 人员表无“地区”列时，由“单位”派生（如 济南公司 → 济南）
        if table_name == "pxe_leader_info" and not obj.get("regionName") and obj.get("unitName"):
            obj["regionName"] = re.sub(r"(公司|供电公司)$", "", str(obj["unitName"]))
        # 规则表缺少类型或编码时按规则名称派生，保证可重复导入
        if table_name == "pxe_training_rule" and obj.get("ruleName"):
            rule_name = str(obj["ruleName"])
            if not obj.get("ruleType"):
                if "优先" in rule_name or "软规则" in rule_name:
                    obj["ruleType"] = "软规则"
                else:
                    obj["ruleType"] = "硬规则"
            if not obj.get("ruleCode"):
                digest = hashlib.md5(rule_name.encode("utf-8")).hexdigest()[:8].upper()
                obj["ruleCode"] = "RULE_" + digest
        if not obj:
            continue
        missing = [f for f in REQUIRED_FIELDS[table_name] if obj.get(f) in (None, "")]
        if missing:
            warnings.append(f"第{row_index}行缺少必填字段 {missing}，已跳过")
            continue
        rows.append(obj)

    wb.close()
    if not rows:
        return {"ok": False, "error": "未解析到有效数据行；请检查工作表、表头行与字段映射"}

    return {"ok": True, "mode": "data", "table": table_name, "sheet": ws.title,
            "headerRow": header_row, "rows": rows, "totalRows": len(rows),
            "fieldMap": {v: k for k, v in field_map.items()}, "unmatched": unmatched,
            "warnings": warnings or None}


def parse_quota_wide(filepath, sheet_name=None):
    """解析名额分配宽表并拍平为行式（班次 + 期次 + 单位 + 名额）"""
    if not os.path.exists(filepath):
        return {"ok": False, "error": f"文件不存在: {filepath}"}
    try:
        wb = load_workbook(filepath, data_only=True)
    except Exception as exc:
        return {"ok": False, "error": f"无法打开 Excel: {exc}"}

    target = None
    if sheet_name and sheet_name in wb.sheetnames:
        target = wb[sheet_name]
    else:
        for ws in wb.worksheets:
            collected = []
            for row_number in range(1, 5):
                values = next(ws.iter_rows(min_row=row_number, max_row=row_number, values_only=True), ())
                collected.extend(str(v or "") for v in values)
            joined = "".join(collected)
            if "单位" in joined and "名额" in joined:
                target = ws
                break
    if target is None:
        wb.close()
        return {"ok": False, "error": "未找到名额分配宽表（需含“单位”和“名额”字样）"}

    class_row = None
    for row_number in range(1, 6):
        values = [str(v or "").strip() for v in
                  next(target.iter_rows(min_row=row_number, max_row=row_number, values_only=True), ())]
        if "单位" in values or "单位简称" in values:
            class_row = row_number
            break
    if class_row is None:
        wb.close()
        return {"ok": False, "error": "未找到含“单位”的表头行"}

    class_names = [str(v or "").strip() for v in
                   next(target.iter_rows(min_row=class_row, max_row=class_row, values_only=True), ())]
    session_names = [str(v or "").strip() for v in
                     next(target.iter_rows(min_row=class_row + 1, max_row=class_row + 1, values_only=True), ())]

    columns = []
    current_class = None
    for index in range(len(class_names)):
        if index < 2:
            columns.append(None)
            continue
        if class_names[index]:
            current_class = class_names[index]
        session = session_names[index] if index < len(session_names) else ""
        columns.append((current_class, normalize_session(session)) if current_class and session else None)

    rows = []
    for row in target.iter_rows(min_row=class_row + 2, values_only=True):
        unit = str(row[1] or "").strip() if len(row) > 1 else ""
        if not unit or unit == "合计":
            continue
        for index, key in enumerate(columns):
            if key is None or index >= len(row):
                continue
            count = row[index]
            if count is None or str(count).strip() == "":
                continue
            rows.append({"className": key[0], "sessionNo": key[1], "unitName": unit,
                         "quotaCount": int(count)})
    sheet_title = target.title
    wb.close()
    if not rows:
        return {"ok": False, "error": "名额宽表未解析到数据行"}
    return {"ok": True, "mode": "wide", "table": "pxe_quota_alloc", "sheet": sheet_title,
            "rows": rows, "totalRows": len(rows)}


def write_excel(filepath, table_name, rows):
    """把数据写成 Excel"""
    table_name = normalize_table(table_name)
    if table_name not in FIELD_MAPS:
        return {"ok": False, "error": f"未知表名: {table_name}"}
    whitelist = WHITELIST_FIELDS.get(table_name, [])
    mapping = FIELD_MAPS.get(table_name, {})
    en_to_cn = {}
    for cn, en in mapping.items():
        if en not in en_to_cn or len(cn) < len(en_to_cn[en]):
            en_to_cn[en] = cn
    headers = [en_to_cn.get(c, c) for c in whitelist]

    def cell(value):
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False)
        return "" if value is None else value

    try:
        wb = Workbook()
        ws = wb.active
        ws.title = TABLE_LABELS.get(table_name, table_name)
        ws.append(headers)
        for row in rows:
            ws.append([cell(row.get(c)) for c in whitelist])
        for idx in range(1, len(whitelist) + 1):
            ws.column_dimensions[ws.cell(row=1, column=idx).column_letter].width = 16
        ws.freeze_panes = "A2"
        wb.save(filepath)
    except Exception as exc:
        return {"ok": False, "error": f"写入 Excel 失败: {exc}"}
    return {"ok": True, "file": filepath, "totalRows": len(rows), "columns": whitelist}


def write_template(filepath, table_name):
    """生成录入模板（表头批注 + 一行样例）

    培训计划会生成含三个工作表的整册模板（培训计划 / 名额分配 / 通用规则），
    与原始数据文件的结构保持一致；其余表为单表模板。
    """
    table_name = normalize_table(table_name)
    if table_name not in FIELD_MAPS:
        return {"ok": False, "error": f"未知表名: {table_name}"}

    tables = BOOK_TEMPLATES.get(table_name, [table_name])
    try:
        wb = Workbook()
        wb.remove(wb.active)
        for name in tables:
            _fill_sheet(wb.create_sheet(TABLE_LABELS.get(name, name)), name)
        wb.save(filepath)
    except Exception as exc:
        return {"ok": False, "error": f"生成模板失败: {exc}"}
    return {"ok": True, "file": filepath, "sheets": tables,
            "columns": WHITELIST_FIELDS.get(table_name, [])}


def _fill_sheet(ws, table_name):
    """往一个工作表里写入表头、批注与样例行"""
    whitelist = [c for c in WHITELIST_FIELDS.get(table_name, []) if c not in TEMPLATE_HIDDEN_FIELDS]
    preferred = PREFERRED_HEADERS.get(table_name, {})
    required = set(REQUIRED_FIELDS.get(table_name, ()))
    notes = FIELD_NOTES.get(table_name, {})

    ws.append([preferred.get(c, c) for c in whitelist])
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="2D6A9F")
    for index, column in enumerate(whitelist, 1):
        cell = ws.cell(row=1, column=index)
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(index)].width = 18
        note = notes.get(column, "")
        if note:
            flag = "【必填】" if column in required else "【可选】"
            comment = Comment(f"{flag}{note}\n（此说明为批注，填写时可忽略）", "培小e")
            comment.width = 280
            comment.height = 100
            cell.comment = comment

    # 样例数据：浅色斜体，导入前整块删除即可
    samples = SAMPLE_ROWS.get(table_name) or []
    if isinstance(samples, dict):
        samples = [samples]
    for offset, sample in enumerate(samples):
        ws.append([sample.get(c, "") for c in whitelist])
        row_no = 2 + offset
        for index in range(1, len(whitelist) + 1):
            ws.cell(row=row_no, column=index).font = Font(color="9AA5B1", italic=True)
    ws.freeze_panes = "A2"


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "error": "用法见文件头注释"}, ensure_ascii=False))
        sys.exit(1)

    if args[0] in ("--export", "--template"):
        mode = args[0]
        if mode == "--export":
            if len(args) < 4:
                print(json.dumps({"ok": False, "error": "用法: --export <数据json> <输出xlsx> <表名>"}, ensure_ascii=False))
                sys.exit(1)
            with open(args[1], "r", encoding="utf-8") as handle:
                rows = json.load(handle)
            result = write_excel(args[2], args[3], rows)
        else:
            if len(args) < 3:
                print(json.dumps({"ok": False, "error": "用法: --template <输出xlsx> <表名>"}, ensure_ascii=False))
                sys.exit(1)
            result = write_template(args[1], args[2])
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(0 if result.get("ok") else 1)

    filepath = args[0]
    table_name = None
    mode = "data"
    sheet_name = None
    wide_mode = False
    index = 1
    while index < len(args):
        flag = args[index].strip()
        if flag == "--auto":
            table_name = "AUTO"
        elif flag == "--wide":
            wide_mode = True
            table_name = table_name or "quota"
        elif flag.lower() in ("--headers", "--header"):
            mode = "headers"
        elif flag.lower() == "--info":
            mode = "info"
        elif flag.lower() == "--sheet" and index + 1 < len(args):
            index += 1
            sheet_name = args[index]
        elif flag.lower().startswith("--sheet="):
            sheet_name = flag.split("=", 1)[1]
        elif table_name is None:
            table_name = flag
        index += 1

    if mode == "info":
        result = parse_excel(filepath, "pxe_leader_info", "info")
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(0 if result.get("ok") else 1)

    if wide_mode:
        result = parse_quota_wide(filepath, sheet_name)
        print(json.dumps(result, ensure_ascii=False, default=str))
        sys.exit(0 if result.get("ok") else 1)

    if table_name is None or table_name == "AUTO":
        detected = detect_table(filepath)
        if not detected.get("ok"):
            print(json.dumps(detected, ensure_ascii=False))
            sys.exit(1)
        table_name = detected["table"]
        sheet_name = sheet_name or detected.get("sheet")

    result = parse_excel(filepath, table_name, mode, sheet_name)
    print(json.dumps(result, ensure_ascii=False, default=str))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
