// =====================================================
// ai_advisor.js —— 培小e 应训未训建议规则引擎
//
// 只读分析，不写业务数据。流程固定：
//   读规则表 → 识别规则（编码优先、关键词兜底）→ 逐计划筛人 → 硬规则剔除
//   → 软规则打分排序 → 按单位名额 / 计划人数取数
// 规则是"自定义"的：规则内容在 pxe_training_rule 表里维护，
// 新增/停用规则只改数据；每种 ruleCode 对应一个写死的执行器，避免歧义。
//
// 支持的规则编码：
//   硬规则：HARD_AB_ROLE / HARD_REPEAT_TRAIN / HARD_PROD_HEAD_SEASON / HARD_TARGET_LIMIT
//   软规则：SOFT_RECENT_UNTRAINED / SOFT_HOURS_GAP / SOFT_PARTY_SEC_ONLY
// 编码认不出时按规则名称/内容关键词兜底；仍认不出的列入 unknown 提示，不猜、不静默。
//
// 跨班次约束：一次运行内，已建议进入某班次的人会计入后续班次的
// 「本年度只安排一次」与「AB角同时段」判定，避免同一人被重复建议。
// =====================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const CFG = require('./config');
const trainer = require('./train_api');

const PYTHON = CFG.python || 'python';
const WRITER = path.join(__dirname, 'report_writer.py');

// 常量：与规则表内容一一对应
const RETIRE_AGE = 55;
const SEASON_RANGES = [['03-01', '06-30'], ['09-01', '11-30']];
const CLASS_TYPE_RULES = [
  [/新提任.*正职/, '新提任正职'],
  [/新提任.*副职/, '新提任副职'],
  [/县公司领导班子|县班子/, '县班子'],
  [/四级领导人员进修班/, '进修班'],
];
// 班次处理次序：对象范围窄的先排，避免候选人先被宽口径班次占用
const CLASS_TYPE_ORDER = ['新提任正职', '新提任副职', '县班子', '进修班', '其他'];

