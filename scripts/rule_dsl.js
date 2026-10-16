// =====================================================
// rule_dsl.js —— 培小e 规则条款：收集、约束语言、校验、编译、审核状态
//
// 规则全部是用户自定义的中文文本，来自两处：
//   通用规则：pxe_training_rule 的规则内容（对本年度所有期次生效）
//   计划规则：pxe_training_plan 的参培对象、调训规则（只对该期生效）
// 每段文本是一个「条款」。流程：
//   模型翻译成受限 JSON（本文件定义）→ 规则 登记（严格校验，状态=待审核）
//   → 规则 审核表（Excel，用户逐条 确认/修改/驳回）→ 规则 确认（状态=已确认，锁定）
//   → 建议：只执行本批次全部「已确认」的条款
//
// 一致性保证：条款按原文算指纹，同一指纹只有一份已确认译文，任何模型运行都复用它；
// 原文改一个字指纹就变，自动回到待翻译；只有变化的条款需要重新审核。
// 语法说明见 references/rule_dsl.md
// =====================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CFG = require('./config');

const PRESET_FILE = path.join(__dirname, 'rule_presets.json');
const LIBRARY_DIR = path.join(CFG.outDir, '规则解析');
const LIBRARY_FILE = path.join(LIBRARY_DIR, '规则译文库.json');
const DRAFT_FILE = path.join(LIBRARY_DIR, '待翻译规则.json');

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const NEVER_TRAINED_YEARS = 99;

const SOURCE_GENERAL = '通用规则';
const SOURCE_TARGET = '计划·参培对象';
const SOURCE_PLAN_RULE = '计划·调训规则';
const ACTIONS = ['准入', '剔除', '加分'];

const STATUS = { TODO: '待翻译', REVIEW: '待审核', REJECTED: '驳回', CONFIRMED: '已确认' };

