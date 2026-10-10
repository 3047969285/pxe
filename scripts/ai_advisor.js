// =====================================================
// ai_advisor.js —— 培小e 应训未训建议规则引擎
//
// 只读分析，不写业务数据。流程固定：
//   读规则表 → 按 ruleCode 找执行器 → 逐计划筛人 → 打分排序 → 按名额取数
// 规则是"自定义"的：规则内容在 pxe_training_rule 表里维护，
// 新增/停用规则只改数据；每种 ruleCode 对应一个写死的执行器，避免歧义。
//
// 支持的规则编码：
//   硬规则：HARD_AB_ROLE / HARD_REPEAT_TRAIN / HARD_PROD_HEAD_SEASON / HARD_TARGET_LIMIT
//   软规则：SOFT_RECENT_UNTRAINED / SOFT_HOURS_GAP / SOFT_PARTY_SEC_ONLY
// 遇到未识别的 ruleCode 时跳过并在结果中提示，不猜、不静默
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
const TRAINED_YEAR = '2026';
const SEASON_RANGES = [['03-01', '06-30'], ['09-01', '11-30']];
const CLASS_TYPE_RULES = [
  [/新提任.*正职/, '新提任正职'],
  [/新提任.*副职/, '新提任副职'],
  [/县公司领导班子|县班子/, '县班子'],
  [/四级领导人员进修班/, '进修班'],
];

