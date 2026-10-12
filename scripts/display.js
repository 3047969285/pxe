// =====================================================
// display.js —— 命令行中文展示层
// 把接口返回的英文字段、原始 JSON，渲染成中文表格
// 所有命令的输出统一走这里，保证界面一致、人看得懂
// =====================================================

// 英文字段 → 中文列名
const FIELD_LABELS = {
  // 人员
  leaderId: '人员标识', seqNo: '序号', regionName: '地区', unitName: '单位',
  empName: '姓名', empId: '员工编号', idCard: '身份证号', gender: '性别', age: '年龄',
  assistDate: '协理时间', hireDate: '入职时间', bRole: 'B角', cadreLevel: '干部级别',
  staffGrade: '职员职级', isPartySec: '是否党支部书记', trainedRecords: '培训记录',
  totalHours: '累计学时', isProdHead: '是否生产分管负责人', remark: '备注',
  // 计划
  planId: '计划编号', batchId: '批次标识', planYear: '计划年度', className: '班次名称',
  sessionNo: '期次', trainPeriod: '参培时间', startDate: '开始日期', endDate: '结束日期',
  trainPlace: '培训地点', planCount: '计划人数', targetGroup: '参培对象',
  ruleDesc: '调训规则', ruleKey: '规则标识',
  // 名额
  quotaId: '名额标识', quotaCount: '名额数',
  // 记录
  recordId: '记录编号', classType: '班次类别', hours: '学时', unitAtTime: '参培时所在单位',
  dataSource: '数据来源',
  // 规则
  ruleId: '规则编号', ruleType: '规则类型', ruleCode: '规则编码', ruleName: '规则名称',
  ruleContent: '规则内容', priority: '优先级', enabled: '是否启用',
  delFlag: '删除标志', createTime: '创建时间', updateTime: '更新时间',
};

// 表名 → 中文名
const TABLE_LABELS = {
  pxe_leader_info: '领导人员信息',
  pxe_training_plan: '培训计划',
  pxe_quota_alloc: '名额分配',
  pxe_train_record: '培训记录',
  pxe_training_rule: '通用规则',
};

function labelOf(field) {
  return FIELD_LABELS[field] || field;
}

function labelOfTable(table) {
  if (!table) return '未知表';
  const key = String(table).trim();
  if (TABLE_LABELS[key]) return TABLE_LABELS[key];
  const short = { leader: '领导人员信息', plan: '培训计划', quota: '名额分配', record: '培训记录', rule: '通用规则' };
  return short[key] || key;
}

// 按显示宽度截断（中文占 2 格）
function width(text) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[一-龥＀-￯]/.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(text, target) {
  const gap = target - width(text);
  return gap > 0 ? String(text) + ' '.repeat(gap) : String(text);
}

function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ');
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = /[一-龥＀-￯]/.test(ch) ? 2 : 1;
    if (w + cw > max - 2) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// 打印标题分隔（中文，不用生僻符号）
function title(text) {
  console.log('');
  console.log('【' + text + '】');
}

// 打印一行提示
function info(text) {
  console.log('  ' + text);
}

function blank() {
  console.log('');
}

// 把一组对象渲染成中文表格
//   maxWidth: 单列最大显示宽度，超出截断
function table(rows, columns, options = {}) {
  if (!rows || !rows.length) {
    console.log('  没有查到数据');
    return;
  }
  const cols = columns && columns.length ? columns : Object.keys(rows[0]).filter(k => !['account', 'credential'].includes(k));
  const maxWidth = options.maxWidth || 22;

  // 计算列宽
  const widths = cols.map(key => {
    let w = width(labelOf(key));
    rows.forEach(row => {
      const cell = clip(row[key], maxWidth);
      w = Math.max(w, width(cell));
    });
    return Math.min(w, maxWidth);
  });

  const line = (cells) => '  ' + cells.map((c, i) => pad(c, widths[i])).join('  ');
  const sep = '  ' + widths.map(w => '─'.repeat(w)).join('──');

  console.log('');
  console.log(line(cols.map(labelOf)));
  console.log(sep);
  rows.forEach(row => console.log(line(cols.map(key => clip(row[key], maxWidth)))));
  console.log('');
}

// 打印成功提示
function ok(text) {
  console.log('  ✓ ' + text);
}

// 打印警告提示
function warn(text) {
  console.log('  ! ' + text);
}

// 打印失败提示
function fail(text) {
  console.log('  × ' + text);
}

module.exports = { labelOf, labelOfTable, table, title, info, ok, warn, fail, blank, clip, width };
