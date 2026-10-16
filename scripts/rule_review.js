// =====================================================
// rule_review.js —— 培小e 规则审核表：译文 ⇄ Excel 行
//
// 审核表每行一个条件：同一「分支」内同一「或组」的行为「且」，不同或组为「或」。
// 这与译文结构一一对应，用户在 Excel 里改完能无损读回：
//   buildReviewRows  译文 + 试算 → 行
//   parseReviewRows  行 → 每个条款的审核结论与译文（再交 validateEntry 严格校验）
// =====================================================
const dsl = require('./rule_dsl');

const COLUMNS = ['条款编号', '来源', '名称', '适用期次', '原文', '状态', '分支', '动作', '分值', '理由',
  '或组', '字段/指标', '参数', '运算', '值', '中文复述', '试算影响', '标记', '审核结果', '审核人', '意见'];
const DECISIONS = ['确认', '修改', '驳回'];
const DECISION_ALIAS = { 通过: '确认', 同意: '确认', 已确认: '确认', 不通过: '驳回', 退回: '驳回' };
const ALWAYS = '总是';
const UNTRANSLATED = '未识别';
const STATUS_ORDER = { 待审核: 0, 驳回: 1, 已确认: 2 };

function formatValue(leaf) {
  if (leaf.值 === undefined) return '';
  return Array.isArray(leaf.值) ? leaf.值.join('、') : leaf.值;
}

function trialText(action, stat, dynamic) {
  if (!stat) return '';
  if (dynamic) return '取决于本次名单的选人顺序，试算无法预估，出名单时实时判断';
  const verb = action === '准入' ? '不满足而剔除' : (action === '剔除' ? '剔除' : '加分');
  const sample = stat.samples.length ? `；如 ${stat.samples.join('、')}` : '';
  return `${verb} ${stat.hits} 人次（适用 ${stat.total} 人次）${sample}${dynamic ? '；未计本次名单' : ''}`;
}

function warnText(action, stat) {
  if (!stat || action === '加分') return '';
  if (stat.hits === 0) return '⚠ 无人受影响，请核对';
  if (stat.total && stat.hits === stat.total) return '⚠ 全部被剔除，请核对';
  return '';
}

// 译文 + 试算 → 审核表行（resolved 来自 dsl.resolveClauses；trial 来自 ai_advisor.trialRun）
function buildReviewRows(resolved, trial) {
  const ordered = resolved.slice().sort((a, b) => (STATUS_ORDER[a.status] ?? 0) - (STATUS_ORDER[b.status] ?? 0));
  const rows = [];
  for (const item of ordered) {
    const { clause, entry, status } = item;
    const base = {
      条款编号: clause.指纹, 来源: clause.来源, 名称: clause.名称, 适用期次: clause.适用,
      原文: clause.原文, 状态: status,
    };
    const stat = trial.get(clause.指纹) || { total: 0, branches: [] };
    (entry.分支 || []).forEach((branch, b) => {
      const branchStat = stat.branches[b] ? Object.assign({ total: stat.total }, stat.branches[b]) : null;
      const dynamic = branch.当 !== ALWAYS && branch.当.some(group => group.some(leaf => leaf.指标 !== undefined
        && dsl.METRICS[leaf.指标].dynamic(leaf.参数 || {})));
      const head = {
        动作: branch.动作,
        分值: branch.动作 === '加分' ? branch.分 : '',
        理由: branch.理由 || '',
        中文复述: dsl.describeBranch(branch),
        试算影响: trialText(branch.动作, branchStat, dynamic),
        标记: dynamic ? '依赖本次名单' : warnText(branch.动作, branchStat),
      };
      const leaves = branch.当 === ALWAYS ? [[ALWAYS]] : branch.当;
      leaves.forEach((group, g) => group.forEach((leaf, i) => {
        const first = g === 0 && i === 0;
        const cond = leaf === ALWAYS ? { '字段/指标': ALWAYS } : {
          '字段/指标': leaf.字段 || leaf.指标,
          参数: leaf.指标 !== undefined ? dsl.describeParams(leaf.参数) : '',
          运算: leaf.运算,
          值: formatValue(leaf),
        };
        rows.push(Object.assign({}, base, { 分支: b + 1, 或组: leaf === ALWAYS ? '' : g + 1 },
          first ? head : { 动作: branch.动作, 分值: head.分值, 理由: head.理由 }, cond));
      }));
    });
    (entry.未译部分 || []).forEach(part => {
      rows.push(Object.assign({}, base, {
        中文复述: `不执行：「${part.原文}」（${part.原因}）`,
        标记: `🔴${UNTRANSLATED}：确认即同意这部分不作为筛选条件；要执行请填分支与条件`,
      }));
    });
  }
  return rows;
}

