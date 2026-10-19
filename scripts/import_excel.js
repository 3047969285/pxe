// =====================================================
// import_excel.js —— Excel 导入固化流程
// 解析（python）→ 校验 → 关联回填 → 分批入库（接口）
// 全流程固定，调用方只需给文件路径与表名
// =====================================================
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const CFG = require('./config');
const trainer = require('./train_api');
const ui = require('./display');

// 追加一条导入记录到操作日志
function logImport(table, count, okFlag) {
  if (!CFG.operationLog) {
    return;
  }
  try {
    fs.mkdirSync(CFG.outDir, { recursive: true });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    fs.appendFileSync(CFG.processDir ? require('path').join(CFG.outDir, '操作日志.txt') : '操作日志.txt',
      `[${stamp}] ${okFlag ? '成功' : '失败'}  导入  ${ui.labelOfTable(table)} ${count} 条
`, 'utf8');
  } catch (err) {
    // 日志失败不影响主流程
  }
}

const PYTHON = CFG.python || 'python';
const PARSER = path.join(__dirname, 'excel_parser.py');
const BATCH_SIZE = 500;

// 调用 Python 解析脚本
function runParser(args) {
  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const output = execFileSync(PYTHON, [PARSER, ...args], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    env,
  });
  return JSON.parse(output);
}

// 班次简称与全称的匹配
function matchClassName(shortName, planName) {
  if (!shortName || !planName) {
    return false;
  }
  const shortText = String(shortName).normalize('NFKC').replace(/\s+/g, '');
  const planText = String(planName).normalize('NFKC').replace(/\s+/g, '');
  if (shortText === planText) {
    return true;
  }
  const rules = [
    [/新提任.*正职/, /新提任.*正职/],
    [/新提任.*副职/, /新提任.*副职/],
    [/县班子|县公司领导班子/, /县公司领导班子/],
    [/四级进修|四级领导人员进修/, /四级领导人员进修班/],
  ];
  return rules.some(([short, full]) => short.test(shortText) && full.test(planText));
}

function normalizeYear(value) {
  const text = String(value == null ? '' : value).normalize('NFKC').trim();
  const match = /^(\d{4})(?:年|年度)?$/.exec(text);
  return match ? match[1] : text;
}

function normalizeSession(value) {
  const text = String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, '');
  const match = /^(?:第)?([零〇一二两三四五六七八九十\d]+)(?:期)?$/.exec(text);
  if (!match) return text;

  const token = match[1];
  let number;
  if (/^\d+$/.test(token)) {
    number = Number(token);
  } else if (token.includes('十')) {
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (token === '十') number = 10;
    else if (token.startsWith('十')) number = 10 + (digits[token.slice(1)] || 0);
    else if (token.endsWith('十')) number = (digits[token[0]] || 0) * 10;
    else if (token.length === 3) number = (digits[token[0]] || 0) * 10 + (digits[token[2]] || 0);
  } else {
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (Object.prototype.hasOwnProperty.call(digits, token)) number = digits[token];
  }
  return Number.isFinite(number) ? `第${number}期` : text;
}

// 拉取年度、班次、期次和主键，供名额导入按三字段唯一定位计划
async function loadPlanIndex(account, credential) {
  const result = await trainer.queryAll('pxe_training_plan',
    {}, account, credential);
  if (!result.ok) {
    return { ok: false, message: result.message || result.error };
  }
  const plans = result.rows.filter(row => String(row.delFlag || '0') !== '2').map(row => ({
    planId: row.planId,
    planYear: normalizeYear(row.planYear),
    className: String(row.className == null ? '' : row.className).trim(),
    sessionNo: normalizeSession(row.sessionNo),
  }));
  return { ok: true, plans };
}

// 仅在 年度+班次+期次 唯一匹配时返回计划编号；错误由调用端整批拒绝。
function findPlanId(plans, row) {
  const planYear = normalizeYear(row.planYear);
  const className = String(row.className == null ? '' : row.className).trim();
  const sessionNo = normalizeSession(row.sessionNo);
  const requested = `${planYear || '年度缺失'} / ${className || '班次缺失'} / ${sessionNo || '期次缺失'}`;
  const missing = [];
  if (!/^\d{4}$/.test(planYear)) missing.push('年度（需为四位年份）');
  if (!className) missing.push('班次');
  if (!sessionNo) missing.push('期次');
  if (missing.length) {
    return { ok: false, message: `${requested}：缺少或无法识别${missing.join('、')}` };
  }

  const rowPlanId = String(row.planId == null ? '' : row.planId).trim();
  if (rowPlanId) {
    const idMatches = plans.filter(p => String(p.planId == null ? '' : p.planId).trim() === rowPlanId);
    if (idMatches.length !== 1) {
      return { ok: false, message: `${requested}：计划编号「${rowPlanId}」${idMatches.length ? '对应多条计划' : '不存在'}` };
    }
    const plan = idMatches[0];
    const planClass = String(plan.className == null ? '' : plan.className).trim();
    if (plan.planYear !== planYear || plan.sessionNo !== sessionNo || !matchClassName(className, planClass)) {
      return { ok: false, message: `${requested}：显式计划编号「${rowPlanId}」与填写的年度、班次或期次不一致` };
    }
    return { ok: true, planId: plan.planId };
  }

  const sameYearAndSession = plans.filter(p => p.planYear === planYear && p.sessionNo === sessionNo);
  const exact = sameYearAndSession.filter(p => String(p.className || '').trim().normalize('NFKC').replace(/\s+/g, '')
    === className.normalize('NFKC').replace(/\s+/g, ''));
  const candidates = exact.length ? exact : sameYearAndSession.filter(p => matchClassName(className, p.className));
  if (!candidates.length) {
    return { ok: false, message: `${requested}：未找到对应培训计划` };
  }
  if (candidates.length > 1) {
    const list = candidates.map(p => `${p.className || '班次未命名'}（${p.planId || '计划编号缺失'}）`).join('、');
    return { ok: false, message: `${requested}：匹配到多条培训计划，请先消除歧义：${list}` };
  }
  if (!candidates[0].planId) {
    return { ok: false, message: `${requested}：培训计划缺少计划编号` };
  }
  return { ok: true, planId: candidates[0].planId };
}

