// =====================================================
// workflow.js —— 培小e 出名单流程编排（状态机）+ 运行记录与复现
//
// 「名单」一条命令按当前状态自动推进，每次都从接口取最新数据：
//   有条款待翻译/被驳回 → 写待翻译草稿，提示模型翻译后「规则 登记」
//   有条款待审核       → 自动生成审核表（含试算），提示用户审核后「规则 确认」
//   全部已确认         → 出名单 + 运行记录（数据/规则/代码/结果四个指纹 + 输入快照）
// 「名单 --复现 <运行记录>」用快照重算并核对结果指纹，证明过程可复现。
//
// 审核留痕（防止模型代替用户审核）：
//   审核表由本程序签发（审核单号），确认时必须填审核人，只认签发过且未确认过的审核表；
//   读回时检查文件是否经 Excel/WPS 由人保存、审核用时是否过短，疑点写入审核日志；
//   审核日志逐条哈希串联，改动任何一条都会断链；译文库里「已确认」的条款必须能在日志里
//   找到对应的确认记录且译文哈希一致，否则视为未确认（手改译文库无效）。
// =====================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const CFG = require('./config');
const dsl = require('./rule_dsl');
const advisor = require('./ai_advisor');
const review = require('./rule_review');

const WRITER = path.join(__dirname, 'report_writer.py');
// 影响名单结果的代码；任一改动都会改变代码指纹
const ENGINE_FILES = ['ai_advisor.js', 'rule_dsl.js'];
const LEDGER_FILE = path.join(path.dirname(dsl.LIBRARY_FILE), '审核日志.jsonl');
const ISSUER = '培小e';
// 快照里去掉的字段：敏感或与计算无关
const DROP_FIELDS = new Set(['idCard', 'createTime', 'updateTime', 'trainedRecords']);

// ---------- 工具 ----------
function runWriter(args, input) {
  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const output = execFileSync(CFG.python || 'python', [WRITER, ...args], {
    input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env,
  });
  return JSON.parse(output);
}

// 键排序的 JSON，同样内容必得同样字符串
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

function codeFingerprint() {
  return hash(ENGINE_FILES.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n'));
}

function slim(rows, keyOf) {
  return rows.filter(r => String(r.delFlag || '0') !== '2')
    .map(r => Object.fromEntries(Object.entries(r).filter(([k, v]) => !DROP_FIELDS.has(k) && v != null && v !== '')))
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : (keyOf(a) > keyOf(b) ? 1 : 0)));
}

// ---------- 审核日志（哈希串联，只追加） ----------
function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  return fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sealOf(entry) {
  const body = Object.assign({}, entry);
  delete body.本条哈希;
  return hash(stable(body));
}

function appendLedger(entry) {
  const list = readLedger();
  const sealed = Object.assign({ 序号: list.length + 1, 时间: new Date().toISOString() }, entry,
    { 上一条哈希: list.length ? list[list.length - 1].本条哈希 : 'GENESIS' });
  sealed.本条哈希 = sealOf(sealed);
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  fs.appendFileSync(LEDGER_FILE, `${JSON.stringify(sealed)}\n`, 'utf8');
  return sealed;
}

function verifyLedger(list) {
  let prev = 'GENESIS';
  for (const entry of list) {
    if (entry.上一条哈希 !== prev || sealOf(entry) !== entry.本条哈希) {
      return { ok: false, brokenAt: entry.序号 };
    }
    prev = entry.本条哈希;
  }
  return { ok: true, head: prev };
}

const entryHash = entry => hash(stable(entry || null));

