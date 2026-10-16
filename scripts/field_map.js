// =====================================================
// field_map.js —— 中文表头/字段别名 → 后端字段名
// 供查询条件、排序、返回字段使用，允许用户与模型写中文
// =====================================================
const FIELD_ALIASES = {
  pxe_leader_info: {
    序号: 'seqNo', 地区: 'regionName', 所属地区: 'regionName', 单位: 'unitName', 单位名称: 'unitName',
    姓名: 'empName', 人员姓名: 'empName', 员工id: 'empId', 员工编号: 'empId', 员工号: 'empId', 编号: 'empId',
    人员id: 'leaderId', 人员编号: 'empId', 身份证号: 'idCard', 身份证: 'idCard', 性别: 'gender', 年龄: 'age',
    协理时间: 'assistDate', 入职时间: 'hireDate', 入职日期: 'hireDate',
    b角: 'bRole', 角色: 'bRole', 干部级别: 'cadreLevel', 干部层级: 'cadreLevel', 职员职级: 'staffGrade',
    是否为党支部书记: 'isPartySec', 培训记录: 'trainedRecords', 已参加培训班: 'trainedRecords',
    累计培训学时: 'totalHours', 总学时: 'totalHours', 是否为生产分管负责人: 'isProdHead', 备注: 'remark',
  },
  pxe_training_plan: {
    批次: 'batchId', 批次标识: 'batchId', 计划年度: 'planYear', 年度: 'planYear', 年份: 'planYear', 序号: 'seqNo',
    计划编号: 'planId', 培训计划编号: 'planId',
    班次名称: 'className', 培训班名称: 'className', 班次: 'className', 期次: 'sessionNo', 期数: 'sessionNo',
    参培时间: 'trainPeriod', 开始日期: 'startDate', 结束日期: 'endDate', 培训地点: 'trainPlace',
    计划人数: 'planCount', 参培对象: 'targetGroup', 调训规则: 'ruleDesc', 规则标识: 'ruleKey', 备注: 'remark',
  },
  pxe_quota_alloc: {
    计划id: 'planId', 培训计划id: 'planId', 计划编号: 'planId', 单位: 'unitName', 单位名称: 'unitName',
    单位简称: 'unitName', 名额: 'quotaCount', 名额数: 'quotaCount', 备注: 'remark',
  },
  pxe_train_record: {
    计划id: 'planId', 培训计划id: 'planId', 记录编号: 'recordId', 培训记录id: 'recordId',
    员工id: 'empId', 员工编号: 'empId', 人员编号: 'empId',
    姓名: 'empName', 人员姓名: 'empName', 培训年度: 'planYear', 计划年度: 'planYear', 年度: 'planYear',
    班次名称: 'className', 培训班名称: 'className', 班次: 'className', 班次类别: 'classType', 培训类别: 'classType',
    期次: 'sessionNo', 开始日期: 'startDate', 结束日期: 'endDate', 参培时间: 'trainPeriod', 学时: 'hours',
    参培时所在单位: 'unitAtTime', 参训单位: 'unitAtTime', 参训时单位: 'unitAtTime', 单位: 'unitAtTime',
    数据来源: 'dataSource', 匹配说明: 'remark', 备注: 'remark',
  },
  pxe_training_rule: {
    规则id: 'ruleId', 规则标识: 'ruleId', 规则主键: 'ruleId',
    规则类型: 'ruleType', 类型: 'ruleType', 规则编码: 'ruleCode', 规则编号: 'ruleCode', 规则名称: 'ruleName',
    规则内容: 'ruleContent', 优先级: 'priority', 是否启用: 'enabled', 启用: 'enabled', 备注: 'remark',
  },
};

// 字段名归一化：去空白、去下划线、转小写
function normalize(name) {
  return String(name == null ? '' : name).trim().replace(/[\s_-]/g, '').toLowerCase();
}

// 把中文或其它写法解析成后端字段名
function resolveField(table, name) {
  if (name == null) {
    return name;
  }
  const alias = FIELD_ALIASES[table];
  if (!alias) {
    return name;
  }
  const target = normalize(name);
  for (const key of Object.keys(alias)) {
    if (normalize(key) === target) {
      return alias[key];
    }
  }
  // 已是后端字段名（驼峰或下划线）时原样返回
  return name;
}

module.exports = { FIELD_ALIASES, resolveField, normalize };