// ---------- 归一化 ----------
function normText(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function yesNo(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return ['是', '1', 'y', 'yes', 'true'].includes(text) ? '是' : '否';
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toDateText(value) {
  const text = value ? String(value).slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function toMs(dateText) {
  return dateText ? Date.parse(`${dateText}T00:00:00Z`) : null;
}

function sha(raw) {
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 12);
}

// 通用规则指纹：类型、名称、内容任一改动都会变化
function fingerprint(rule) {
  return sha(`${normText(rule.ruleType)}|${normText(rule.ruleName)}|${normText(rule.ruleContent)}`);
}

// 计划条款指纹：只看字段与原文，原文相同的期次共用一份译文
function planFingerprint(source, text) {
  return sha(`${source}|${normText(text)}`);
}

// 数据库规则类型 → 硬 / 软
function generalKind(ruleType) {
  const text = String(ruleType || '');
  if (text.includes('硬')) return '硬';
  if (text.includes('软') || text.includes('优先')) return '软';
  return null;
}

// ---------- 字段目录（引擎预先把原始行转成视图，见 ai_advisor.js） ----------
// 类型：文本 | 数值 | 是否 | 日期
const FIELDS = {
  '人员.单位': { type: '文本', get: c => c.person.unitName },
  '人员.地区': { type: '文本', get: c => c.person.regionName },
  '人员.姓名': { type: '文本', get: c => c.person.empName },
  '人员.员工编号': { type: '文本', get: c => c.person.empId },
  '人员.性别': { type: '文本', get: c => c.person.gender },
  '人员.年龄': { type: '数值', get: c => c.person.age },
  '人员.干部级别': { type: '文本', get: c => c.person.cadreLevel },
  '人员.职员职级': { type: '文本', get: c => c.person.staffGrade },
  '人员.是否党支部书记': { type: '是否', get: c => c.person.isPartySec },
  '人员.是否生产分管负责人': { type: '是否', get: c => c.person.isProdHead },
  '人员.累计学时': { type: '数值', get: c => c.person.totalHours },
  '人员.B角': { type: '文本', get: c => c.person.bRole },
  // 任职时间存于 hire_date（导入表头写「入职时间」「任职时间」均可）
  '人员.任职时间': { type: '日期', get: c => c.person.hireDate },
  '人员.任职年度': { type: '数值', get: c => c.person.hireYear },
  // 以本期开始日期为基准，保留一位小数
  '人员.任职年限': {
    type: '数值',
    get: c => (c.person.hireMs == null || c.plan.startMs == null ? null
      : Math.round(((c.plan.startMs - c.person.hireMs) / YEAR_MS) * 10) / 10),
  },
  '人员.协理时间': { type: '日期', get: c => c.person.assistDate },
  '人员.备注': { type: '文本', get: c => c.person.remark },
  '计划.班次名称': { type: '文本', get: c => c.plan.className },
  '计划.期次': { type: '文本', get: c => c.plan.sessionNo },
  '计划.班次类别': { type: '文本', get: c => c.plan.category },
  '计划.参培对象': { type: '文本', get: c => c.plan.targetGroup },
  '计划.培训地点': { type: '文本', get: c => c.plan.trainPlace },
  '计划.年度': { type: '数值', get: c => c.plan.year },
  '计划.开始日期': { type: '日期', get: c => c.plan.startDate },
  '计划.结束日期': { type: '日期', get: c => c.plan.endDate },
  '计划.培训天数': { type: '数值', get: c => c.plan.days },
};

// ---------- 指标目录（需要结合培训记录或本轮已选名单计算） ----------
const SCOPES = ['本年度', '上年度', '近N年', '指定年度'];
const CLASS_SCOPES = ['任意', '同班次', '同类别', '非本班次'];

function checkMonthDay(text) {
  if (!/^\d{2}-\d{2}$/.test(String(text))) return false;
  const [m, d] = String(text).split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

const METRICS = {
  // 符合条件的参培次数；本年度含本轮已建议的班次
  参培次数: {
    type: '数值',
    paramKeys: ['范围', '年数', '年度', '班次'],
    validate(params, at, errors) {
      if (!SCOPES.includes(params.范围)) {
        errors.push(`${at}.参数.范围 必须是 ${SCOPES.join(' / ')}`);
      }
      if (params.范围 === '近N年') {
        if (!Number.isInteger(params.年数) || params.年数 < 1 || params.年数 > 10) {
          errors.push(`${at}.参数.年数 范围为近N年时必填，取 1~10 的整数`);
        }
      } else if (params.年数 !== undefined) {
        errors.push(`${at}.参数.年数 只在范围为近N年时使用`);
      }
      if (params.范围 === '指定年度') {
        if (!Number.isInteger(params.年度) || params.年度 < 2000 || params.年度 > 2100) {
          errors.push(`${at}.参数.年度 范围为指定年度时必填，四位整数`);
        }
      } else if (params.年度 !== undefined) {
        errors.push(`${at}.参数.年度 只在范围为指定年度时使用`);
      }
      if (params.班次 !== undefined && !CLASS_SCOPES.includes(params.班次)) {
        errors.push(`${at}.参数.班次 必须是 ${CLASS_SCOPES.join(' / ')}`);
      }
    },
    dynamic: params => params.范围 === '本年度',
    compute(c, params) {
      const year = c.plan.year;
      let from;
      let to;
      if (params.范围 === '本年度') { from = year; to = year; }
      else if (params.范围 === '上年度') { from = year - 1; to = year - 1; }
      else if (params.范围 === '近N年') { from = year - params.年数; to = year - 1; }
      else { from = params.年度; to = params.年度; }
      const scope = params.班次 || '任意';
      const match = item => item.year >= from && item.year <= to && (
        scope === '任意'
        || (scope === '同班次' && item.className === c.plan.className)
        || (scope === '非本班次' && item.className !== c.plan.className)
        || (scope === '同类别' && c.plan.category !== '其他' && item.category === c.plan.category));
      let count = 0;
      for (const item of c.records) {
        if (match(item)) count++;
      }
      if (params.范围 === '本年度') {
        for (const item of c.state.selectedOf(c.person.empId)) {
          if (match(item)) count++;
        }
      }
      return count;
    },
  },
  // 距上次参培年数（以本期开始日期为基准，只看历史记录；从未参培记 99）
  距上次参培年数: {
    type: '数值',
    paramKeys: [],
    validate() {},
    dynamic: () => false,
    compute(c) {
      const base = c.plan.startMs;
      if (base == null) return null;
      let min = null;
      for (const item of c.records) {
        if (item.startMs != null && item.startMs < base) {
          const gap = (base - item.startMs) / YEAR_MS;
          if (min === null || gap < min) min = gap;
        }
      }
      return min === null ? NEVER_TRAINED_YEARS : Math.round(min * 10) / 10;
    },
  },
  // 本期培训起止是否与给定月日区间重叠（跨年班次逐年判断）
  培训期重叠: {
    type: '是否',
    paramKeys: ['区间'],
    validate(params, at, errors) {
      const ok = Array.isArray(params.区间) && params.区间.length > 0 && params.区间.every(pair =>
        Array.isArray(pair) && pair.length === 2 && checkMonthDay(pair[0]) && checkMonthDay(pair[1])
        && pair[0] <= pair[1]);
      if (!ok) {
        errors.push(`${at}.参数.区间 必须形如 [["03-01","06-30"],["09-01","11-30"]]，月日两位、起不晚于止`);
      }
    },
    dynamic: () => false,
    compute(c, params) {
      const { startDate, endDate } = c.plan;
      if (!startDate || !endDate) return '否';
      const firstYear = Number(startDate.slice(0, 4));
      const lastYear = Number(endDate.slice(0, 4));
      for (let y = firstYear; y <= lastYear; y++) {
        for (const [from, to] of params.区间) {
          if (startDate <= `${y}-${to}` && endDate >= `${y}-${from}`) return '是';
        }
      }
      return '否';
    },
  },
  // 与已入选的 AB 角对象冲突时返回对方姓名，否则返回空（双向：我指定对方或对方指定我）
  AB角冲突: {
    type: '文本',
    paramKeys: ['时间重叠'],
    validate(params, at, errors) {
      if (params.时间重叠 !== undefined && typeof params.时间重叠 !== 'boolean') {
        errors.push(`${at}.参数.时间重叠 只能是 true 或 false`);
      }
    },
    dynamic: () => true,
    compute(c, params) {
      const hit = c.state.findPartner(c.person, c.plan, params.时间重叠 !== false);
      return hit ? hit.empName : '';
    },
  },
};

// ---------- 运算符 ----------
const OPS_BY_TYPE = {
  文本: ['=', '!=', '包含', '不包含', '包含任一', '属于', '不属于', '为空', '不为空'],
  数值: ['=', '!=', '>', '>=', '<', '<=', '为空', '不为空'],
  是否: ['=', '!='],
  日期: ['=', '!=', '>', '>=', '<', '<=', '为空', '不为空'],
};
const ALL_OPS = [...new Set(Object.values(OPS_BY_TYPE).flat())];
const NO_VALUE_OPS = ['为空', '不为空'];
const LIST_OPS = ['包含任一', '属于', '不属于'];

function isEmpty(value) {
  return value == null || value === '';
}

function applyOp(op, actual, expected) {
  switch (op) {
    case '为空': return isEmpty(actual);
    case '不为空': return !isEmpty(actual);
    case '=': return !isEmpty(actual) && actual === expected;
    case '!=': return isEmpty(actual) || actual !== expected;
    case '>': return !isEmpty(actual) && actual > expected;
    case '>=': return !isEmpty(actual) && actual >= expected;
    case '<': return !isEmpty(actual) && actual < expected;
    case '<=': return !isEmpty(actual) && actual <= expected;
    case '包含': return !isEmpty(actual) && String(actual).includes(expected);
    case '不包含': return isEmpty(actual) || !String(actual).includes(expected);
    case '包含任一': return !isEmpty(actual) && expected.some(v => String(actual).includes(v));
    case '属于': return !isEmpty(actual) && expected.includes(String(actual));
    case '不属于': return isEmpty(actual) || !expected.includes(String(actual));
    default: return false;
  }
}

function typeOfLeaf(leaf) {
  if (leaf.字段 !== undefined) return FIELDS[leaf.字段] ? FIELDS[leaf.字段].type : null;
  if (leaf.指标 !== undefined) return METRICS[leaf.指标] ? METRICS[leaf.指标].type : null;
  return null;
}

// ---------- 校验 ----------
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function checkKeys(node, allowed, at, errors) {
  Object.keys(node).forEach(key => {
    if (!allowed.includes(key)) {
      errors.push(`${at} 出现不允许的键「${key}」，只能用 ${allowed.join(' / ')}`);
    }
  });
}

function checkValue(type, op, value, at, errors) {
  if (NO_VALUE_OPS.includes(op)) {
    if (value !== undefined) errors.push(`${at} 运算「${op}」不需要「值」`);
    return;
  }
  if (LIST_OPS.includes(op)) {
    if (!Array.isArray(value) || !value.length || !value.every(v => typeof v === 'string' && v.trim())) {
      errors.push(`${at}.值 运算「${op}」需要非空文本数组`);
    }
    return;
  }
  if (type === '数值' && !(typeof value === 'number' && Number.isFinite(value))) {
    errors.push(`${at}.值 必须是数字（不要加引号）`);
  } else if (type === '是否' && value !== '是' && value !== '否') {
    errors.push(`${at}.值 只能是 "是" 或 "否"`);
  } else if (type === '日期' && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))) {
    errors.push(`${at}.值 必须是 YYYY-MM-DD`);
  } else if (type === '文本' && !(typeof value === 'string' && value.trim())) {
    errors.push(`${at}.值 必须是非空文本`);
  }
}

function validateLeaf(leaf, at, errors) {
  if (!isPlainObject(leaf)) {
    errors.push(`${at} 必须是条件对象`);
    return;
  }
  let type;
  if ('字段' in leaf) {
    checkKeys(leaf, ['字段', '运算', '值'], at, errors);
    if (!FIELDS[leaf.字段]) {
      errors.push(`${at}.字段「${leaf.字段}」不在字段目录中`);
      return;
    }
    type = FIELDS[leaf.字段].type;
  } else if ('指标' in leaf) {
    checkKeys(leaf, ['指标', '参数', '运算', '值'], at, errors);
    const metric = METRICS[leaf.指标];
    if (!metric) {
      errors.push(`${at}.指标「${leaf.指标}」不在指标目录中，只能用 ${Object.keys(METRICS).join(' / ')}`);
      return;
    }
    const params = leaf.参数 === undefined ? {} : leaf.参数;
    if (!isPlainObject(params)) {
      errors.push(`${at}.参数 必须是对象`);
      return;
    }
    checkKeys(params, metric.paramKeys, `${at}.参数`, errors);
    metric.validate(params, at, errors);
    type = metric.type;
  } else {
    errors.push(`${at} 必须含「字段」或「指标」`);
    return;
  }
  const ops = OPS_BY_TYPE[type];
  if (!ops.includes(leaf.运算)) {
    errors.push(`${at}.运算「${leaf.运算}」不适用于${type}，可用：${ops.join(' ')}`);
    return;
  }
  checkValue(type, leaf.运算, leaf.值, at, errors);
}

// 条件 = "总是" | [或组, ...]；或组 = [条件行, ...]（组内为「且」，组之间为「或」）
function validateWhen(when, at, errors) {
  if (when === '总是') return;
  if (!Array.isArray(when) || !when.length || when.length > 10) {
    errors.push(`${at} 必须是 "总是" 或 1~10 个或组组成的数组，如 [[条件, 条件], [条件]]`);
    return;
  }
  when.forEach((group, g) => {
    if (!Array.isArray(group) || !group.length || group.length > 10) {
      errors.push(`${at}[${g}] 每个或组必须是 1~10 个条件行组成的数组`);
      return;
    }
    group.forEach((leaf, i) => validateLeaf(leaf, `${at}[${g}][${i}]`, errors));
  });
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

function validateTemplate(text, at, errors, required) {
  if (text === undefined || text === '') {
    if (required) errors.push(`${at} 必填`);
    return;
  }
  if (typeof text !== 'string' || text.length > 80) {
    errors.push(`${at} 必须是 80 字以内的文本`);
    return;
  }
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!FIELDS[match[1]] && !METRICS[match[1]]) {
      errors.push(`${at} 占位符 {${match[1]}} 不是已知字段或指标`);
    }
  }
}