// ---------- 工具 ----------
function toDate(value) {
  if (!value) {
    return null;
  }
  const text = String(value).slice(0, 10);
  const parsed = new Date(`${text}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) {
    return false;
  }
  return aStart <= bEnd && aEnd >= bStart;
}

function overlapsSeason(start, end, ranges) {
  if (!start || !end) {
    return false;
  }
  // 按培训期实际跨越的年份逐年判断，跨年班次也能覆盖
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    const hit = ranges.some(([from, to]) => rangesOverlap(start, end,
      new Date(`${y}-${from}T00:00:00`), new Date(`${y}-${to}T00:00:00`)));
    if (hit) {
      return true;
    }
  }
  return false;
}

function classTypeOf(className) {
  for (const [pattern, type] of CLASS_TYPE_RULES) {
    if (pattern.test(className || '')) {
      return type;
    }
  }
  return '其他';
}

function yearsBetween(later, earlier) {
  if (!later || !earlier) {
    return null;
  }
  return (later.getTime() - earlier.getTime()) / (365.25 * 24 * 3600 * 1000);
}

function isEnabled(rule) {
  const value = rule.enabled;
  if (value === undefined || value === null || String(value).trim() === '') {
    return true;
  }
  return String(value).trim() !== '0';
}

function isDeleted(row) {
  return row && row.delFlag !== undefined && row.delFlag !== null && String(row.delFlag) === '2';
}

// 计划的参培对象级别：优先读 ruleDesc 里的 JSON（如 {"cadreLevel":["正科级","副科级"]}）
function allowedLevelsOf(plan) {
  const raw = plan.matchingRules || plan.ruleDesc;
  if (!raw) {
    return null;
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const list = parsed && parsed.cadreLevel;
    return Array.isArray(list) && list.length ? list.map(v => String(v).trim()) : null;
  } catch (err) {
    return null;
  }
}

// 新提任班在计划未配置对象级别时的兜底：正职班看「正」，副职班看「副 / 四级职员」
function matchesPromotionLevel(type, level) {
  if (!level) {
    return false;
  }
  if (type === '新提任正职') {
    return /正/.test(level);
  }
  return /副|四级职员/.test(level);
}

// 某人在本年度的全部"占用时段"：已有培训记录 + 本次运行已建议的班次
function occupiedSlots(empId, context) {
  const fromRecords = (context.recordsByEmp.get(empId) || [])
    .filter(r => String(r.planYear) === context.year)
    .map(r => ({ className: r.className, sessionNo: r.sessionNo,
      start: toDate(r.startDate), end: toDate(r.endDate), source: 'record' }));
  const fromRun = context.assigned.get(empId) || [];
  return fromRecords.concat(fromRun);
}

// ---------- 规则执行器 ----------
// 每个执行器返回 { excluded: true, reason } 或 { score, reason }，不适用时返回 null

// 硬规则：参培对象限制
function ruleTargetLimit(person, plan, context) {
  const age = Number(person.age || 0);
  const type = classTypeOf(plan.className);
  const level = String(person.cadreLevel || '').trim();
  if (age >= RETIRE_AGE && type === '进修班') {
    return { excluded: true, reason: `距退休5年内（${age}岁）不安排进修班` };
  }
  const allowed = allowedLevelsOf(plan);
  const isPromotion = type === '新提任正职' || type === '新提任副职';
  if (allowed) {
    if (level && !allowed.includes(level)) {
      return { excluded: true, reason: `干部级别「${level}」不在本班次对象范围（${allowed.join('、')}）` };
    }
    if (!level && isPromotion) {
      return { excluded: true, reason: `干部级别为空，无法确认是否为${type}对象` };
    }
    return null;
  }
  if (isPromotion && !matchesPromotionLevel(type, level)) {
    return { excluded: true, reason: `干部级别「${level || '空'}」非${type}对象` };
  }
  return null;
}

// 硬规则：重复参培剔除
//   本年度只安排 1 个班次（含已有记录与本次已建议）；上年度已参加同类别班次的不再安排
function ruleRepeatTrain(person, plan, context) {
  const slots = occupiedSlots(person.empId, context);
  const sameClass = slots.find(s => s.className === plan.className);
  if (sameClass) {
    const how = sameClass.source === 'record' ? '已参加' : '已建议参加';
    return { excluded: true, reason: `本年度${how} ${plan.className}${sameClass.sessionNo ? `（${sameClass.sessionNo}）` : ''}` };
  }
  const other = slots.find(s => s.className !== plan.className);
  if (other) {
    const how = other.source === 'record' ? '已安排' : '已建议参加';
    return { excluded: true, reason: `本年度${how} ${other.className}` };
  }
  const type = classTypeOf(plan.className);
  const lastYearSame = (context.recordsByEmp.get(person.empId) || [])
    .some(r => String(r.planYear) === context.prevYear && classTypeOf(r.className) === type);
  if (lastYearSame) {
    return { excluded: true, reason: `${context.prevYear}年度已参加同类别班次` };
  }
  return null;
}

// 硬规则：生产分管负责人避开春秋检
function ruleProdHeadSeason(person, plan, context) {
  if (person.isProdHead !== '是') {
    return null;
  }
  if (overlapsSeason(toDate(plan.startDate), toDate(plan.endDate), SEASON_RANGES)) {
    return { excluded: true, reason: '生产分管负责人与春秋检时段重叠' };
  }
  return null;
}

// 硬规则：AB 角不得同出
//   双向判定：本人的 B 角、或把本人登记为 B 角的人，若在时间重叠的班次里
//   已有记录或已被建议，则剔除。按员工编号比对，B 角姓名限定同单位，避免重名误判。
function ruleAbRoleConflict(person, plan, context) {
  const partners = new Set();
  const myPartnerName = String(person.bRole || '').trim();
  if (myPartnerName) {
    (context.leadersByName.get(myPartnerName) || [])
      .filter(p => p.empId !== person.empId)
      .filter(p => !person.unitName || !p.unitName || p.unitName === person.unitName)
      .forEach(p => partners.add(p.empId));
  }
  (context.reverseBRole.get(String(person.empName || '').trim()) || [])
    .filter(p => p.empId !== person.empId)
    .filter(p => !person.unitName || !p.unitName || p.unitName === person.unitName)
    .forEach(p => partners.add(p.empId));
  if (!partners.size) {
    return null;
  }
  const start = toDate(plan.startDate);
  const end = toDate(plan.endDate);
  for (const partnerId of partners) {
    const clash = occupiedSlots(partnerId, context).find(s =>
      (s.planId && s.planId === plan.planId)
      || (s.className === plan.className && s.sessionNo === plan.sessionNo)
      || rangesOverlap(start, end, s.start, s.end));
    if (clash) {
      const partner = context.leaderById.get(partnerId) || {};
      return { excluded: true,
        reason: `与AB角 ${partner.empName || partnerId} 培训时间重叠（${clash.className}${clash.sessionNo ? ' ' + clash.sessionNo : ''}）` };
    }
  }
  return null;
}

// 软规则：近3年未参培优先（只看开班日之前的记录）
function scoreRecentUntrained(person, plan, context) {
  const start = toDate(plan.startDate) || new Date();
  const gaps = (context.recordsByEmp.get(person.empId) || [])
    .map(r => yearsBetween(start, toDate(r.startDate)))
    .filter(v => v !== null && v >= 0);
  if (!gaps.length) {
    return { score: 30, reason: '近3年未参培' };
  }
  const min = Math.min(...gaps);
  if (min >= 3) {
    return { score: 30, reason: `距上次参培 ${min.toFixed(1)} 年` };
  }
  if (min >= 1) {
    return { score: 12, reason: `距上次参培 ${min.toFixed(1)} 年` };
  }
  return { score: 0, reason: null };
}

// 软规则：学时缺口优先
function scoreHoursGap(person, plan, context) {
  const hours = Number(person.totalHours || 0);
  if (hours < 100) {
    return { score: 25, reason: `累计学时偏低（${hours}）` };
  }
  if (hours < 200) {
    return { score: 12, reason: null };
  }
  return { score: 0, reason: null };
}

// 软规则：党支部书记专场
function scorePartySecretary(person, plan, context) {
  if (person.isPartySec !== '是') {
    return null;
  }
  if (isPartySecSession(plan)) {
    return { score: 35, reason: '党支部书记专场安排' };
  }
  return { score: -20, reason: null, note: '党支部书记统一安排第五期专场' };
}

function isPartySecSession(plan) {
  return classTypeOf(plan.className) === '进修班' && /第五期/.test(plan.sessionNo || '');
}

const RULE_EXECUTORS = {
  HARD_AB_ROLE: ruleAbRoleConflict,
  HARD_REPEAT_TRAIN: ruleRepeatTrain,
  HARD_PROD_HEAD_SEASON: ruleProdHeadSeason,
  HARD_TARGET_LIMIT: ruleTargetLimit,
  SOFT_RECENT_UNTRAINED: scoreRecentUntrained,
  SOFT_HOURS_GAP: scoreHoursGap,
  SOFT_PARTY_SEC_ONLY: scorePartySecretary,
};

const RULE_LABELS = {
  HARD_AB_ROLE: 'AB角不得同出',
  HARD_REPEAT_TRAIN: '重复参培剔除',
  HARD_PROD_HEAD_SEASON: '生产分管负责人避开春秋检',
  HARD_TARGET_LIMIT: '参培对象限制',
  SOFT_RECENT_UNTRAINED: '近3年未参培优先',
  SOFT_HOURS_GAP: '学时缺口优先',
  SOFT_PARTY_SEC_ONLY: '党支部书记专场',
};

// 规则识别：用户上传的规则编码可能不同，用关键词兜底映射到执行器
// 次序有意义：越具体的规则越靠前
const RULE_PATTERNS = [
  { code: 'HARD_AB_ROLE', keywords: ['ab角', 'b角', '同出'] },
  { code: 'HARD_PROD_HEAD_SEASON', keywords: ['春秋检', '春检', '秋检', '生产分管'] },
  { code: 'SOFT_PARTY_SEC_ONLY', keywords: ['党支部书记', '书记专场'] },
  { code: 'HARD_TARGET_LIMIT', keywords: ['退休', '新提任', '参培对象', '对象限制'] },
  { code: 'HARD_REPEAT_TRAIN', keywords: ['重复参培', '同类别班次', '只安排参加', '不重复'] },
  { code: 'SOFT_RECENT_UNTRAINED', keywords: ['近3年', '近三年', '未参培'] },
  { code: 'SOFT_HOURS_GAP', keywords: ['学时缺口', '学时偏低', '学时低', '累计学时'] },
];

// 解析单条规则：优先按 ruleCode 精确匹配，否则按名称与内容关键词兜底
function resolveExecutor(rule) {
  const code = String(rule.ruleCode || '').trim();
  if (RULE_EXECUTORS[code]) {
    return { code, executor: RULE_EXECUTORS[code], matchedBy: 'code' };
  }
  // 名称比内容更能代表规则本意，先看名称再看内容
  for (const text of [rule.ruleName, rule.ruleContent]) {
    const lower = String(text || '').toLowerCase();
    if (!lower) {
      continue;
    }
    for (const pattern of RULE_PATTERNS) {
      if (pattern.keywords.some(keyword => lower.includes(keyword.toLowerCase()))) {
        return { code: pattern.code, executor: RULE_EXECUTORS[pattern.code], matchedBy: 'keyword',
          customCode: code || null };
      }
    }
  }
  return null;
}

// ---------- 主流程 ----------
async function generateAdvice({ year = '2027', limitPerUnit, outDir, account, credential } = {}) {
  const safeYear = String(year);
  const prevYear = String(Number(safeYear) - 1);
  const [leadersR, plansR, quotasR, recordsR, rulesR] = await Promise.all([
    trainer.queryAll('pxe_leader_info', {}, account, credential),
    trainer.queryAll('pxe_training_plan', { planYear: safeYear }, account, credential),
    trainer.queryAll('pxe_quota_alloc', {}, account, credential),
    trainer.queryAll('pxe_train_record', {}, account, credential),
    trainer.queryAll('pxe_training_rule', {}, account, credential),
  ]);
  for (const [name, result] of [['人员', leadersR], ['计划', plansR], ['名额', quotasR],
    ['记录', recordsR], ['规则', rulesR]]) {
    if (!result.ok) {
      return { ok: false, message: `读取${name}失败: ${result.message || result.error}` };
    }
  }

  const leaders = leadersR.rows.filter(r => !isDeleted(r));
  const plans = plansR.rows.filter(r => !isDeleted(r));
  const quotas = quotasR.rows.filter(r => !isDeleted(r));
  const records = recordsR.rows.filter(r => !isDeleted(r));
  const rules = rulesR.rows.filter(r => isEnabled(r) && !isDeleted(r));

  // 规则分派：硬/软由执行器决定；规则表里写的类型与执行器不符时给出提示
  const hardRules = [];
  const softRules = [];
  const unknownRules = [];
  const warnings = [];
  const seenCodes = new Map();
  rules.forEach(rule => {
    const resolved = resolveExecutor(rule);
    if (!resolved) {
      unknownRules.push({ code: rule.ruleCode, name: rule.ruleName });
      return;
    }
    if (seenCodes.has(resolved.code)) {
      warnings.push(`规则「${rule.ruleName}」与「${seenCodes.get(resolved.code)}」识别为同一条（${RULE_LABELS[resolved.code]}），已忽略，避免重复计算`);
      return;
    }
    seenCodes.set(resolved.code, rule.ruleName);
    const isHard = resolved.code.startsWith('HARD_');
    const declared = String(rule.ruleType || '').trim();
    if ((declared === '硬规则' && !isHard) || (declared === '软规则' && isHard)) {
      warnings.push(`规则「${rule.ruleName}」在表中标为${declared}，但识别为${isHard ? '硬' : '软'}规则（${RULE_LABELS[resolved.code]}），已按${isHard ? '硬' : '软'}规则执行`);
    }
    const entry = Object.assign({}, resolved, {
      name: rule.ruleName,
      content: rule.ruleContent,
      priority: Number(rule.priority == null || rule.priority === '' ? 999 : rule.priority),
    });
    (isHard ? hardRules : softRules).push(entry);
  });
  // 优先级数字越小越先执行；未填优先级的排到最后
  const byPriority = (a, b) => a.priority - b.priority;
  hardRules.sort(byPriority);
  softRules.sort(byPriority);
  const abRule = hardRules.find(item => item.code === 'HARD_AB_ROLE');
  const hardBeforeQuota = hardRules.filter(item => item.code !== 'HARD_AB_ROLE');
  const hasPartySecRule = softRules.some(item => item.code === 'SOFT_PARTY_SEC_ONLY');

  // 索引
  const recordsByEmp = new Map();
  records.forEach(r => {
    if (!recordsByEmp.has(r.empId)) {
      recordsByEmp.set(r.empId, []);
    }
    recordsByEmp.get(r.empId).push(r);
  });
  const leaderById = new Map(leaders.map(p => [p.empId, p]));
  const leadersByName = new Map();
  const reverseBRole = new Map();
  leaders.forEach(p => {
    const name = String(p.empName || '').trim();
    if (name) {
      if (!leadersByName.has(name)) {
        leadersByName.set(name, []);
      }
      leadersByName.get(name).push(p);
    }
    const b = String(p.bRole || '').trim();
    if (b) {
      if (!reverseBRole.has(b)) {
        reverseBRole.set(b, []);
      }
      reverseBRole.get(b).push(p);
    }
  });

  const context = {
    year: safeYear,
    prevYear,
    records,
    recordsByEmp,
    leaderById,
    leadersByName,
    reverseBRole,
    assigned: new Map(),       // empId -> [{ planId, className, sessionNo, start, end, source }]
    selectedNames: new Set(),  // 兼容旧字段：本次已建议人员姓名
  };

  // 处理次序：对象范围窄的班次先排；有党支部书记专场规则时专场期次先排，
  // 其余按开班日期。输出时恢复原计划次序。
  const order = plans.map((plan, index) => ({ plan, index }));
  order.sort((a, b) => {
    const ta = CLASS_TYPE_ORDER.indexOf(classTypeOf(a.plan.className));
    const tb = CLASS_TYPE_ORDER.indexOf(classTypeOf(b.plan.className));
    if (ta !== tb) {
      return ta - tb;
    }
    if (hasPartySecRule) {
      const pa = isPartySecSession(a.plan) ? 0 : 1;
      const pb = isPartySecSession(b.plan) ? 0 : 1;
      if (pa !== pb) {
        return pa - pb;
      }
    }
    return String(a.plan.startDate || '').localeCompare(String(b.plan.startDate || ''))
      || a.index - b.index;
  });

  const usedPlanIds = new Set(quotas.map(q => q.planId));
  const resultsByIndex = [];

  for (const { plan, index } of order) {
    const quotaByUnit = {};
    quotas.filter(q => q.planId === plan.planId)
      .forEach(q => { quotaByUnit[q.unitName] = Number(q.quotaCount || 0); });
    const planCap = Number(plan.planCount || 0) > 0 ? Number(plan.planCount) : Infinity;

    const candidates = [];
    const excluded = [];
    const pushExcluded = (person, rule, ruleName, reason) => excluded.push({
      empId: person.empId, empName: person.empName, unitName: person.unitName, rule, ruleName, reason });

    for (const person of leaders) {
      // 没有名额的单位不进入候选，也不计入剔除
      if (quotaByUnit[person.unitName] === undefined) {
        continue;
      }
      let blocked = false;
      for (const item of hardBeforeQuota) {
        const verdict = item.executor(person, plan, context);
        if (verdict && verdict.excluded) {
          pushExcluded(person, item.code, item.name, verdict.reason);
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }
      const hit = { softScore: 0, reasons: [], person };
      for (const item of softRules) {
        const verdict = item.executor(person, plan, context);
        if (verdict) {
          hit.softScore += verdict.score || 0;
          if (verdict.reason) {
            hit.reasons.push(verdict.reason);
          }
        }
      }
      candidates.push(hit);
    }

    // 高分优先；同分按累计学时升序
    candidates.sort((a, b) => b.softScore - a.softScore
      || Number(a.person.totalHours || 0) - Number(b.person.totalHours || 0));

    // 按单位名额与计划人数取数；AB 角需要看已入选的人，在取数时实时判定
    const unitUsed = {};
    const suggestions = [];
    const start = toDate(plan.startDate);
    const end = toDate(plan.endDate);
    for (const item of candidates) {
      const person = item.person;
      const quota = quotaByUnit[person.unitName];
      const cap = limitPerUnit ? Math.min(quota, Number(limitPerUnit)) : quota;
      const used = unitUsed[person.unitName] || 0;
      if (used >= cap) {
        pushExcluded(person, 'QUOTA', '名额限制', `本单位名额已满（${cap}）`);
        continue;
      }
      if (suggestions.length >= planCap) {
        pushExcluded(person, 'PLAN_COUNT', '计划人数限制', `本期计划人数已满（${planCap}）`);
        continue;
      }
      if (abRule) {
        const verdict = ruleAbRoleConflict(person, plan, context);
        if (verdict && verdict.excluded) {
          pushExcluded(person, abRule.code, abRule.name, verdict.reason);
          continue;
        }
      }
      unitUsed[person.unitName] = used + 1;
      context.selectedNames.add(person.empName);
      if (!context.assigned.has(person.empId)) {
        context.assigned.set(person.empId, []);
      }
      context.assigned.get(person.empId).push({ planId: plan.planId, className: plan.className,
        sessionNo: plan.sessionNo, start, end, source: 'advice' });
      suggestions.push({
        empId: person.empId,
        empName: person.empName,
        unitName: person.unitName,
        cadreLevel: person.cadreLevel,
        isPartySec: person.isPartySec,
        isProdHead: person.isProdHead,
        totalHours: person.totalHours,
        score: Math.max(10, Math.min(100, 50 + item.softScore)),
        priority: item.softScore >= 40 ? '高' : (item.softScore >= 15 ? '中' : '低'),
        reasons: item.reasons,
      });
    }

    const quotaTotal = Object.values(quotaByUnit).reduce((sum, n) => sum + n, 0);
    if (planCap !== Infinity && quotaTotal > planCap) {
      warnings.push(`${plan.className}${plan.sessionNo ? ' ' + plan.sessionNo : ''}：单位名额合计 ${quotaTotal} 超过计划人数 ${planCap}，已按计划人数截取`);
    }
    if (Object.keys(quotaByUnit).length && suggestions.length === 0) {
      warnings.push(`${plan.className}${plan.sessionNo ? ' ' + plan.sessionNo : ''}：有名额但无人可建议，请核对剔除原因`);
    }

    resultsByIndex[index] = {
      planId: plan.planId,
      className: plan.className,
      sessionNo: plan.sessionNo,
      classType: classTypeOf(plan.className),
      startDate: plan.startDate,
      endDate: plan.endDate,
      timeText: `${plan.startDate || ''} 至 ${plan.endDate || ''}`,
      place: plan.trainPlace,
      planCount: plan.planCount,
      targetGroup: plan.targetGroup,
      ruleDesc: plan.ruleDesc,
      ruleKey: plan.ruleKey,
      quotaUsed: Object.keys(quotaByUnit).length ? unitUsed : {},
      quota: quotaByUnit,
      suggestions,
      excluded,
    };
  }
  const planResults = resultsByIndex.filter(Boolean);

  const result = {
    ok: true,
    year: safeYear,
    summary: {
      plans: planResults.length,
      total: planResults.reduce((sum, p) => sum + p.suggestions.length, 0),
      people: context.assigned.size,
      excluded: planResults.reduce((sum, p) => sum + p.excluded.length, 0),
      rules: {
        hard: hardRules.map(item => item.code),
        soft: softRules.map(item => item.code),
        matchedByKeyword: hardRules.concat(softRules).filter(item => item.matchedBy === 'keyword').length,
        unknown: unknownRules,
        warnings,
      },
      plansWithoutQuota: plans.filter(p => !usedPlanIds.has(p.planId)).length,
    },
    plans: planResults,
  };

  // 输出 Excel + HTML（占位符模板替换）
  const targetDir = outDir || CFG.outDir;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const jsonPath = path.join(CFG.processDir || os.tmpdir(), `peixiaoe_advice_${Date.now()}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result), 'utf8');
    const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    const output = execFileSync(PYTHON, [WRITER, '--advice', jsonPath, targetDir], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env,
    });
    const written = JSON.parse(output);
    fs.unlinkSync(jsonPath);
    result.files = written.files || [];
  } catch (err) {
    result.writeError = err.message;
  }
  return result;
}

module.exports = { generateAdvice, RULE_EXECUTORS, classTypeOf, resolveExecutor };