// 每个条款最近一次审核结论（驳回会撤销之前的确认）
function proofsOf(list) {
  const proofs = new Map();
  for (const entry of list) {
    if (entry.动作 !== '确认') continue;
    for (const item of entry.条款 || []) {
      if (item.结论 === '驳回') proofs.delete(item.指纹);
      else {
        proofs.set(item.指纹, { 审核单号: entry.审核单号, 审核人: item.审核人, 时间: entry.时间,
          译文哈希: item.译文哈希, 疑点: entry.疑点 || [] });
      }
    }
  }
  return proofs;
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// ---------- 状态 ----------
// 取最新数据并把本批次条款对上译文库
async function loadState({ year, account, credential }) {
  const data = await advisor.loadAll({ year, account, credential });
  if (!data.ok) return data;
  const library = dsl.loadLibrary();
  const clauses = dsl.collectClauses(data.rules, data.plans, data.year);
  const resolved = dsl.resolveClauses(clauses, library);
  // 已确认必须有审核日志佐证：日志断链、无记录或译文被改过，一律退回待审核
  const ledger = readLedger();
  const chain = verifyLedger(ledger);
  const proofs = chain.ok ? proofsOf(ledger) : new Map();
  for (const r of resolved) {
    if (r.status !== dsl.STATUS.CONFIRMED) continue;
    const proof = proofs.get(r.clause.指纹);
    if (proof && proof.译文哈希 === entryHash(r.entry)) {
      r.proof = proof;
    } else {
      r.status = dsl.STATUS.REVIEW;
      r.unproven = chain.ok ? '标为已确认但审核日志里没有对应记录或译文被改动' : `审核日志第 ${chain.brokenAt} 条被改动`;
    }
  }
  const count = status => resolved.filter(r => r.status === status && !r.errors.length).length;
  return {
    ok: true,
    year: data.year,
    data,
    library,
    clauses,
    resolved,
    byFp: new Map(resolved.map(r => [r.clause.指纹, r])),
    todo: resolved.filter(r => r.status === dsl.STATUS.TODO || r.status === dsl.STATUS.REJECTED || r.errors.length),
    pending: resolved.filter(r => r.status === dsl.STATUS.REVIEW && !r.errors.length),
    counts: { 已确认: count('已确认'), 待审核: count('待审核'), 驳回: count('驳回'), 待翻译: count('待翻译') },
    chain,
    ledger,
  };
}

function writeDraft(todo) {
  fs.mkdirSync(path.dirname(dsl.DRAFT_FILE), { recursive: true });
  fs.writeFileSync(dsl.DRAFT_FILE, `${JSON.stringify(dsl.draftFor(todo), null, 2)}\n`, 'utf8');
  return dsl.DRAFT_FILE;
}

// ---------- 登记：草稿 → 待审核 ----------
function register(state, file, overwrite) {
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`读不了译文文件 ${file}：${err.message}`] };
  }
  const entries = Array.isArray(draft) ? draft : (draft.条款 || []);
  const errors = entries.length ? [] : ['文件里没有任何译文'];
  const accepted = {};
  entries.forEach((entry, i) => {
    const item = entry && state.byFp.get(entry.指纹);
    const at = `第${i + 1}条${item ? `「${item.clause.名称}」` : ''}`;
    if (!item) {
      errors.push(`${at} 指纹「${entry && entry.指纹}」不属于 ${state.year} 年度当前条款，先运行「名单 --年度 ${state.year}」`);
    } else if (item.status === dsl.STATUS.CONFIRMED && !overwrite) {
      errors.push(`${at} 已经人工确认；确需重译请加 --覆盖（会退回待审核）`);
    } else if (accepted[entry.指纹]) {
      errors.push(`${at} 在文件中重复出现`);
    } else {
      const problems = dsl.validateEntry(entry, item.clause, at);
      if (problems.length) errors.push(...problems);
      else {
        accepted[entry.指纹] = { 来源: item.clause.来源, 名称: item.clause.名称, 原文: item.clause.原文,
          状态: dsl.STATUS.REVIEW, 译文: dsl.cleanEntry(entry) };
      }
    }
  });
  const categories = Array.isArray(draft) ? undefined : draft.班次类别;
  if (categories !== undefined) errors.push(...dsl.validateCategories(categories));
  if (errors.length) return { ok: false, errors };
  const saved = dsl.saveLibrary(accepted, categories);
  if (path.resolve(file) === path.resolve(dsl.DRAFT_FILE)) fs.unlinkSync(file);
  return { ok: true, count: Object.keys(accepted).length, file: saved };
}