// 校验一条译文；clause 为条款（来源、原文、通用规则类型）
function validateEntry(entry, clause, at = '译文') {
  const errors = [];
  if (!isPlainObject(entry)) return [`${at} 必须是对象`];
  checkKeys(entry, ['指纹', '名称', '来源', '原文', '规则类型', '适用期次', '依据', '分支', '未译部分',
    '驳回意见', '原译文'], at, errors);
  if (typeof entry.指纹 !== 'string' || !entry.指纹) {
    errors.push(`${at}.指纹 必填，照抄待翻译草稿里的值`);
  }
  const source = normText(clause ? clause.原文 : '');
  if (entry.依据 !== undefined) {
    if (!Array.isArray(entry.依据)) {
      errors.push(`${at}.依据 必须是数组`);
    } else {
      entry.依据.forEach((quote, i) => {
        if (typeof quote !== 'string' || !quote.trim() || (clause && !source.includes(normText(quote)))) {
          errors.push(`${at}.依据[${i}] 必须是原文中的原样片段`);
        }
      });
    }
  }
  const leftover = entry.未译部分 === undefined ? [] : entry.未译部分;
  if (!Array.isArray(leftover)) {
    errors.push(`${at}.未译部分 必须是数组`);
  } else {
    leftover.forEach((item, i) => {
      const iAt = `${at}.未译部分[${i}]`;
      if (!isPlainObject(item)) {
        errors.push(`${iAt} 必须是对象`);
        return;
      }
      checkKeys(item, ['原文', '原因'], iAt, errors);
      if (typeof item.原文 !== 'string' || !item.原文.trim() || (clause && !source.includes(normText(item.原文)))) {
        errors.push(`${iAt}.原文 必须是原文中的原样片段`);
      }
      if (typeof item.原因 !== 'string' || !item.原因.trim()) {
        errors.push(`${iAt}.原因 必填，写明为什么无法用字段与指标表达`);
      }
    });
  }
  const branches = entry.分支 === undefined ? [] : entry.分支;
  if (!Array.isArray(branches) || branches.length > 20) {
    errors.push(`${at}.分支 必须是 0~20 项的数组`);
    return errors;
  }
  if (!branches.length && !(Array.isArray(leftover) && leftover.length)) {
    errors.push(`${at}.分支 为空时必须在「未译部分」写明原因`);
  }
  const kind = clause && clause.来源 === SOURCE_GENERAL ? generalKind(clause.ruleType) : null;
  branches.forEach((branch, i) => {
    const bAt = `${at}.分支[${i}]`;
    if (!isPlainObject(branch)) {
      errors.push(`${bAt} 必须是对象`);
      return;
    }
    if (!ACTIONS.includes(branch.动作)) {
      errors.push(`${bAt}.动作 只能是 ${ACTIONS.join(' / ')}`);
      return;
    }
    if (kind === '硬' && branch.动作 === '加分') {
      errors.push(`${bAt}.动作 硬规则只能用 准入 / 剔除`);
    }
    if (kind === '软' && branch.动作 !== '加分') {
      errors.push(`${bAt}.动作 软规则只能用 加分`);
    }
    if (branch.动作 === '加分') {
      checkKeys(branch, ['动作', '当', '分', '理由'], bAt, errors);
      if (!Number.isInteger(branch.分) || branch.分 === 0 || branch.分 < -100 || branch.分 > 100) {
        errors.push(`${bAt}.分 必须是 -100~100 的非零整数`);
      }
    } else {
      checkKeys(branch, ['动作', '当', '理由'], bAt, errors);
    }
    validateTemplate(branch.理由, `${bAt}.理由`, errors, branch.动作 === '剔除');
    if (branch.当 === undefined) {
      errors.push(`${bAt}.当 必填（无条件时写 "总是"）`);
    } else {
      validateWhen(branch.当, `${bAt}.当`, errors);
    }
  });
  return errors;
}