// ---------- 读回 ----------
function cell(row, key) {
  const value = row[key];
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : value;
}

function parseParams(metricName, textValue, at, errors) {
  const params = {};
  const raw = String(textValue || '').trim();
  if (!raw) return params;
  raw.split(/[；;]/).map(s => s.trim()).filter(Boolean).forEach(part => {
    const at2 = part.indexOf('=');
    if (at2 < 0) {
      errors.push(`${at} 参数「${part}」应写成 名称=值`);
      return;
    }
    const key = part.slice(0, at2).trim();
    const value = part.slice(at2 + 1).trim();
    if (key === '年数' || key === '年度') params[key] = Number(value);
    else if (key === '区间') params[key] = value.split(/[、,，]/).map(s => s.trim().split(/[~～至]/).map(x => x.trim()));
    else if (key === '时间重叠') params[key] = value === '是' || value === 'true';
    else params[key] = value;
  });
  return params;
}

function parseValue(type, op, raw) {
  if (dsl.NO_VALUE_OPS.includes(op)) return undefined;
  if (dsl.LIST_OPS.includes(op)) return String(raw).split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  if (raw === '') return undefined;
  if (type === '数值') return typeof raw === 'number' ? raw : Number(raw);
  return String(raw);
}

function parseLeaf(row, at, errors) {
  const name = String(cell(row, '字段/指标'));
  if (name === ALWAYS) return ALWAYS;
  const leaf = {};
  if (dsl.FIELDS[name]) leaf.字段 = name;
  else if (dsl.METRICS[name]) {
    leaf.指标 = name;
    const params = parseParams(name, cell(row, '参数'), at, errors);
    if (Object.keys(params).length) leaf.参数 = params;
  } else {
    errors.push(`${at} 字段/指标「${name}」不在目录中（见「字段字典」工作表）`);
    return null;
  }
  leaf.运算 = String(cell(row, '运算'));
  const value = parseValue(dsl.typeOfLeaf(leaf), leaf.运算, cell(row, '值'));
  if (value !== undefined) leaf.值 = value;
  return leaf;
}

