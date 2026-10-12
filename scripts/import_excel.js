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

// 按班次与期次查计划编号
function findPlanId(plans, className, sessionNo) {
  const exact = plans.find(p => p.className === className && p.sessionNo === sessionNo);
  if (exact) {
    return exact.planId;
  }
  const fuzzy = plans.find(p => matchClassName(className, p.className) && p.sessionNo === sessionNo);
  return fuzzy ? fuzzy.planId : null;
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
  return 0;
}

module.exports = { importFile, runParser, matchClassName, findPlanId };