// 只保留执行需要的键，草稿里的说明性字段不入库
function cleanEntry(entry) {
  const out = { 指纹: entry.指纹 };
  if (entry.依据 && entry.依据.length) out.依据 = entry.依据;
  out.分支 = entry.分支 || [];
  if (entry.未译部分 && entry.未译部分.length) out.未译部分 = entry.未译部分;
  return out;
}

// 班次类别表：按顺序首个命中生效，都不命中为「其他」
function validateCategories(list, at = '班次类别') {
  const errors = [];
  if (!Array.isArray(list) || !list.length) return [`${at} 必须是非空数组`];
  list.forEach((item, i) => {
    const iAt = `${at}[${i}]`;
    if (!isPlainObject(item)) {
      errors.push(`${iAt} 必须是对象`);
      return;
    }
    checkKeys(item, ['类别', '班次名称包含全部', '班次名称包含任一'], iAt, errors);
    if (typeof item.类别 !== 'string' || !item.类别.trim()) errors.push(`${iAt}.类别 必填`);
    const all = item.班次名称包含全部;
    const any = item.班次名称包含任一;
    const okList = v => v === undefined || (Array.isArray(v) && v.length && v.every(s => typeof s === 'string' && s));
    if (!okList(all) || !okList(any) || (all === undefined && any === undefined)) {
      errors.push(`${iAt} 需要「班次名称包含全部」或「班次名称包含任一」（非空文本数组）`);
    }
  });
  return errors;
}