// ---------- 审核表：译文 + 试算 → Excel ----------
function newSheetId() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `SH${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`
    + `${pad(d.getSeconds())}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function makeReviewSheet(state, target) {
  const compiled = advisor.compileClauses(state.resolved, false);
  const { data } = state;
  const trial = advisor.trialRun({
    year: state.year, leaders: data.leaders, plans: data.plans, quotas: data.quotas, records: data.records,
    compiled, classify: dsl.buildClassifier(state.library.班次类别),
  });
  const sheetId = newSheetId();
  const payload = {
    year: state.year,
    sheetId,
    columns: review.COLUMNS,
    rows: review.buildReviewRows(state.resolved, trial),
    dictionary: review.dictionary(),
    overview: Object.assign({ 条款总数: state.resolved.length }, state.counts),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  runWriter(['--review', '-', target], JSON.stringify(payload));
  appendLedger({ 动作: '出审核表', 审核单号: sheetId, 年度: state.year, 文件: path.basename(target),
    文件哈希: fileHash(target), 条款: state.resolved.filter(r => r.status !== dsl.STATUS.CONFIRMED).map(r => r.clause.指纹) });
  return target;
}

// 审核表疑点：判断是否经 Excel/WPS 由人保存、用时是否合理
function suspicionsOf(meta, issued) {
  const flags = [];
  const app = String(meta.application || '');
  if (/openpyxl|xlsxwriter|python|node|exceljs|sheetjs/i.test(app) || !/excel|wps|kingsoft|numbers/i.test(app)) {
    flags.push(`非 Excel/WPS 保存（保存程序：${app || '未知'}）`);
  }
  if (!meta.lastModifiedBy || meta.lastModifiedBy === ISSUER) {
    flags.push('最后保存人未变化，疑似程序改写');
  }
  const seconds = Math.round((Date.now() - Date.parse(issued.时间)) / 1000);
  const min = (CFG.review && CFG.review.minReviewSeconds) || 0;
  if (seconds < min) flags.push(`审核用时 ${seconds} 秒，少于 ${min} 秒`);
  return { flags, seconds };
}

// ---------- 确认：审核表 → 已确认 / 驳回 ----------
//   terminalReviewer：requireTerminal 时由用户在终端输入的审核人姓名
function confirmReview(state, file, { terminalReviewer } = {}) {
  let read;
  try {
    read = runWriter(['--read-review', file]);
  } catch (err) {
    return { ok: false, errors: [`读取审核表失败：${err.message}`] };
  }
  const { rows, meta } = read;
  const issued = state.ledger.find(e => e.动作 === '出审核表' && e.审核单号 === meta.sheetId);
  if (!state.chain.ok) return { ok: false, errors: [`审核日志第 ${state.chain.brokenAt} 条被改动，请联系维护人员核查`] };
  if (!issued) return { ok: false, errors: ['不是本系统签发的审核表（审核单号无效），请用「名单」生成的审核表'] };
  if (state.ledger.some(e => e.动作 === '确认' && e.审核单号 === meta.sheetId)) {
    return { ok: false, errors: [`审核单 ${meta.sheetId} 已经确认过，请重新运行「名单」生成新的审核表`] };
  }
  const { decisions, errors } = review.parseReviewRows(rows);
  const allowed = (CFG.review && CFG.review.reviewers) || [];
  for (const reviewer of new Set([...decisions.values()].map(r => r.reviewer))) {
    if (allowed.length && !allowed.includes(reviewer)) {
      errors.push(`审核人「${reviewer}」不在允许名单（config.js review.reviewers）中`);
    }
    if (terminalReviewer && reviewer !== terminalReviewer) {
      errors.push(`审核表里的审核人「${reviewer}」与终端输入的「${terminalReviewer}」不一致`);
    }
  }
  const { flags, seconds } = suspicionsOf(meta, issued);
  if (flags.length && CFG.review && CFG.review.blockSuspicious) {
    errors.push(...flags.map(f => `审核表存在疑点：${f}`));
  }
  const changes = {};
  const logged = [];
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let confirmed = 0;
  let rejected = 0;
  for (const [fp, result] of decisions) {
    const item = state.byFp.get(fp);
    if (!item) {
      errors.push(`条款 ${fp} 不属于 ${state.year} 年度当前条款（原文可能已修改），请重新生成审核表`);
      continue;
    }
    const record = { 来源: item.clause.来源, 名称: item.clause.名称, 原文: item.clause.原文, 审核时间: now,
      审核人: result.reviewer, 审核单号: meta.sheetId };
    if (result.note) record.意见 = result.note;
    if (flags.length) record.疑点 = flags;
    if (result.decision === '驳回') {
      changes[fp] = Object.assign(record, { 状态: dsl.STATUS.REJECTED, 译文: item.entry });
      logged.push({ 指纹: fp, 名称: item.clause.名称, 结论: '驳回', 审核人: result.reviewer, 意见: result.note || undefined });
      rejected++;
      continue;
    }
    if (item.entry && item.entry.依据) result.entry.依据 = item.entry.依据;
    const problems = dsl.validateEntry(result.entry, item.clause, `「${item.clause.名称}」`);
    if (problems.length) {
      errors.push(...problems);
      continue;
    }
    const entry = dsl.cleanEntry(result.entry);
    changes[fp] = Object.assign(record, { 状态: dsl.STATUS.CONFIRMED, 译文: entry });
    logged.push({ 指纹: fp, 名称: item.clause.名称, 结论: result.decision, 审核人: result.reviewer,
      译文哈希: entryHash(entry), 意见: result.note || undefined });
    confirmed++;
  }
  if (!errors.length && !decisions.size) errors.push('审核表里没有填写任何审核结果');
  if (errors.length) return { ok: false, errors };
  dsl.saveLibrary(changes);
  appendLedger({ 动作: '确认', 审核单号: meta.sheetId, 年度: state.year, 文件: path.basename(file), 文件哈希: meta.sha256,
    保存程序: meta.application, 最后保存人: meta.lastModifiedBy, 用时秒: seconds,
    终端确认: terminalReviewer ? '是' : '否', 疑点: flags, 条款: logged });
  return { ok: true, confirmed, rejected, flags };
}

// ---------- 审计：日志完整性 + 每个已确认条款的审核来源 ----------
function audit(state) {
  return {
    chain: state.chain,
    entries: state.ledger.filter(e => e.动作 === '确认'),
    confirmed: state.resolved.filter(r => r.proof).map(r => ({ 名称: r.clause.名称, ...r.proof })),
    unproven: state.resolved.filter(r => r.unproven).map(r => ({ 名称: r.clause.名称, 原因: r.unproven })),
  };
}

// ---------- 快照：一次运行的全部输入 ----------
function buildSnapshot(state, limitPerUnit) {
  const { data } = state;
  const planIds = new Set(data.plans.map(p => String(p.planId)));
  return {
    年度: state.year,
    每单位上限: limitPerUnit || null,
    班次类别: state.library.班次类别,
    条款: state.resolved.map(r => ({
      指纹: r.clause.指纹, 来源: r.clause.来源, 名称: r.clause.名称, 原文: r.clause.原文,
      planIds: r.clause.planIds || null, ruleType: r.clause.ruleType || null,
      审核时间: r.proof ? r.proof.时间 : null, 审核人: r.proof ? r.proof.审核人 : null,
      审核单号: r.proof ? r.proof.审核单号 : null, 疑点: r.proof && r.proof.疑点.length ? r.proof.疑点 : undefined,
      译文: r.entry,
    })),
    人员: slim(data.leaders, r => String(r.empId)),
    计划: slim(data.plans, r => `${r.planYear}|${r.className}|${r.sessionNo}|${r.planId}`),
    名额: slim(data.quotas.filter(q => planIds.has(String(q.planId))), r => `${r.planId}|${r.unitName}`),
    记录: slim(data.records, r => `${r.empId}|${r.planYear}|${r.className}|${r.sessionNo}|${r.startDate}`),
  };
}

// 生成与复现共用同一条计算路径：快照 → 名单
function computeFromSnapshot(snap) {
  const compiled = snap.条款.map(c => Object.assign(dsl.compileEntry(c.译文, c), {
    planIds: c.来源 === dsl.SOURCE_GENERAL ? null : new Set(c.planIds),
    skipped: c.译文.未译部分 || [],
  }));
  const engine = advisor.runEngine({
    year: snap.年度, leaders: snap.人员, plans: snap.计划, quotas: snap.名额, records: snap.记录,
    compiled, classify: dsl.buildClassifier(snap.班次类别), limitPerUnit: snap.每单位上限 || undefined,
  });
  return { engine, compiled };
}

// ---------- 出名单 ----------
function produceList(state, { limitPerUnit, outDir }) {
  const snap = buildSnapshot(state, limitPerUnit);
  const { engine, compiled } = computeFromSnapshot(snap);
  const fingerprints = {
    数据指纹: hash(stable({ 人员: snap.人员, 计划: snap.计划, 名额: snap.名额, 记录: snap.记录 })),
    规则指纹: hash(stable({ 条款: snap.条款.map(c => [c.指纹, c.译文]), 班次类别: snap.班次类别, 每单位上限: snap.每单位上限 })),
    代码指纹: codeFingerprint(),
    结果指纹: hash(stable(engine.plans)),
  };
  const result = {
    ok: true,
    year: state.year,
    fingerprints,
    summary: {
      plans: engine.plans.length,
      total: engine.plans.reduce((sum, p) => sum + p.suggestions.length, 0),
      excluded: engine.plans.reduce((sum, p) => sum + p.excluded.length, 0),
      rules: {
        hard: compiled.filter(c => c.hasStaticGates || c.hasDynamicGates).map(c => c.name),
        soft: compiled.filter(c => c.hasScores).map(c => c.name),
        skipped: compiled.flatMap(c => c.skipped.map(s => ({ name: c.name, note: `「${s.原文}」${s.原因}` }))),
        hits: engine.ruleHits,
        unknown: [],
      },
      plansWithoutQuota: engine.plansWithoutQuota,
    },
    plans: engine.plans,
  };
  fs.mkdirSync(outDir, { recursive: true });
  result.files = runWriter(['--advice', '-', outDir], JSON.stringify(result)).files || [];
  const recordFile = path.join(outDir, `运行记录_${state.year}.json.gz`);
  const bySheet = new Map();
  snap.条款.filter(c => c.疑点).forEach(c => {
    if (!bySheet.has(c.审核单号)) bySheet.set(c.审核单号, { 审核人: new Set(), 条数: 0, 疑点: c.疑点 });
    const item = bySheet.get(c.审核单号);
    item.审核人.add(c.审核人);
    item.条数++;
  });
  result.reviewWarnings = [...bySheet].map(([id, v]) =>
    `审核单 ${id}（审核人 ${[...v.审核人].join('、')}，${v.条数} 条）：${v.疑点.join('；')}`);
  const record = Object.assign({ 生成时间: new Date().toISOString(), 审核日志哈希: state.chain.head, 汇总: {
    期次: result.summary.plans, 建议人次: result.summary.total, 剔除人次: result.summary.excluded } },
  fingerprints, { 快照: snap });
  fs.writeFileSync(recordFile, zlib.gzipSync(JSON.stringify(record)));
  result.files.push(recordFile);
  return result;
}

// ---------- 复现：用运行记录里的快照重算并核对 ----------
function reproduce(file) {
  const record = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const { engine } = computeFromSnapshot(record.快照);
  const actual = hash(stable(engine.plans));
  return {
    ok: actual === record.结果指纹,
    expected: record.结果指纹,
    actual,
    codeChanged: codeFingerprint() !== record.代码指纹,
    record,
  };
}

module.exports = { loadState, writeDraft, register, makeReviewSheet, confirmReview, audit, produceList, reproduce };