// 分批写入
async function pushRows(table, rows, account, credential) {
  let affected = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const result = await trainer.create({ table, rows: batch, account, credential });
    if (!result.ok) {
      return { ok: false, message: `第 ${start + 1} 条起写入失败: ${result.message || result.error}` };
    }
    affected += Number(result.data) || 0;
  }
  return { ok: true, affected };
}

// 主入口
async function importFile({ file, table, wide, sheet, account, credential }) {
  if (!file || !fs.existsSync(file)) {
    console.error(`文件不存在: ${file}`);
    return 1;
  }

  ui.title('正在导入数据');
  ui.info(`文件：${path.basename(file)}${wide ? '（名额分配交叉表）' : ''}`);
  const args = wide ? [file, '--wide'] : [file, table || '--auto'];
  if (sheet) {
    args.push('--sheet', sheet);
  }
  let parsed;
  try {
    parsed = runParser(args);
  } catch (err) {
    ui.fail(`读取文件失败：${err.message}`);
    return 1;
  }
  if (!parsed.ok) {
    ui.fail(`解析失败：${parsed.error}`);
    return 1;
  }
  const targetTable = parsed.table;
  const rows = parsed.rows || [];
  ui.info(`识别为：${ui.labelOfTable(targetTable)}，共 ${parsed.totalRows} 条数据`);
  if (parsed.warnings) {
    parsed.warnings.slice(0, 3).forEach(w => ui.warn(w));
  }

  // 名额分配：用户只填 年度+班次+期次，这里回填计划编号
  if (targetTable === 'pxe_quota_alloc') {
    if (parsed.warnings && parsed.warnings.length) {
      ui.fail(`名额数据存在必填项缺失，已取消整批导入：${parsed.warnings.slice(0, 8).join('；')}`
        + (parsed.warnings.length > 8 ? `；另有 ${parsed.warnings.length - 8} 条` : ''));
      return 1;
    }
    const index = await loadPlanIndex(account, credential);
    if (!index.ok) {
      console.error(`读取培训计划失败: ${index.message}`);
      return 1;
    }
    const resolved = [];
    const errors = [];
    rows.forEach((row, rowIndex) => {
      const match = findPlanId(index.plans, row);
      if (!match.ok) {
        errors.push(`解析记录第 ${rowIndex + 1} 条：${match.message}`);
        return;
      }
      resolved.push({
        planId: match.planId,
        unitName: row.unitName,
        quotaCount: row.quotaCount,
        remark: row.remark,
      });
    });
    if (errors.length) {
      ui.fail(`培训计划匹配失败，已取消整批导入（${errors.length} 项）：${errors.slice(0, 8).join('；')}`
        + (errors.length > 8 ? `；另有 ${errors.length - 8} 项` : ''));
      return 1;
    }
    ui.info(`已按年度+班次+期次匹配到培训计划，有效 ${resolved.length} 条`);
    const pushed = await pushRows(targetTable, resolved, account, credential);
    if (!pushed.ok) {
      ui.fail(pushed.message);
      return 1;
    }
    ui.title('导入完成');
    ui.ok(`${ui.labelOfTable(targetTable)}：新入库或更新 ${resolved.length} 条`);
    logImport(targetTable, resolved.length, true);
    return 0;
  }

  // 规则表：Excel 常无「规则编码」列，按规则名复用库里已有编码，避免重复入库
  if (targetTable === 'pxe_training_rule') {
    const existing = await trainer.queryAll('pxe_training_rule', {}, account, credential);
    if (existing.ok) {
      const codeByName = {};
      existing.rows.forEach(item => {
        if (item.ruleName) {
          codeByName[item.ruleName] = item.ruleCode;
        }
      });
      rows.forEach(row => {
        if (row.ruleName && codeByName[row.ruleName]) {
          row.ruleCode = codeByName[row.ruleName];
        }
      });
    }
  }

  const pushed = await pushRows(targetTable, rows, account, credential);
  if (!pushed.ok) {
    ui.fail(pushed.message);
    return 1;
  }
  ui.title('导入完成');
  ui.ok(`${ui.labelOfTable(targetTable)}：新入库或更新 ${rows.length} 条`);
  logImport(targetTable, rows.length, true);
  return 0;
}

module.exports = { importFile, runParser, matchClassName, findPlanId };
