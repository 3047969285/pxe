// =====================================================
// ai_advisor.js —— 培小e 培训建议规则引擎（独立模块）
//
// 与数据维护完全解耦：本模块只做"分析 → 产出建议名单"，不写任何业务数据。
// 产出结果（建议名单）可选存库（本地 JSON 归档 / 追加建议台账）。
//
// 规则引擎（自动识别，规则由 Skill 内定，不依赖外部 AI 接口）：
//   R1 计划匹配：读培训计划的 matching_rules/target_group/cadre_level，
//                 从人员表筛出符合条件的人员（层级/角色/是否为生产骨干）
//   R2 已训排除：凡在该班次/期次已有培训记录的人，不进入建议
//   R3 学时补足：已有同类但该年度学时不足的人，标记为"补训"
//   R4 名额约束：按单位名额(pxe_quota_alloc)限制各单位建议上限
//   R5 优先级评分：综合层级匹配度、是否从未参训、在训时长等打分，产出 高/中/低
// =====================================================
const fs = require('fs');
const path = require('path');
const CFG = require('./config');
const api = require('./train_api');
// 简单日期格式化
function _fmtDate(v) {
  const d = v === 'now' ? new Date() : new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`;
}
const DateTime = _fmtDate;

// =========================================
// 1. 从计划中解析匹配条件（R1）
// =========================================
function parsePlanCriteria(plan) {
  const criteria = {
    cadreLevels: new Set(),    // 干部层级
    roles: new Set(),          // 角色
    prodHeadOnly: false,       // 仅生产骨干
    targetText: '',            // 培训对象原文（兜底模糊匹配）
    matchedRules: [],          // 命中的规则说明
    hasAnyRule: false,         // 是否有任何匹配规则（空计划=无法甄别，跳过）
  };

  // matching_rules 是 JSON（服务端序列化保存）
  let rules = null;
  if (plan.matching_rules) {
    if (typeof plan.matching_rules === 'string') {
      try { rules = JSON.parse(plan.matching_rules); } catch { rules = null; }
    } else {
      rules = plan.matching_rules;
    }
  }
  // 兼容 {cadreLevel, role, ...} 顶层结构
  if (!rules && plan.rule_desc) {
    try { rules = JSON.parse(plan.rule_desc); } catch { rules = null; }
  }

  if (rules && typeof rules === 'object') {
    for (const [k, v] of Object.entries(rules)) {
      const key = String(k).toLowerCase();
      if (/cadre.?level|level|层级|干部/.test(key)) {
        for (const it of ensureList(v)) criteria.cadreLevels.add(stripSpace(it));
        criteria.matchedRules.push(`干部层级=${ensureList(v).join('、')}`);
        criteria.hasAnyRule = true;
      } else if (/role|角色|岗位/.test(key)) {
        for (const it of ensureList(v)) criteria.roles.add(stripSpace(it));
        criteria.matchedRules.push(`角色=${ensureList(v).join('、')}`);
        criteria.hasAnyRule = true;
      } else if (/prod|骨干|head/.test(key)) {
        if (truthy(v)) criteria.prodHeadOnly = true;
        criteria.matchedRules.push('仅生产骨干');
        criteria.hasAnyRule = true;
      }
    }
  }

  // target_group 文本兜底
  if (plan.target_group) {
    criteria.targetText = String(plan.target_group);
    extractKeywords(criteria.targetText, criteria);
    // target_group 文本也可以触发规则（含层级/角色关键词）
    if (criteria.cadreLevels.size > 0 || criteria.roles.size > 0 || criteria.prodHeadOnly) {
      criteria.hasAnyRule = true;
    }
    // 纯文本描述也视为有规则（"各供电所所长"等）
    if (criteria.targetText && !criteria.hasAnyRule) {
      criteria.hasAnyRule = true;
      criteria.matchedRules.push('培训对象文本描述');
    }
  }

  return criteria;
}

function ensureList(v) {
  return Array.isArray(v) ? v : [v];
}
function stripSpace(s) {
  return String(s).replace(/\s+/g, '').trim();
}
function truthy(v) {
  return v === true || v === 1 || ['1', '是', 'true', 'Y', 'y'].includes(String(v).trim());
}
function notEmpty(s) {
  return s !== null && s !== undefined && String(s).trim() !== '';
}

// 从培训对象描述文本中提取关键词（"各班站长"→ 站长）
function extractKeywords(text, criteria) {
  const tokens = String(text).replace(/、/g, ' ').replace(/，/g, ' ').replace(/；/g, ' ').split(/\s+/);
  for (const t of tokens) {
    const s = stripSpace(t);
    if (!s) continue;
    // 含"干部/层"的是层级；含"骨干"是生产骨干
    if (/干部|层|级/.test(s)) criteria.cadreLevels.add(s);
    if (/骨干/.test(s)) criteria.prodHeadOnly = true;
    else if (/岗|员|长|师|班/.test(s)) criteria.roles.add(s);
  }
}

// =========================================
// 2. 判断人员是否匹配计划（R1）
// =========================================
function personMatches(plan, criteria, person) {
  // 如果计划无任何匹配规则 → 无法甄别，跳过
  if (!criteria.hasAnyRule) return { matched: false, reasons: [], levelOk: false, roleOk: false, prodOk: false };

  const reasons = [];
  const name = person.emp_name || '';
  const level = stripSpace(person.cadre_level);
  const role = stripSpace(person.b_role);
  const isProd = truthy(person.is_prod_head);

  // 层级匹配（计划指定了层级才参与匹配）
  let levelOk = criteria.cadreLevels.size === 0;
  if (criteria.cadreLevels.size > 0) {
    levelOk = level !== '' && [...criteria.cadreLevels].some(c => level.includes(c) || c.includes(level));
    if (levelOk) reasons.push(`层级匹配(${person.cadre_level})`);
  }

  // 角色匹配
  let roleOk = criteria.roles.size === 0;
  if (!roleOk) {
    roleOk = role !== '' && [...criteria.roles].some(r => role.includes(r) || r.includes(role));
    if (roleOk) reasons.push(`角色匹配(${person.b_role})`);
  }

  // 生产骨干
  let prodOk = true;
  if (criteria.prodHeadOnly) {
    prodOk = isProd;
    if (prodOk) reasons.push('生产骨干');
  }

  // 文本兜底：target_group 含该人岗位/层级关键词
  let textOk = false;
  if (criteria.targetText) {
    textOk = (
      (level && criteria.targetText.includes(level)) ||
      (role && criteria.targetText.includes(role))
    );
    if (textOk) reasons.push('对象文本命中');
  }

  // 至少一类条件匹配即为"疑似应训"；无任何条件的计划不产出建议
  const matched = levelOk || roleOk || prodOk || textOk;
  return { matched, reasons, levelOk, roleOk, prodOk };
}

// =========================================
// 3. 主流程：生成建议（R1-R5）
// =========================================
async function generateAdvice({ account, credential, year, limitPerUnit } = {}) {
  const auth = { account, credential };
  const now = new Date();
  const targetYear = year || now.getFullYear();

  console.log(`\n[培小e] 培训建议规则引擎开始（年度=${targetYear}）...`);

  // 3.1-3.4 并行拉取四张表（分页在 queryAll 内部完成，多表同时进行）
  const results = await Promise.allSettled([
    api.queryAll(CFG.tables.plan, [
      { field: 'plan_year', operator: 'EQ', value: Number(targetYear) },
    ], account, credential),
    api.queryAll(CFG.tables.leader, [], account, credential),
    api.queryAll(CFG.tables.record, [], account, credential),
    api.queryAll(CFG.tables.quota, [], account, credential),
  ]);

  const TABLE_ERR = ['PLANS_FETCH_FAILED', 'PERSONS_FETCH_FAILED', 'RECORDS_FETCH_FAILED', 'QUOTA_FETCH_FAILED'];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value.ok) {
      console.error(`[培小e] 拉取表#${i}失败: ${r.status === 'rejected' ? (r.reason?.message || '') : (r.value.message || r.value.error)}`);
      return { ok: false, error: TABLE_ERR[i] };
    }
  }

  const plans = results[0].value.rows;
  const persons = results[1].value.rows;
  const records = results[2].value.rows;
  const quotas = results[3].value.rows;

  console.log(`[培小e] 年度 ${targetYear} 培训计划 ${plans.length} 个`);
  console.log(`[培小e] 在册人员 ${persons.length} 人`);
  console.log(`[培小e] 培训记录 ${records.length} 条`);
  console.log(`[培小e] 单位名额 ${quotas.length} 条`);

  // 附带原始表数据（供 html_viewer 复用，避免重复查库；不进入归档 JSON）
  const rawTables = { persons, plans, records, quotas };

  // 建索引
  const recordsByPerson = new Map(); // emp_id/emp_name → 记录列表
  for (const r of records) {
    const key = r.emp_id || r.emp_name;
    if (!key) continue;
    if (!recordsByPerson.has(key)) recordsByPerson.set(key, []);
    recordsByPerson.get(key).push(r);
  }

  const quotaByUnitByPlan = new Map(); // plan_id → Map(unit → quota_count)
  for (const q of quotas) {
    const pid = q.plan_id;
    if (!pid) continue;
    if (!quotaByUnitByPlan.has(pid)) quotaByUnitByPlan.set(pid, new Map());
    quotaByUnitByPlan.get(pid).set(q.unit_name, Number(q.quota_count) || 0);
  }

  // 3.5 逐年逐计划比对
  const result = { plans: [], totalSuggest: 0, totalGap: 0, generatedAt: now };
  let adviceSeq = 0;

  for (const plan of plans) {
    const criteria = parsePlanCriteria(plan);

    // 无任何匹配规则的计划：无法自动甄别应训人员，跳过并记录
    if (!criteria.hasAnyRule) {
      console.log(`  - [${plan.class_name || plan.plan_id}] ⚠ 无匹配规则，已跳过（建议人工配置 matching_rules 或 target_group）`);
      continue;
    }

    const planAdvice = [];
    const planQuotaMap = quotaByUnitByPlan.get(plan.plan_id) || new Map();

    let eligibleCount = 0;
    for (const person of persons) {
      if (!person.emp_id && !person.emp_name) continue;
      const m = personMatches(plan, criteria, person);
      if (!m.matched) continue;
      eligibleCount++;

      // R2 已训排除
      const pkey = person.emp_id || person.emp_name;
      const myRecs = recordsByPerson.get(pkey) || [];
      const trained = myRecs.find(r =>
        String(r.plan_id || '') === String(plan.plan_id || '') ||
        (String(r.class_name || '') === String(plan.class_name || '') &&
         String(r.session_no || '') === String(plan.session_no || ''))
      );

      // 已训且学时达标 → 不建议
      if (trained && (Number(trained.hours) || 0) >= 8) continue;

      // R3 学时补足标记
      const totalHours = myRecs.reduce((s, r) => s + (Number(r.hours) || 0), 0);
      const needMakeup = !!trained && (Number(trained.hours) || 0) < 8;

      // R5 优先级打分
      const score = scorePerson(person, m, trained, totalHours);
      const priority = score >= 80 ? '高' : (score >= 50 ? '中' : '低');

      adviceSeq++;
      planAdvice.push({
        adviceId: `ADV-${plan.plan_id}-${adviceSeq}`,
        planId: plan.plan_id,
        planYear: plan.plan_year,
        className: plan.class_name,
        sessionNo: plan.session_no,
        startDate: plan.start_date,
        endDate: plan.end_date,
        trainPlace: plan.train_place,
        empId: person.emp_id,
        empName: person.emp_name || '',
        unitName: person.unit_name || '',
        regionName: person.region_name || '',
        cadreLevel: person.cadre_level || '',
        bRole: person.b_role || '',
        isProdHead: person.is_prod_head || '',
        trainedBefore: !!trained,
        needMakeup,
        totalHours,
        score,
        priority,
        reasons: m.reasons,
      });
    }

    // R4 名额约束：按单位限制建议人数
    let applied = planAdvice;
    if (planQuotaMap.size > 0 && limitPerUnit === undefined) {
      const byUnit = new Map();
      for (const a of planAdvice) {
        if (!byUnit.has(a.unitName)) byUnit.set(a.unitName, []);
        byUnit.get(a.unitName).push(a);
      }
      applied = [];
      for (const [unit, list] of byUnit) {
        const cap = planQuotaMap.get(unit);
        const sorted = [...list].sort((a, b) => b.score - a.score);
        const take = (cap && cap > 0) ? sorted.slice(0, cap) : sorted;
        applied.push(...take);
      }
    }

    // 排序：分数高者优先
    applied.sort((a, b) => b.score - a.score);

    const gap = plan.plan_count ? Number(plan.plan_count) - applied.length : 0;

    result.plans.push({
      planId: plan.plan_id,
      planYear: plan.plan_year,
      className: plan.class_name,
      sessionNo: plan.session_no,
      startDate: plan.start_date,
      endDate: plan.end_date,
      planCount: Number(plan.plan_count) || 0,
      eligibleCount,
      suggestCount: applied.length,
      gap: Math.max(0, gap),
      rules: criteria.matchedRules,
      targetText: criteria.targetText,
      advice: applied,
    });
    result.totalSuggest += applied.length;
    result.totalGap += Math.max(0, gap);

    console.log(`  - [${plan.class_name || plan.plan_id}] 应训匹配 ${eligibleCount} 人 → 建议 ${applied.length} 人 (缺口 ${Math.max(0, gap)})`);
  }

  // 汇总统计
  const stats = summarize(result, records);
  result.stats = stats;

  console.log(`\n[培小e] 分析完成：共 ${result.plans.length} 个计划，建议 ${result.totalSuggest} 人，缺口 ${result.totalGap} 人`);
  console.log(`  📊 按单位建议分布: `);
  for (const [u, n] of Object.entries(stats.byUnit)) {
    console.log(`      ${u || '(未知)'}: ${n} 人`);
  }

  return { ok: true, data: result };
}