// 行 → { decisions: Map(指纹 → {decision, note, entry?, rows}), errors }
function parseReviewRows(rows) {
  const errors = [];
  const byFp = new Map();
  for (const row of rows) {
    const fp = String(cell(row, '条款编号'));
    if (!fp) {
      if (COLUMNS.some(key => cell(row, key) !== '')) errors.push(`第${row._row}行 缺少条款编号（新增条件行请复制本条款的一行再改）`);
      continue;
    }
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(row);
  }
  const decisions = new Map();
  for (const [fp, list] of byFp) {
    const picked = list.map(r => String(cell(r, '审核结果'))).find(Boolean) || '';
    const decision = DECISION_ALIAS[picked] || picked;
    const note = list.map(r => String(cell(r, '意见'))).find(Boolean) || '';
    const reviewer = list.map(r => String(cell(r, '审核人'))).find(Boolean) || '';
    if (!decision) continue;
    if (!reviewer) {
      errors.push(`条款「${cell(list[0], '名称') || fp}」：填了审核结果但没填审核人`);
      continue;
    }
    if (!DECISIONS.includes(decision)) {
      errors.push(`条款「${cell(list[0], '名称') || fp}」：审核结果「${picked}」只能填 ${DECISIONS.join(' / ')}`);
      continue;
    }
    if (decision === '驳回') {
      decisions.set(fp, { decision, note, reviewer });
      continue;
    }
    // 确认 / 修改：以表格当前内容为准重建译文
    const branches = new Map();
    const leftover = [];
    for (const row of list) {
      const at = `第${row._row}行`;
      const branchNo = cell(row, '分支');
      const hasCond = cell(row, '字段/指标') !== '' || cell(row, '运算') !== '' || cell(row, '动作') !== '';
      if (branchNo === '') {
        if (hasCond) {
          errors.push(`${at} 填了条件但没填分支号`);
        } else if (String(cell(row, '标记')).includes(UNTRANSLATED)) {
          const m = String(cell(row, '中文复述')).match(/不执行：「([\s\S]+)」（([\s\S]+)）$/);
          if (m) leftover.push({ 原文: m[1], 原因: m[2] });
          else errors.push(`${at} 未识别行的「中文复述」被改动，无法读回，请恢复原样或删除该行`);
        }
        continue;
      }
      const no = Number(branchNo);
      if (!Number.isInteger(no) || no < 1) {
        errors.push(`${at} 分支号必须是正整数`);
        continue;
      }
      if (!branches.has(no)) branches.set(no, { 动作: '', 分: '', 理由: '', groups: new Map(), always: false });
      const branch = branches.get(no);
      if (!branch.动作 && cell(row, '动作') !== '') {
        branch.动作 = String(cell(row, '动作'));
        branch.分 = cell(row, '分值');
        branch.理由 = String(cell(row, '理由'));
      }
      const leaf = parseLeaf(row, at, errors);
      if (leaf === ALWAYS) {
        branch.always = true;
      } else if (leaf) {
        const groupNo = cell(row, '或组') === '' ? 1 : Number(cell(row, '或组'));
        if (!branch.groups.has(groupNo)) branch.groups.set(groupNo, []);
        branch.groups.get(groupNo).push(leaf);
      }
    }
    const entryBranches = [...branches.keys()].sort((a, b) => a - b).map(no => {
      const b = branches.get(no);
      const out = { 动作: b.动作 };
      out.当 = b.always || !b.groups.size ? ALWAYS
        : [...b.groups.keys()].sort((x, y) => x - y).map(g => b.groups.get(g));
      if (b.动作 === '加分') out.分 = typeof b.分 === 'number' ? b.分 : Number(b.分);
      if (b.理由) out.理由 = b.理由;
      return out;
    });
    const entry = { 指纹: fp, 分支: entryBranches };
    if (leftover.length) entry.未译部分 = leftover;
    decisions.set(fp, { decision, note, reviewer, entry });
  }
  return { decisions, errors };
}

// 字段字典（写进审核表第二个工作表，也作为下拉框来源）
function dictionary() {
  const fields = Object.entries(dsl.FIELDS).map(([name, def]) => [name, '字段', def.type, '']);
  const metricNotes = {
    参培次数: '参数：范围=本年度/上年度/近N年(配 年数=N)/指定年度(配 年度=YYYY)；班次=任意/同班次/同类别/非本班次',
    距上次参培年数: '无参数；从未参培记 99',
    培训期重叠: '参数：区间=03-01~06-30、09-01~11-30；值填 是/否',
    AB角冲突: '参数：时间重叠=是/否；运算用 不为空 表示冲突',
  };
  const metrics = Object.entries(dsl.METRICS).map(([name, def]) => [name, '指标', def.type, metricNotes[name] || '']);
  return {
    items: [[ALWAYS, '无条件', '', '整个分支无条件生效']].concat(fields, metrics),
    ops: Object.entries(dsl.OPS_BY_TYPE).map(([type, ops]) => [type, ops.join(' ')]),
    allOps: dsl.ALL_OPS,
    actions: dsl.ACTIONS,
    decisions: DECISIONS,
  };
}

module.exports = { COLUMNS, DECISIONS, buildReviewRows, parseReviewRows, dictionary };