function buildClassifier(list) {
  return className => {
    const name = String(className || '');
    for (const item of list) {
      const all = item.班次名称包含全部 || [];
      const any = item.班次名称包含任一;
      if (all.every(s => name.includes(s)) && (!any || any.some(s => name.includes(s)))) {
        return item.类别;
      }
    }
    return '其他';
  };
}

// ---------- 编译 ----------
// 条件函数签名：(ctx, hits) => boolean，hits 记录命中的字段/指标值供理由模板使用
function compileLeaf(leaf) {
  const op = leaf.运算;
  const expected = typeof leaf.值 === 'string' ? leaf.值.trim()
    : (Array.isArray(leaf.值) ? leaf.值.map(v => v.trim()) : leaf.值);
  if ('字段' in leaf) {
    const name = leaf.字段;
    const getter = FIELDS[name].get;
    return (c, hits) => {
      const actual = getter(c);
      hits[name] = actual;
      return applyOp(op, actual, expected);
    };
  }
  const name = leaf.指标;
  const metric = METRICS[name];
  const params = leaf.参数 || {};
  return (c, hits) => {
    const actual = metric.compute(c, params);
    hits[name] = actual;
    return applyOp(op, actual, expected);
  };
}

function compileWhen(when) {
  if (when === '总是') return () => true;
  const groups = when.map(group => group.map(compileLeaf));
  return (c, hits) => groups.some(group => group.every(fn => fn(c, hits)));
}