// 优先级打分（R5）
function scorePerson(person, match, trained, totalHours) {
  let score = 0;
  if (match.levelOk) score += 35;
  if (match.roleOk) score += 25;
  if (match.prodOk) score += 20;
  if (match.matched && match.reasons.length === 0) score += 10; // 文本命中兜底

  if (!trained) {
    score += 20; // 从未参训，加分
  } else {
    score -= 10; // 已训过减分
  }
  if (totalHours < 40) score += 5; // 年度学时偏少
  return Math.max(10, Math.min(100, score));
}

function summarize(result, records) {
  const byUnit = {};
  const byLevel = {};
  const byClass = {};
  for (const p of result.plans) {
    for (const a of p.advice) {
      const u = a.unitName || '(未知)';
      byUnit[u] = (byUnit[u] || 0) + 1;
      const l = a.cadreLevel || '(未知)';
      byLevel[l] = (byLevel[l] || 0) + 1;
      const c = a.className || '(未知)';
      byClass[c] = (byClass[c] || 0) + 1;
    }
  }
  return {
    totalPlans: result.plans.length,
    totalSuggest: result.totalSuggest,
    totalGap: result.totalGap,
    byUnit: sortByVal(byUnit),
    byLevel: sortByVal(byLevel),
    byClass: sortByVal(byClass),
    totalRecords: records.length,
  };
}

