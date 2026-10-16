// =====================================================
// ai_advisor.js —— 培小e 应训未训建议规则引擎（纯计算）
//
// 只读分析，不写业务数据，不读库里的任何“建议名单”。
//   runEngine  逐期次：准入/剔除 → 加分 → 固定排序 → 按单位名额取数
//   trialRun   审核表用：每个分支单独作用时的影响人次
// 计划条款只对所在期次生效；通用规则对本年度全部期次生效。
// 确定性：期次、人员、条款、并列名次全部按固定键排序，输入顺序不影响结果。
// 流程编排、写文件、运行记录见 workflow.js
// =====================================================
const trainer = require('./train_api');
const dsl = require('./rule_dsl');

// 评分换算（固定，不由规则决定）
const BASE_SCORE = 50;
const HIGH_LINE = 40;
const MID_LINE = 15;
const SAMPLE_NAMES = 3;

const alive = row => String(row.delFlag || '0') !== '2';
const text = value => (value == null ? '' : String(value).trim());
const byText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

// ---------- 原始行 → 视图（只算一次） ----------
function personView(row) {
  const hireDate = dsl.toDateText(row.hireDate);
  return {
    raw: row,
    empId: text(row.empId),
    empName: text(row.empName),
    unitName: text(row.unitName),
    regionName: text(row.regionName),
    gender: text(row.gender),
    age: dsl.toNumber(row.age),
    cadreLevel: text(row.cadreLevel),
    staffGrade: text(row.staffGrade),
    isPartySec: dsl.yesNo(row.isPartySec),
    isProdHead: dsl.yesNo(row.isProdHead),
    totalHours: dsl.toNumber(row.totalHours) || 0,
    bRole: text(row.bRole),
    hireDate,
    hireYear: hireDate ? Number(hireDate.slice(0, 4)) : null,
    hireMs: dsl.toMs(hireDate),
    assistDate: dsl.toDateText(row.assistDate),
    remark: text(row.remark),
  };
}

function planView(row, classify) {
  const startDate = dsl.toDateText(row.startDate);
  const endDate = dsl.toDateText(row.endDate);
  const startMs = dsl.toMs(startDate);
  const endMs = dsl.toMs(endDate);
  return {
    raw: row,
    planId: text(row.planId),
    className: text(row.className),
    sessionNo: text(row.sessionNo),
    category: classify(row.className),
    targetGroup: text(row.targetGroup),
    trainPlace: text(row.trainPlace),
    year: dsl.toNumber(row.planYear),
    startDate,
    endDate,
    startMs,
    endMs,
    days: startMs != null && endMs != null ? Math.round((endMs - startMs) / 86400000) + 1 : null,
  };
}

function recordView(row, classify) {
  const startDate = dsl.toDateText(row.startDate);
  const year = dsl.toNumber(row.planYear) || (startDate ? Number(startDate.slice(0, 4)) : null);
  // 没有开始日期时按年中近似，避免“有记录却算从未参培”
  const startMs = dsl.toMs(startDate) ?? (year ? dsl.toMs(`${year}-07-01`) : null);
  return { year, className: text(row.className), category: classify(row.className), startMs };
}