function whenIsDynamic(when) {
  if (when === '总是') return false;
  return when.some(group => group.some(leaf => leaf.指标 !== undefined
    && METRICS[leaf.指标].dynamic(leaf.参数 || {})));
}

function fillTemplate(text, c, hits) {
  if (!text) return null;
  return text.replace(PLACEHOLDER, (all, name) => {
    let value = name in hits ? hits[name] : (FIELDS[name] ? FIELDS[name].get(c) : '');
    if (typeof value === 'number' && !Number.isInteger(value)) value = value.toFixed(1);
    return value == null ? '' : String(value);
  });
}

// 编译一条已校验译文：
//   准入：每个准入分支都必须满足，否则剔除
//   剔除：任一剔除分支命中即剔除
//   加分：自上而下首个命中的加分分支计分
function compileEntry(entry, clause) {
  const label = clause.名称;
  const branches = (entry.分支 || []).map(b => Object.assign({}, b, {
    test: compileWhen(b.当),
    dynamic: whenIsDynamic(b.当),
  }));
  const gates = branches.filter(b => b.动作 !== '加分').map(b => Object.assign(b, {
    reasonText: b.理由 || (b.动作 === '准入' ? `不符合「${label}」` : `命中「${label}」`),
  }));
  const scores = branches.filter(b => b.动作 === '加分');
  return {
    fp: clause.指纹,
    name: label,
    source: clause.来源,
    hasScores: scores.length > 0,
    hasDynamicGates: gates.some(g => g.dynamic),
    hasStaticGates: gates.some(g => !g.dynamic),
    // 返回剔除理由或 null；dynamic 指定只跑动态或静态分支
    gate(c, dynamic) {
      for (const g of gates) {
        if (g.dynamic !== dynamic) continue;
        const hits = {};
        const passed = g.test(c, hits);
        if (g.动作 === '准入' ? !passed : passed) return fillTemplate(g.reasonText, c, hits);
      }
      return null;
    },
    score(c) {
      for (const s of scores) {
        const hits = {};
        if (s.test(c, hits)) return { score: s.分, reason: fillTemplate(s.理由, c, hits) };
      }
      return null;
    },
    // 试算用：逐分支判断是否生效（准入不满足 / 剔除命中 / 加分命中）
    effects(c) {
      return branches.map(b => {
        const passed = b.test(c, {});
        return b.动作 === '准入' ? !passed : passed;
      });
    },
  };
}

