// =====================================================
// html_viewer.js —— 培小e 统计看板生成
//
// 流程固定：查询五张表 → 聚合指标 → 交给 report_writer.py 套模板生成 HTML
// 页面模板与样式在 report_writer.py 里固化，这里只负责数据
// =====================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const CFG = require('./config');
const trainer = require('./train_api');

const PYTHON = CFG.python || 'python';
const WRITER = path.join(__dirname, 'report_writer.py');

// Map 转按值降序的数组
function topEntries(counter, limit) {
  const entries = Object.keys(counter).map(key => [key, counter[key]]);
  entries.sort((a, b) => b[1] - a[1]);
  return limit ? entries.slice(0, limit) : entries;
}

// 生成统计看板
async function buildDashboard({ year = '2027', target, account, credential } = {}) {
  const safeYear = String(year);
  const [leadersR, plansR, quotasR, recordsR, rulesR] = await Promise.all([
    trainer.queryAll('pxe_leader_info', {}, account, credential),
    trainer.queryAll('pxe_training_plan', {}, account, credential),
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
  const yearPlans = plansR.rows.filter(plan => String(plan.planYear) === safeYear);

  const unitCounter = {};
  const levelCounter = {};
  leaders.forEach(person => {
    const unit = person.unitName || '未填';
    unitCounter[unit] = (unitCounter[unit] || 0) + 1;
    const level = person.cadreLevel || '未填';
    levelCounter[level] = (levelCounter[level] || 0) + 1;
  });

  const recordCounter = {};
  recordsR.rows.forEach(record => {
    const unit = record.unitAtTime || '未填';
    recordCounter[unit] = (recordCounter[unit] || 0) + 1;
  });

  const planCounts = yearPlans.map(plan => [
    `${String(plan.className || '').slice(0, 8)} ${plan.sessionNo || ''}`,
    Number(plan.planCount || 0),
  ]);

  const planTotal = yearPlans.reduce((sum, plan) => sum + Number(plan.planCount || 0), 0);

  const payload = {
    year: safeYear,
    summary: {
      leaders: leaders.length,
      plans: yearPlans.length,
      planCount: planTotal,
      records: recordsR.rows.length,
      quotas: quotasR.rows.length,
      rules: rulesR.rows.length,
    },
    units: topEntries(unitCounter),
    unitRecords: topEntries(recordCounter),
    planCounts,
    levels: topEntries(levelCounter),
  };

  const targetPath = target || path.join(CFG.outDir, `培小e看板_${safeYear}.html`);
  const jsonPath = path.join(CFG.processDir || os.tmpdir(), `peixiaoe_dashboard_${Date.now()}.json`);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
    const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    const output = execFileSync(PYTHON, [WRITER, '--dashboard', jsonPath, targetPath], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env,
    });
    const written = JSON.parse(output);
    if (!written.ok) {
      return { ok: false, message: written.error };
    }
    return { ok: true, file: targetPath, summary: payload.summary };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }
  }
}

module.exports = { buildDashboard };
