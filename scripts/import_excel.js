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
  if (shortName === planName) {
    return true;
  }
  const rules = [
    [/新提任.*正职/, /新提任.*正职/],
    [/新提任.*副职/, /新提任.*副职/],
    [/县班子|县公司领导班子/, /县公司领导班子/],
    [/四级进修|四级领导人员进修/, /四级领导人员进修班/],
  ];
  return rules.some(([short, full]) => short.test(shortName) && full.test(planName));
}

// 期次归一化：1 / 第1期 / 第一期 / 一期 → 「第1期」风格，避免数字与中文写法对不上
const CN_DIGITS = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function normalizeSessionNo(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    return text;
  }
  const match = text.match(/第?\s*([一二两三四五六七八九十\d]+)\s*期?/);
  if (!match) {
    return text;
  }
  const token = match[1];
  if (/^\d+$/.test(token)) {
    return `第${parseInt(token, 10)}期`;
  }
  if (token in CN_DIGITS) {
    return `第${token}期`;
  }
  return text;
}

// 拉取计划表并建立 班次+期次 → planId 索引
async function loadPlanIndex(account, credential) {
  const result = await trainer.queryAll('pxe_training_plan',
    {}, account, credential);
  if (!result.ok) {
    return { ok: false, message: result.message || result.error };
  }
  const plans = result.rows.map(row => ({
    planId: row.planId,
    className: row.className,
    sessionNo: row.sessionNo,
  }));
  return { ok: true, plans };
}

// 按班次与期次查计划编号（期次两端均做归一化，数字/中文写法可互配）
function findPlanId(plans, className, sessionNo) {
  const session = normalizeSessionNo(sessionNo);
  if (!className || !session) {
    return null;
  }
  const exact = plans.find(p => p.className === className && normalizeSessionNo(p.sessionNo) === session);
  if (exact) {
    return exact.planId;
  }
  const fuzzy = plans.find(p => matchClassName(className, p.className) && normalizeSessionNo(p.sessionNo) === session);
  return fuzzy ? fuzzy.planId : null;
}

// 分批写入
async function pushRows(table, rows, account, credential) {
  let affected = 0;
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE);
    const result = await trainer.create({ table, rows: batch, account, credential });
    if (!result.ok) {
      const message = result.message || result.error || '';
      const hint = String(message).includes('培训计划不存在')
        ? '（请在培训计划表中先建立对应的班次与期次，再导入培训记录）'
        : '';
      return { ok: false, message: `第 ${start + 1} 条起写入失败: ${message}${hint}` };
    }
    // 说明：接口返回的 data 受 MySQL UPSERT 影响行数影响（插入=1、更新=2），
    // 不作为实际条数展示，条数一律以 rows.length 为准。
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
    const index = await loadPlanIndex(account, credential);
    if (!index.ok) {
      console.error(`读取培训计划失败: ${index.message}`);
      return 1;
    }
    const resolved = [];
    const missing = new Set();
    rows.forEach(row => {
      // 已显式填了计划编号的，直接采用
      let planId = row.planId;
      if (!planId) {
        planId = findPlanId(index.plans, row.className, row.sessionNo);
      }
      if (!planId) {
        missing.add(`${row.planYear || ''}${row.className || ''}-${row.sessionNo || ''}`);
        return;
      }
      resolved.push({
        planId,
        unitName: row.unitName,
        quotaCount: row.quotaCount,
        remark: row.remark,
      });
    });
    if (missing.size) {
      ui.warn(`以下班次未匹配到培训计划，已跳过：${[...missing].join('、')}`);
      if (!resolved.length) {
        ui.fail('没有任何可入库的名额数据');
        return 1;
      }
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

  // 培训记录：后端会校验所引用的培训计划必须已存在（40000 培训计划不存在），
  // 这里先拉计划索引预检，无对应计划的记录跳过并提示，避免整批写入失败。
  if (targetTable === 'pxe_train_record') {
    const index = await loadPlanIndex(account, credential);
    if (!index.ok) {
      console.error(`读取培训计划失败: ${index.message}`);
      return 1;
    }
    const kept = [];
    const missing = new Set();
    rows.forEach(row => {
      // 显式填了计划编号的，直接放行
      if (row.planId && findPlanId(index.plans, row.className, row.sessionNo)) {
        kept.push(row);
        return;
      }
      if (findPlanId(index.plans, row.className, row.sessionNo)) {
        kept.push(row);
      } else {
        missing.add(`${row.planYear || ''}${row.className || ''}-${row.sessionNo || ''}`);
      }
    });
    if (missing.size) {
      ui.warn(`以下班次在培训计划中不存在，已跳过（请先导入对应培训计划）：${[...missing].join('、')}`);
      if (!kept.length) {
        ui.fail('没有任何可入库的培训记录（缺少对应培训计划，请先导入培训计划）');
        return 1;
      }
    }
    ui.info(`已核对培训计划存在性，有效 ${kept.length} 条`);
    const pushed = await pushRows(targetTable, kept, account, credential);
    if (!pushed.ok) {
      ui.fail(pushed.message);
      return 1;
    }
    ui.title('导入完成');
    ui.ok(`${ui.labelOfTable(targetTable)}：新入库或更新 ${kept.length} 条`);
    logImport(targetTable, kept.length, true);
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