// ---------- 中文复述（供查看与审核表） ----------
function describeParams(params) {
  return Object.entries(params || {}).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}=${v.map(x => (Array.isArray(x) ? x.join('~') : x)).join('、')}`;
    if (typeof v === 'boolean') return `${k}=${v ? '是' : '否'}`;
    return `${k}=${v}`;
  }).join('；');
}

function describeLeaf(leaf) {
  let subject = leaf.字段;
  if (leaf.指标 !== undefined) {
    const params = describeParams(leaf.参数);
    subject = params ? `${leaf.指标}[${params}]` : leaf.指标;
  }
  if (NO_VALUE_OPS.includes(leaf.运算)) return `${subject} ${leaf.运算}`;
  const value = Array.isArray(leaf.值) ? leaf.值.join('、') : leaf.值;
  return `${subject} ${leaf.运算} ${value}`;
}

function describeWhen(when) {
  if (when === '总是') return '总是';
  const parts = when.map(group => group.map(describeLeaf).join(' 且 '));
  return parts.length === 1 ? parts[0] : parts.map(p => `（${p}）`).join(' 或 ');
}

function describeBranch(branch) {
  const cond = describeWhen(branch.当);
  if (branch.动作 === '准入') return `须满足 ${cond}，否则剔除${branch.理由 ? `（${branch.理由}）` : ''}`;
  if (branch.动作 === '剔除') return `若 ${cond} → 剔除（${branch.理由}）`;
  return `若 ${cond} → ${branch.分 > 0 ? '+' : ''}${branch.分}分${branch.理由 ? `（${branch.理由}）` : ''}`;
}

function describeEntry(entry) {
  const lines = (entry.分支 || []).map(describeBranch);
  (entry.未译部分 || []).forEach(item => lines.push(`不执行：「${item.原文}」（${item.原因}）`));
  return lines;
}

// ---------- 条款收集 ----------
function priorityOf(rule) {
  const num = toNumber(rule.priority);
  return num === null ? 999 : num;
}

function alive(row) {
  return String(row.delFlag || '0') !== '2';
}

const byText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

// 期次固定排序：开始日期 → 班次名称 → 期次 → 计划编号（引擎与条款收集共用）
function planOrder(a, b) {
  return byText(String(a.startDate || '9999'), String(b.startDate || '9999'))
    || byText(String(a.className || ''), String(b.className || ''))
    || byText(String(a.sessionNo || ''), String(b.sessionNo || ''))
    || byText(String(a.planId || ''), String(b.planId || ''));
}

// 本批次全部条款：先计划条款（按首次出现的期次），后通用规则（优先级 → 名称 → 指纹）
function collectClauses(ruleRows, planRows, year) {
  const clauses = [];
  const planClauses = new Map();
  const plans = (planRows || []).filter(alive)
    .filter(p => year == null || String(p.planYear) === String(year))
    .sort(planOrder);
  for (const plan of plans) {
    for (const [source, key] of [[SOURCE_TARGET, 'targetGroup'], [SOURCE_PLAN_RULE, 'ruleDesc']]) {
      const text = String(plan[key] || '').trim();
      if (!text) continue;
      const fp = planFingerprint(source, text);
      let clause = planClauses.get(fp);
      if (!clause) {
        clause = { 指纹: fp, 来源: source, 原文: text, planIds: [], 期次: [] };
        planClauses.set(fp, clause);
        clauses.push(clause);
      }
      clause.planIds.push(String(plan.planId || ''));
      clause.期次.push(`${plan.className || ''}${plan.sessionNo || ''}`);
    }
  }
  clauses.forEach(clause => {
    clause.名称 = `${clause.来源.replace('计划·', '')}：${summarizeSessions(clause.期次)}`;
    clause.适用 = clause.期次.join('、');
  });
  (ruleRows || [])
    .filter(r => alive(r) && String(r.enabled == null ? '1' : r.enabled).trim() !== '0')
    .map(r => ({
      指纹: fingerprint(r),
      来源: SOURCE_GENERAL,
      名称: String(r.ruleName || ''),
      原文: String(r.ruleContent || r.ruleName || ''),
      ruleType: r.ruleType,
      priority: priorityOf(r),
      适用: '本年度全部期次',
    }))
    .sort((a, b) => a.priority - b.priority || byText(a.名称, b.名称) || byText(a.指纹, b.指纹))
    .forEach(clause => clauses.push(clause));
  return clauses;
}

// 「四级领导人员进修班第一期、…第四期」→「四级领导人员进修班 第一期~第四期」
function summarizeSessions(list) {
  const byClass = new Map();
  list.forEach(item => {
    const m = item.match(/^(.*?)(第.+期|\d+)$/);
    const cls = m ? m[1] : item;
    if (!byClass.has(cls)) byClass.set(cls, []);
    if (m) byClass.get(cls).push(m[2]);
  });
  return [...byClass.entries()].map(([cls, nos]) => {
    if (!nos.length) return cls;
    return nos.length > 2 ? `${cls} ${nos[0]}~${nos[nos.length - 1]}` : `${cls} ${nos.join('、')}`;
  }).join('；');
}

// ---------- 译文库 ----------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} 不是合法 JSON：${err.message}`);
  }
}