function sortByVal(obj) {
  return Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
}

// =========================================
// 4. 产出建议名单 HTML（走 html_viewer 模板）
// =========================================
async function buildAdviceHtml(result, auth) {
  const htmlViewer = require('./html_viewer');
  const html = await htmlViewer.renderAdvice(result, auth);
  const date = DateTime('now');
  const file = path.join(CFG.outDir, `培训建议_${date}.html`);
  fs.mkdirSync(CFG.outDir, { recursive: true });
  fs.writeFileSync(file, html, 'utf-8');
  return file;
}

// =========================================
// 5. 存库（单独方式）：审计台账 JSON 归档 + 追加 CSV
//    不写业务数据库，仅本地留存决策记录
// =========================================
function persistAdvice(result, filePath) {
  const archiveDir = path.join(CFG.outDir, '_建议归档');
  fs.mkdirSync(archiveDir, { recursive: true });
  const date = DateTime('now');

  // JSON 全量归档（排除 rawTables 原始表数据，避免冗余重复）
  const { rawTables, ...cleanResult } = result;
  const jsonPath = path.join(archiveDir, `建议清单_${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(cleanResult, null, 2), 'utf-8');

  // CSV 追加台账（字段含逗号/引号时自动转义）
  const csvPath = path.join(archiveDir, '建议台账.csv');
  const header = '建议ID,计划ID,培训班,期次,姓名,单位,干部层级,角色,历史已训,建议理由,优先级,评分,时间\n';
  if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header, 'utf-8');
  const lines = [];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  for (const p of result.plans) {
    for (const a of p.advice) {
      lines.push([
        esc(a.adviceId), esc(a.planId), esc(a.className), esc(a.sessionNo), esc(a.empName), esc(a.unitName),
        esc(a.cadreLevel), esc(a.bRole), a.trainedBefore ? '是' : '否',
        esc((a.reasons || []).join(';')), a.priority, a.score, esc(a.empId || ''),
      ].join(','));
    }
  }
  fs.appendFileSync(csvPath, lines.join('\n') + '\n', 'utf-8');

  console.log(`[培小e] 建议已存库（归档）:`);
  console.log(`  📄 JSON: ${jsonPath}`);
  console.log(`  📊 台账: ${csvPath}`);
  return { jsonPath, csvPath };
}

module.exports = {
  generateAdvice,
  parsePlanCriteria,
  personMatches,
  buildAdviceHtml,
  persistAdvice,
};