// ---------- 工具 ----------
function toDate(value) {
  if (!value) {
    return null;
  }
  const text = String(value).slice(0, 10);
  const parsed = new Date(`${text}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function overlaps(start, end, ranges, year) {
  if (!start || !end) {
    return false;
  }
  return ranges.some(([from, to]) => {
    const rangeStart = new Date(`${year}-${from}T00:00:00`);
    const rangeEnd = new Date(`${year}-${to}T00:00:00`);
    return start <= rangeEnd && end >= rangeStart;
  });
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

// ---------- 规则执行器 ----------
// 每个执行器返回 { excluded: true, reason } 或 { score, reason }

// 硬规则：参培对象限制
function ruleTargetLimit(person, plan, context) {
  const age = Number(person.age || 0);
  const type = classTypeOf(plan.className);
  if (age >= RETIRE_AGE && type === '进修班') {
    return { excluded: true, reason: `距退休5年内（${age}岁）不安排进修班` };
  }
  if (type === '新提任正职' || type === '新提任副职') {
    const expect = type === '新提任正职' ? /正职/ : /副职/;
    if (!expect.test(person.cadreLevel || '')) {
      return { excluded: true, reason: `非${type}对象` };
    }
  }
  return null;
}

// 硬规则：重复参培剔除
function ruleRepeatTrain(person, plan, context) {
  const type = classTypeOf(plan.className);
  const sameYear = context.records.filter(r => r.empId === person.empId && String(r.planYear) === String(context.year));
  const otherPlan = sameYear.find(r => r.className !== plan.className);
  if (otherPlan) {
    return { excluded: true, reason: `本年度已安排 ${otherPlan.className}` };
  }
  const lastYearSame = context.records.filter(r => r.empId === person.empId
    && String(r.planYear) === TRAINED_YEAR
    && classTypeOf(r.className) === type);
  if (lastYearSame.length) {
    return { excluded: true, reason: `${TRAINED_YEAR}年度已参加同类别班次` };
  }
  return null;
}

// 硬规则：生产分管负责人避开春秋检
function ruleProdHeadSeason(person, plan, context) {
  if (person.isProdHead !== '是') {
    return null;
  }
  const start = toDate(plan.startDate);
  const end = toDate(plan.endDate);
  if (overlaps(start, end, SEASON_RANGES, context.year)) {
    return { excluded: true, reason: '生产分管负责人与春秋检时段重叠' };
  }
  return null;
}

// 硬规则：AB 角不得同出（依赖本轮已列入名单的人）
function ruleAbRoleConflict(person, plan, context) {
  const partner = person.bRole;
  if (!partner) {
    return null;
  }
  const selected = context.selectedNames || new Set();
  if (selected.has(partner)) {
    return { excluded: true, reason: `与B角 ${partner} 同批次冲突` };
  }
  return null;
}

// 软规则：近3年未参培优先
function scoreRecentUntrained(person, plan, context) {
  const start = toDate(plan.startDate) || new Date();
  const recent = context.records.filter(r => r.empId === person.empId)
    .map(r => yearsBetween(start, toDate(r.startDate)))
    .filter(v => v !== null);
  if (!recent.length) {
    return { score: 30, reason: '近3年未参培' };
  }
  const min = Math.min(...recent);
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
  const isFifthSession = /第五期/.test(plan.sessionNo || '');
  const isInstructorClass = classTypeOf(plan.className) === '进修班';
  if (isInstructorClass && isFifthSession) {
    return { score: 35, reason: '党支部书记专场安排' };
  }
  return { score: -20, reason: null, note: '党支部书记统一安排第五期专场' };
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

// 规则识别：用户上传的规则编码可能不同，用关键词兜底映射到执行器
const RULE_PATTERNS = [
  { code: 'HARD_AB_ROLE', keywords: ['ab角', 'b角', '同出', '同时参培'], executor: ruleAbRoleConflict },
  { code: 'HARD_REPEAT_TRAIN', keywords: ['重复参培', '同类别', '只安排', '不重复'], executor: ruleRepeatTrain },
  { code: 'HARD_PROD_HEAD_SEASON', keywords: ['春秋检', '生产分管', '离岗'], executor: ruleProdHeadSeason },
  { code: 'HARD_TARGET_LIMIT', keywords: ['退休', '新提任', '参培对象', '对象限制'], executor: ruleTargetLimit },
  { code: 'SOFT_PARTY_SEC_ONLY', keywords: ['党支部书记', '专场', '书记'], executor: scorePartySecretary },
  { code: 'SOFT_RECENT_UNTRAINED', keywords: ['近3年', '近三年', '未参培', '未参加'], executor: scoreRecentUntrained },
  { code: 'SOFT_HOURS_GAP', keywords: ['学时', '缺口', '学时低'], executor: scoreHoursGap },
];

// 解析单条规则：优先按 ruleCode 精确匹配，否则按名称与内容关键词兜底
function resolveExecutor(rule) {
  const code = String(rule.ruleCode || '').trim();
  if (RULE_EXECUTORS[code]) {
    return { code, executor: RULE_EXECUTORS[code], matchedBy: 'code' };
  }
  const text = `${rule.ruleName || ''} ${rule.ruleContent || ''}`.toLowerCase();
  for (const pattern of RULE_PATTERNS) {
    if (pattern.keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
      return { code: pattern.code, executor: pattern.executor, matchedBy: 'keyword',
        customCode: code || null };
    }
  }
  return null;
}

// ---------- 主流程 ----------
async function generateAdvice({ year = '2027', limitPerUnit, outDir, account, credential } = {}) {
  const safeYear = String(year);
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

  const leaders = leadersR.rows;
  const plans = plansR.rows;
  const quotas = quotasR.rows;
  const records = recordsR.rows;
  const rules = rulesR.rows.filter(r => r.enabled !== '0' && r.delFlag !== '2');

  // 规则分派：先按编码识别，识别不了按关键词兜底；仍未识别的只提示不猜
  const hardRules = [];
  const softRules = [];
  const unknownRules = [];
  rules.forEach(rule => {
    const resolved = resolveExecutor(rule);
    if (!resolved) {
      unknownRules.push({ code: rule.ruleCode, name: rule.ruleName });
      return;
    }
    const entry = Object.assign({}, resolved, { name: rule.ruleName, content: rule.ruleContent });
    const isHard = String(rule.ruleType) === '硬规则' || resolved.code.startsWith('HARD_');
    (isHard ? hardRules : softRules).push(entry);
  });

  const usedPlanIds = new Set(quotas.map(q => q.planId));
  const planResults = [];

  for (const plan of plans) {
    const quotaByUnit = {};
    quotas.filter(q => q.planId === plan.planId)
      .forEach(q => { quotaByUnit[q.unitName] = Number(q.quotaCount || 0); });

    const context = { year: safeYear, records, selectedNames: new Set() };
    const candidates = [];
    const excluded = [];

    for (const person of leaders) {
      const hit = { softScore: 0, reasons: [] };
      let blocked = false;
      for (const item of hardRules) {
        const verdict = item.executor(person, plan, context);
        if (verdict && verdict.excluded) {
          excluded.push({ empId: person.empId, empName: person.empName, unitName: person.unitName,
            rule: item.code, ruleName: item.name, reason: verdict.reason });
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }
      for (const item of softRules) {
        const verdict = item.executor(person, plan, context);
        if (verdict) {
          hit.softScore += verdict.score || 0;
          if (verdict.reason) {
            hit.reasons.push(verdict.reason);
          }
        }
      }
      hit.person = person;
      candidates.push(hit);
    }

    // 高分优先；同分按累计学时升序
    candidates.sort((a, b) => b.softScore - a.softScore
      || Number(a.person.totalHours || 0) - Number(b.person.totalHours || 0));

    // 按单位名额取数（AB 角冲突在取数时实时判定）
    const unitUsed = {};
    const suggestions = [];
    for (const item of candidates) {
      const person = item.person;
      const quota = quotaByUnit[person.unitName];
      if (quota === undefined) {
        continue;
      }
      const used = unitUsed[person.unitName] || 0;
      const cap = limitPerUnit ? Math.min(quota || limitPerUnit, limitPerUnit) : quota;
      if (used >= cap) {
        excluded.push({ empId: person.empId, empName: person.empName, unitName: person.unitName,
          rule: 'QUOTA', reason: `本单位名额已满（${cap}）` });
        continue;
      }
      if (hardRules.some(item => item.code === 'HARD_AB_ROLE')) {
        const verdict = ruleAbRoleConflict(person, plan, context);
        if (verdict && verdict.excluded) {
          excluded.push({ empId: person.empId, empName: person.empName, unitName: person.unitName,
            rule: 'HARD_AB_ROLE', reason: verdict.reason });
          continue;
        }
      }
      unitUsed[person.unitName] = used + 1;
      context.selectedNames.add(person.empName);
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

    planResults.push({
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
    });
  }

  const result = {
    ok: true,
    year: safeYear,
    summary: {
      plans: planResults.length,
      total: planResults.reduce((sum, p) => sum + p.suggestions.length, 0),
      excluded: planResults.reduce((sum, p) => sum + p.excluded.length, 0),
      rules: {
        hard: hardRules.map(item => item.code),
        soft: softRules.map(item => item.code),
        matchedByKeyword: hardRules.concat(softRules).filter(item => item.matchedBy === 'keyword').length,
        unknown: unknownRules,
      },
      plansWithoutQuota: plans.filter(p => !usedPlanIds.has(p.planId)).length,
    },
    plans: planResults,
  };

  // 输出 Excel + HTML（占位符模板替换）
  const targetDir = outDir || CFG.outDir || os.tmpdir();
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const jsonPath = path.join(os.tmpdir(), `peixiaoe_advice_${Date.now()}.json`);
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

module.exports = { generateAdvice, RULE_EXECUTORS, classTypeOf };