// 内置译文（随技能发布，只读，状态视为待审核）+ 用户译文库（输出/规则解析）
function loadLibrary() {
  const preset = readJson(PRESET_FILE) || {};
  const user = readJson(LIBRARY_FILE) || {};
  return {
    班次类别: user.班次类别 && user.班次类别.length ? user.班次类别 : (preset.班次类别 || []),
    user: user.条款 || {},
    preset: preset.条款 || {},
  };
}

// 写入用户译文库（键排序，保证同样内容写出的文件逐字相同）
function saveLibrary(changes, categories) {
  const current = readJson(LIBRARY_FILE) || {};
  const items = Object.assign({}, current.条款 || {}, changes || {});
  const sorted = {};
  Object.keys(items).sort().forEach(key => { sorted[key] = items[key]; });
  const merged = { 版本: 2, 班次类别: categories || current.班次类别 || undefined, 条款: sorted };
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return LIBRARY_FILE;
}

// 条款当前状态与译文
function stateOf(clause, library) {
  const own = library.user[clause.指纹];
  if (own) return { status: own.状态, entry: own.译文, note: own.意见 || '', from: '译文库', record: own };
  const preset = library.preset[clause.指纹];
  if (preset) return { status: STATUS.REVIEW, entry: preset, note: '', from: '内置' };
  return { status: STATUS.TODO, entry: null, note: '', from: '' };
}

// 本批次条款逐个对上状态；errors 为已有译文但不合格（如字段目录调整后）
function resolveClauses(clauses, library = loadLibrary()) {
  return clauses.map(clause => {
    const state = stateOf(clause, library);
    const errors = state.entry ? validateEntry(state.entry, clause, `「${clause.名称}」`) : [];
    return Object.assign({ clause, errors }, state);
  });
}

// 待翻译草稿：未翻译的条款 + 被驳回的条款（附用户意见与原译文）
function draftFor(items) {
  return {
    说明: '按 references/rule_dsl.md 为每条填写「分支」和「未译部分」，然后执行 node index.js 规则 登记',
    条款: items.map(({ clause, entry, note, status }) => Object.assign(
      { 指纹: clause.指纹, 来源: clause.来源, 名称: clause.名称, 原文: clause.原文 },
      clause.来源 === SOURCE_GENERAL ? { 规则类型: clause.ruleType || '' } : { 适用期次: clause.适用 },
      status === STATUS.REJECTED ? { 驳回意见: note, 原译文: entry } : {},
      { 依据: [], 分支: [], 未译部分: [] },
    )),
  };
}

module.exports = {
  FIELDS, METRICS, OPS_BY_TYPE, ALL_OPS, ACTIONS, STATUS, LIST_OPS, NO_VALUE_OPS, NEVER_TRAINED_YEARS,
  SOURCE_GENERAL, SOURCE_TARGET, SOURCE_PLAN_RULE,
  LIBRARY_FILE, DRAFT_FILE, PRESET_FILE,
  normText, yesNo, toNumber, toDateText, toMs, fingerprint, planFingerprint, generalKind, typeOfLeaf,
  validateEntry, cleanEntry, validateCategories, buildClassifier, compileEntry, planOrder,
  describeEntry, describeBranch, describeWhen, describeLeaf, describeParams,
  collectClauses, loadLibrary, saveLibrary, resolveClauses, draftFor,
};