function groupBy(list, keyOf) {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

// ---------- 本轮已选名单（跨期次共享，供“本年度只排一次”“AB角”等动态条件使用） ----------
function createState() {
  const byEmp = new Map();
  const byName = new Map();
  const byBRole = new Map();
  const push = (map, key, value) => {
    if (!key) return;
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
  };
  const overlap = (a, b) => a === b || (a.startMs != null && a.endMs != null && b.startMs != null
    && b.endMs != null && a.startMs <= b.endMs && b.startMs <= a.endMs);
  return {
    selectedOf: empId => byEmp.get(empId) || [],
    add(person, plan) {
      const item = { person, plan, year: plan.year, className: plan.className, category: plan.category };
      push(byEmp, person.empId, item);
      push(byName, person.empName, item);
      push(byBRole, person.bRole, item);
    },
    findPartner(person, plan, needOverlap) {
      const candidates = (byName.get(person.bRole) || []).concat(byBRole.get(person.empName) || []);
      for (const item of candidates) {
        if (item.person.empId !== person.empId && (!needOverlap || overlap(item.plan, plan))) {
          return item.person;
        }
      }
      return null;
    },
  };
}

// ---------- 数据准备：引擎与试算共用 ----------
function prepare({ year, leaders, plans, quotas, records, classify }) {
  const targetYear = Number(year);
  const people = leaders.filter(alive).map(personView).filter(p => p.empId)
    .sort((a, b) => byText(a.empId, b.empId));
  const peopleByUnit = groupBy(people, p => p.unitName);
  const recordsByEmp = groupBy(records.filter(alive), r => text(r.empId));
  const recordCache = new Map();
  const recordsOf = empId => {
    let list = recordCache.get(empId);
    if (!list) {
      list = (recordsByEmp.get(empId) || []).map(r => recordView(r, classify));
      recordCache.set(empId, list);
    }
    return list;
  };
  const planList = plans.filter(alive).filter(p => dsl.toNumber(p.planYear) === targetYear)
    .sort(dsl.planOrder).map(row => planView(row, classify));
  const quotaByPlan = new Map();
  for (const q of quotas.filter(alive)) {
    const planId = text(q.planId);
    if (!quotaByPlan.has(planId)) quotaByPlan.set(planId, new Map());
    const unitMap = quotaByPlan.get(planId);
    unitMap.set(text(q.unitName), (unitMap.get(text(q.unitName)) || 0) + (dsl.toNumber(q.quotaCount) || 0));
  }
  // 本期可评估的人：本期有名额单位的人员（无名额单位的人不可能入选）
  const candidatesOf = plan => {
    const quotaMap = quotaByPlan.get(plan.planId) || new Map();
    const units = [...quotaMap.keys()].sort(byText);
    return { quotaMap, units, people: units.flatMap(unit => peopleByUnit.get(unit) || []) };
  };
  return { planList, quotaByPlan, recordsOf, candidatesOf };
}

// 每期适用的已编译条款：计划条款（本期）在前，通用规则在后
function clausesForPlan(compiled, plan) {
  return compiled.filter(item => !item.planIds || item.planIds.has(plan.planId));
}

// ---------- 纯计算：同样输入必得同样输出 ----------
function runEngine({ year, leaders, plans, quotas, records, compiled, classify, limitPerUnit }) {
  const data = prepare({ year, leaders, plans, quotas, records, classify });
  const hitCount = new Map(compiled.map(item => [item.fp, 0]));
  const bump = fp => hitCount.set(fp, hitCount.get(fp) + 1);
  const state = createState();
  const planResults = [];
  const exclude = (bucket, person, rule, ruleName, reason) => bucket.push({
    empId: person.empId, empName: person.empName, unitName: person.unitName, rule, ruleName, reason,
  });
  // 依次过闸门，返回第一个剔除的条款与理由
  const firstBlock = (list, ctx, dynamic) => {
    for (const item of list) {
      const reason = item.gate(ctx, dynamic);
      if (reason) return { item, reason };
    }
    return null;
  };

  for (const plan of data.planList) {
    const applied = clausesForPlan(compiled, plan);
    const staticGates = applied.filter(item => item.hasStaticGates);
    const dynamicGates = applied.filter(item => item.hasDynamicGates);
    const scorers = applied.filter(item => item.hasScores);
    const { quotaMap, units, people } = data.candidatesOf(plan);
    const candidates = [];
    const excluded = [];

    for (const person of people) {
      const ctx = { person, plan, records: data.recordsOf(person.empId), state };
      const blocked = firstBlock(staticGates, ctx, false);
      if (blocked) {
        bump(blocked.item.fp);
        exclude(excluded, person, blocked.item.fp, blocked.item.name, blocked.reason);
        continue;
      }
      let score = 0;
      const reasons = [];
      for (const item of scorers) {
        const verdict = item.score(ctx);
        if (verdict) {
          score += verdict.score;
          bump(item.fp);
          if (verdict.reason) reasons.push(verdict.reason);
        }
      }
      candidates.push({ person, ctx, score, reasons });
    }

    // 固定排序：得分降序 → 累计学时升序 → 员工编号升序
    candidates.sort((a, b) => b.score - a.score
      || a.person.totalHours - b.person.totalHours || byText(a.person.empId, b.person.empId));

    const unitUsed = {};
    const suggestions = [];
    for (const item of candidates) {
      const { person } = item;
      const quota = quotaMap.get(person.unitName);
      const cap = limitPerUnit ? Math.min(quota, limitPerUnit) : quota;
      const used = unitUsed[person.unitName] || 0;
      if (used >= cap) {
        exclude(excluded, person, 'QUOTA', '名额限制', `本单位名额已满（${cap}），顺延`);
        continue;
      }
      const blocked = firstBlock(dynamicGates, item.ctx, true);
      if (blocked) {
        bump(blocked.item.fp);
        exclude(excluded, person, blocked.item.fp, blocked.item.name, blocked.reason);
        continue;
      }
      unitUsed[person.unitName] = used + 1;
      state.add(person, plan);
      suggestions.push({
        empId: person.empId,
        empName: person.empName,
        unitName: person.unitName,
        cadreLevel: person.cadreLevel,
        isPartySec: person.isPartySec,
        isProdHead: person.isProdHead,
        totalHours: person.totalHours,
        score: Math.max(10, Math.min(100, BASE_SCORE + item.score)),
        priority: item.score >= HIGH_LINE ? '高' : (item.score >= MID_LINE ? '中' : '低'),
        reasons: item.reasons,
      });
    }

    const raw = plan.raw;
    planResults.push({
      planId: plan.planId,
      className: plan.className,
      sessionNo: plan.sessionNo,
      classType: plan.category,
      startDate: raw.startDate,
      endDate: raw.endDate,
      timeText: `${raw.startDate || ''} 至 ${raw.endDate || ''}`,
      place: raw.trainPlace,
      planCount: raw.planCount,
      targetGroup: raw.targetGroup,
      ruleDesc: raw.ruleDesc,
      ruleKey: raw.ruleKey,
      quotaUsed: unitUsed,
      quota: Object.fromEntries(units.map(u => [u, quotaMap.get(u)])),
      suggestions,
      excluded,
    });
  }

  return {
    plans: planResults,
    plansWithoutQuota: data.planList.filter(p => !data.quotaByPlan.has(p.planId)).length,
    ruleHits: compiled.map(item => ({
      指纹: item.fp, 名称: item.name, 来源: item.source, 命中: hitCount.get(item.fp),
    })),
  };
}

// ---------- 试算：每个分支单独作用于适用期次，统计影响人次与样例 ----------
// 依赖本次名单的条件（本年度参培次数、AB角冲突）按“尚未选人”计算，审核表里会注明
function trialRun({ year, leaders, plans, quotas, records, compiled, classify }) {
  const data = prepare({ year, leaders, plans, quotas, records, classify });
  const state = createState();
  const result = new Map();
  for (const item of compiled) {
    result.set(item.fp, { total: 0, branches: item.branchCount ? Array.from({ length: item.branchCount },
      () => ({ hits: 0, samples: [] })) : [] });
  }
  for (const plan of data.planList) {
    const applied = clausesForPlan(compiled, plan);
    if (!applied.length) continue;
    const { people } = data.candidatesOf(plan);
    for (const person of people) {
      const ctx = { person, plan, records: data.recordsOf(person.empId), state };
      for (const item of applied) {
        const stat = result.get(item.fp);
        stat.total++;
        item.effects(ctx).forEach((hit, i) => {
          if (!hit) return;
          const branch = stat.branches[i];
          branch.hits++;
          if (branch.samples.length < SAMPLE_NAMES) branch.samples.push(`${person.empName}(${person.unitName})`);
        });
      }
    }
  }
  return result;
}

// ---------- 读数与条款编译（命令共用） ----------
async function loadAll({ year, account, credential }) {
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
  return {
    ok: true,
    year: safeYear,
    leaders: leadersR.rows,
    plans: plansR.rows,
    quotas: quotasR.rows,
    records: recordsR.rows,
    rules: rulesR.rows,
  };
}

// 把有译文且合格的条款编译成可执行对象（onlyConfirmed=true 时只收已确认的）
function compileClauses(resolved, onlyConfirmed) {
  return resolved
    .filter(r => r.entry && !r.errors.length && (!onlyConfirmed || r.status === dsl.STATUS.CONFIRMED))
    .map(r => Object.assign(dsl.compileEntry(r.entry, r.clause), {
      planIds: r.clause.来源 === dsl.SOURCE_GENERAL ? null : new Set(r.clause.planIds),
      branchCount: (r.entry.分支 || []).length,
      skipped: r.entry.未译部分 || [],
    }));
}

module.exports = { runEngine, trialRun, loadAll, compileClauses };
