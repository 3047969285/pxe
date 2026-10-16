// =====================================================
// data_viewer.js —— 培小e 全量数据 HTML 展示
// 展示五张表的所有数据，按批次分组
// =====================================================
const fs = require('fs');
const path = require('path');
const CFG = require('./config');
const trainer = require('./train_api');

function esc(v) {
  return v === null || v === undefined ? '' : String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function tableHtml(title, columns, rows, id) {
  if (!rows || !rows.length) {
    return `<div class="panel"><div class="pt"><i></i><b>${esc(title)}</b><em>0 条</em></div><div class="pc"><div class="tbl" style="padding:20px;text-align:center;color:#5d89ad">暂无数据</div></div></div>`;
  }
  const thead = columns.map(c => `<th>${esc(c.label)}</th>`).join('');
  const tbody = rows.map((row, ri) => {
    const cols = columns.map(c => {
      const val = esc(row[c.key]);
      const cls = c.key === 'empName' || c.key === 'className' || c.key === 'sessionNo' || c.key === 'batchId' ? ' class="nm"' : '';
      return `<td${cls}>${val}</td>`;
    }).join('');
    return `<tr>${cols}</tr>`;
  }).join('');
  return `<div class="panel" id="${esc(id)}"><div class="pt"><i></i><b>${esc(title)}</b><em>${rows.length} 条</em></div><div class="pc"><div class="tbl"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div></div></div>`;
}

async function main() {
  const [leadersR, plansR, quotasR, recordsR, rulesR] = await Promise.all([
    trainer.queryAll('pxe_leader_info', {}, CFG.admin.account, CFG.admin.credential),
    trainer.queryAll('pxe_training_plan', {}, CFG.admin.account, CFG.admin.credential),
    trainer.queryAll('pxe_quota_alloc', {}, CFG.admin.account, CFG.admin.credential),
    trainer.queryAll('pxe_train_record', {}, CFG.admin.account, CFG.admin.credential),
    trainer.queryAll('pxe_training_rule', {}, CFG.admin.account, CFG.admin.credential),
  ]);

  const errors = [];
  for (const [name, result] of [['人员', leadersR], ['计划', plansR], ['名额', quotasR], ['记录', recordsR], ['规则', rulesR]]) {
    if (!result.ok) errors.push(`${name}: ${result.message || result.error}`);
  }
  if (errors.length) {
    console.log(`数据读取失败:\n${errors.join('\n')}`);
    process.exit(1);
  }

  const leaders = leadersR.rows || [];
  const plans = plansR.rows || [];
  const quotas = quotasR.rows || [];
  const records = recordsR.rows || [];
  const rules = rulesR.rows || [];

  // 按年度分组计划
  const yearGroups = {};
  plans.forEach(p => {
    const y = p.planYear || '未知';
    if (!yearGroups[y]) yearGroups[y] = [];
    yearGroups[y].push(p);
  });
  const yearsSorted = Object.keys(yearGroups).sort();

  // 按 batchId 分组计划
  const batchGroups = {};
  plans.forEach(p => {
    const b = p.batchId || '无批次';
    if (!batchGroups[b]) batchGroups[b] = [];
    batchGroups[b].push(p);
  });
  const batchIdsSorted = Object.keys(batchGroups).sort();

  // 记录也按年度分组
  const recYearGroups = {};
  records.forEach(r => {
    const y = r.planYear || '未知';
    if (!recYearGroups[y]) recYearGroups[y] = [];
    recYearGroups[y].push(r);
  });
  const recYearsSorted = Object.keys(recYearGroups).sort();

  // 统计
  const unitCount = {};
  leaders.forEach(p => {
    const u = p.unitName || '未填';
    unitCount[u] = (unitCount[u] || 0) + 1;
  });
  const levelCount = {};
  leaders.forEach(p => {
    const l = p.cadreLevel || '未填';
    levelCount[l] = (levelCount[l] || 0) + 1;
  });

  const totalPlanned = plans.reduce((s, p) => s + Number(p.planCount || 0), 0);
  const totalQuota = quotas.reduce((s, q) => s + Number(q.quotaCount || 0), 0);

  // 计划列
  const planCols = [
    { key: 'batchId', label: '批次' },
    { key: 'className', label: '班次名称' },
    { key: 'sessionNo', label: '期次' },
    { key: 'planYear', label: '计划年度' },
    { key: 'planCount', label: '计划人数' },
    { key: 'startDate', label: '开始日期' },
    { key: 'endDate', label: '结束日期' },
    { key: 'trainPlace', label: '培训地点' },
    { key: 'targetGroup', label: '培训对象' },
    { key: 'planId', label: '计划编号' },
  ];

  // 人员列
  const leaderCols = [
    { key: 'empName', label: '姓名' },
    { key: 'empId', label: '员工编号' },
    { key: 'unitName', label: '单位' },
    { key: 'cadreLevel', label: '干部级别' },
    { key: 'deptName', label: '部门' },
    { key: 'postName', label: '岗位' },
    { key: 'dutyName', label: '职务' },
    { key: 'age', label: '年龄' },
    { key: 'totalHours', label: '累计学时' },
    { key: 'isPartySec', label: '支部书记' },
    { key: 'isProdHead', label: '生产分管' },
    { key: 'bRole', label: 'B角' },
  ];

  // 名额列
  const quotaCols = [
    { key: 'planId', label: '计划编号' },
    { key: 'unitName', label: '单位' },
    { key: 'quotaCount', label: '名额数' },
    { key: 'planYear', label: '年度' },
  ];

  // 记录列
  const recordCols = [
    { key: 'empName', label: '姓名' },
    { key: 'empId', label: '员工编号' },
    { key: 'planYear', label: '培训年度' },
    { key: 'className', label: '班次名称' },
    { key: 'sessionNo', label: '期次' },
    { key: 'hours', label: '学时' },
    { key: 'startDate', label: '开始日期' },
    { key: 'endDate', label: '结束日期' },
    { key: 'trainResult', label: '培训结果' },
    { key: 'certNo', label: '证书编号' },
    { key: 'remark', label: '备注' },
  ];

  // 规则列
  const ruleCols = [
    { key: 'ruleCode', label: '规则编码' },
    { key: 'ruleName', label: '规则名称' },
    { key: 'ruleType', label: '规则类型' },
    { key: 'ruleContent', label: '规则内容' },
    { key: 'priority', label: '优先级' },
    { key: 'enabled', label: '启用' },
  ];

  // 按年度生成计划区块
  let planSections = '';
  for (const year of yearsSorted) {
    const yplans = yearGroups[year];
    planSections += `<div class="year-group">
      <div class="year-title"><i></i>${esc(year)} 年度计划 <em>共 ${yplans.length} 个期次，计划调训 ${yplans.reduce((s,p)=>s+Number(p.planCount||0),0)} 人次</em></div>
      <div class="batch-list">`;
    // 该年度内按 batchId 分组
    const yBatch = {};
    yplans.forEach(p => {
      const b = p.batchId || '无批次';
      if (!yBatch[b]) yBatch[b] = [];
      yBatch[b].push(p);
    });
    for (const [bid, bplans] of Object.entries(yBatch).sort()) {
      planSections += `<div class="batch-card">
        <div class="batch-title">批次：${esc(bid)} <em>${bplans.length} 个计划</em></div>
        <table class="data-table"><thead><tr>${planCols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
      bplans.forEach(p => {
        planSections += '<tr>' + planCols.map(c => `<td>${esc(p[c.key])}</td>`).join('') + '</tr>';
      });
      planSections += '</tbody></table></div>';
    }
    planSections += '</div></div>';
  }

  // 人员表（按单位分组）
  const unitGroups = {};
  leaders.forEach(p => {
    const u = p.unitName || '未填';
    if (!unitGroups[u]) unitGroups[u] = [];
    unitGroups[u].push(p);
  });

  let leaderSection = '';
  for (const [unit, members] of Object.entries(unitGroups).sort((a,b)=>b[1].length-a[1].length)) {
    leaderSection += `<div class="batch-card">
      <div class="batch-title">${esc(unit)} <em>${members.length} 人</em></div>
      <table class="data-table"><thead><tr>${leaderCols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
    members.forEach(p => {
      leaderSection += '<tr>' + leaderCols.map(c => `<td>${esc(p[c.key])}</td>`).join('') + '</tr>';
    });
    leaderSection += '</tbody></table></div>';
  }

  // 名额表
  let quotaSection = '';
  const qByPlan = {};
  quotas.forEach(q => {
    const pid = q.planId || '未知';
    if (!qByPlan[pid]) qByPlan[pid] = [];
    qByPlan[pid].push(q);
  });
  for (const [pid, qlist] of Object.entries(qByPlan)) {
    const planName = plans.find(p => p.planId === pid);
    quotaSection += `<div class="batch-card">
      <div class="batch-title">计划：${esc(pid)}${planName ? ' - ' + esc(planName.className) + ' ' + esc(planName.sessionNo) : ''} <em>${qlist.length} 个单位</em></div>
      <table class="data-table"><thead><tr>${quotaCols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
    qlist.forEach(q => {
      quotaSection += '<tr>' + quotaCols.map(c => `<td>${esc(q[c.key])}</td>`).join('') + '</tr>';
    });
    quotaSection += '</tbody></table></div>';
  }

  // 记录表（按年度分组）
  let recordSection = '';
  for (const year of recYearsSorted) {
    const recs = recYearGroups[year];
    recordSection += `<div class="year-group">
      <div class="year-title"><i></i>${esc(year)} 年度培训记录 <em>共 ${recs.length} 条</em></div>`;
    // 按班次分组
    const rByClass = {};
    recs.forEach(r => {
      const key = `${r.className || '未知'} ${r.sessionNo || ''}`;
      if (!rByClass[key]) rByClass[key] = [];
      rByClass[key].push(r);
    });
    for (const [cls, clsRecs] of Object.entries(rByClass).sort()) {
      recordSection += `<div class="batch-card">
        <div class="batch-title">${esc(cls)} <em>${clsRecs.length} 人</em></div>
        <table class="data-table"><thead><tr>${recordCols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>`;
      clsRecs.forEach(r => {
        recordSection += '<tr>' + recordCols.map(c => `<td>${esc(r[c.key])}</td>`).join('') + '</tr>';
      });
      recordSection += '</tbody></table></div>';
    }
    recordSection += '</div>';
  }

  // 规则表
  const ruleRows = rules.map(r => '<tr>' + ruleCols.map(c => `<td>${esc(r[c.key])}</td>`).join('') + '</tr>').join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>培小e · 全量数据展示</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#03121f;color:#cfe6f7}
.bg{position:fixed;inset:0;z-index:0;background:
 radial-gradient(ellipse at 50% -10%,rgba(24,90,150,.35),transparent 55%),
 radial-gradient(ellipse at 15% 100%,rgba(16,70,120,.25),transparent 50%),
 radial-gradient(ellipse at 85% 100%,rgba(16,70,120,.25),transparent 50%)}
.bg::after{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(64,158,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(64,158,255,.05) 1px,transparent 1px);background-size:46px 46px}
.wrap{position:relative;z-index:1;max-width:1600px;margin:0 auto;padding:0 16px 40px}
.hd{text-align:center;padding:20px 0 10px}
.hd h1{font-size:28px;letter-spacing:6px;font-weight:700;color:#fff;text-shadow:0 0 18px rgba(45,140,255,.8),0 0 40px rgba(45,140,255,.4)}
.hd .sub{font-size:12px;color:#6f9cc0;letter-spacing:2px;margin-top:4px}
.kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:14px 0}
.kpi{background:linear-gradient(180deg,rgba(14,44,76,.85),rgba(8,26,46,.85));border:1px solid rgba(64,158,255,.28);padding:12px 4px;text-align:center;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);position:relative}
.kpi::before{content:"";position:absolute;top:0;left:12%;right:12%;height:2px;background:linear-gradient(90deg,transparent,var(--kc,#2f9bff),transparent)}
.kv{font-size:22px;font-weight:700;color:var(--kc,#2f9bff);text-shadow:0 0 14px var(--kg,rgba(47,155,255,.5));font-family:"DIN Alternate",Consolas,"Microsoft YaHei",monospace}
.kl{font-size:11px;color:#7ea6c8;margin-top:4px}
.nav{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0;padding:10px 14px;background:rgba(10,34,58,.9);border:1px solid rgba(64,158,255,.22);position:sticky;top:0;z-index:10}
.nav a{color:#7fc3ff;text-decoration:none;font-size:13px;padding:4px 12px;border:1px solid rgba(64,158,255,.25);border-radius:3px;background:rgba(20,60,100,.3)}
.nav a:hover{background:rgba(47,155,255,.25);color:#fff}
.nav .count{color:#5d89ad;font-size:12px;margin-left:auto}
.year-group{margin-bottom:20px}
.year-title{font-size:18px;font-weight:700;color:#dff0ff;padding:10px 0 8px;border-bottom:1px solid rgba(64,158,255,.2);display:flex;align-items:center;gap:8px;margin-top:14px}
.year-title i{width:4px;height:16px;background:linear-gradient(#7fd4ff,#2f9bff);box-shadow:0 0 8px #2f9bff;display:inline-block}
.year-title em{margin-left:auto;font-style:normal;font-size:12px;color:#5d89ad;font-weight:400}
.batch-list{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.batch-card{border:1px solid rgba(64,158,255,.16);background:rgba(8,26,46,.7);overflow:hidden}
.batch-title{padding:8px 12px;font-size:14px;color:#a9cbe4;background:rgba(20,60,100,.25);border-bottom:1px solid rgba(64,158,255,.12)}
.batch-title em{margin-left:8px;font-style:normal;color:#5d89ad;font-size:12px}
.data-table{width:100%;border-collapse:collapse;font-size:12px}
.data-table th{position:sticky;top:0;background:#0d2c4a;color:#7fc3ff;padding:6px 4px;font-weight:600;letter-spacing:1px;border-bottom:1px solid rgba(64,158,255,.35);text-align:center;white-space:nowrap}
.data-table td{padding:5px 4px;text-align:center;color:#a9cbe4;border-bottom:1px dashed rgba(64,158,255,.08);white-space:nowrap}
.data-table tr:nth-child(even) td{background:rgba(20,60,100,.12)}
.data-table td.nm{color:#eaf6ff;font-weight:600}
.rule-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
.rule-table th{background:#0d2c4a;color:#7fc3ff;padding:6px 8px;font-weight:600;text-align:left;border-bottom:1px solid rgba(64,158,255,.35)}
.rule-table td{padding:5px 8px;color:#a9cbe4;border-bottom:1px dashed rgba(64,158,255,.08)}
.rule-table tr:nth-child(even) td{background:rgba(20,60,100,.12)}
.section-tip{font-size:12px;color:#5d89ad;padding:4px 0 8px}
.ft{margin-top:20px;border:1px solid rgba(64,158,255,.22);background:rgba(8,26,46,.9);padding:10px 14px;color:#5d89ad;font-size:12px;letter-spacing:1px;text-align:center}
</style></head><body>
<div class="bg"></div>
<div class="wrap">
<div class="hd">
<h1>培小e · 全量数据展示</h1>
<div class="sub">${new Date().toLocaleString('zh-CN')} · 数据来源 培训数据库</div>
</div>
<div class="kpis">
<div class="kpi" style="--kc:#2f9bff;--kg:rgba(47,155,255,.5)"><div class="kv">${leaders.length}</div><div class="kl">领导人员</div></div>
<div class="kpi" style="--kc:#37c8e8;--kg:rgba(55,200,232,.5)"><div class="kv">${plans.length}</div><div class="kl">培训计划期次</div></div>
<div class="kpi" style="--kc:#33d17a;--kg:rgba(51,209,122,.5)"><div class="kv">${totalPlanned}</div><div class="kl">计划调训人次</div></div>
<div class="kpi" style="--kc:#a96bf2;--kg:rgba(169,107,242,.5)"><div class="kv">${records.length}</div><div class="kl">培训记录数</div></div>
<div class="kpi" style="--kc:#ff9f43;--kg:rgba(255,159,67,.5)"><div class="kv">${quotas.length}</div><div class="kl">名额分配行数</div></div>
</div>
<div class="nav">
<a href="#plans">📋 培训计划 (${plans.length})</a>
<a href="#leaders">👤 人员信息 (${leaders.length})</a>
<a href="#quotas">📊 名额分配 (${quotas.length})</a>
<a href="#records">📝 培训记录 (${records.length})</a>
<a href="#rules">⚙️ 通用规则 (${rules.length})</a>
<span class="count">共 5 张表 · 人员 ${leaders.length} / 计划 ${plans.length}(${totalPlanned}人次) / 名额 ${quotas.length}(${totalQuota}) / 记录 ${records.length} / 规则 ${rules.length}</span>
</div>

<!-- 计划 -->
<h2 class="year-title" id="plans"><i></i>培训计划 <em>共 ${plans.length} 个期次</em></h2>
${planSections}

<!-- 人员 -->
<h2 class="year-title" id="leaders"><i></i>人员信息 <em>共 ${leaders.length} 人</em></h2>
<p class="section-tip">按单位分组 · 副科级 ${levelCount['副科级']||0} / 正科级 ${levelCount['正科级']||0} / 未填 ${levelCount['未填']||0}</p>
${leaderSection}

<!-- 名额 -->
<h2 class="year-title" id="quotas"><i></i>名额分配 <em>共 ${quotas.length} 行</em></h2>
<p class="section-tip">按计划分组 · 总计名额 ${totalQuota}</p>
${quotaSection}

<!-- 记录 -->
<h2 class="year-title" id="records"><i></i>培训记录 <em>共 ${records.length} 条</em></h2>
<p class="section-tip">按年度 · 班次分组</p>
${recordSection}

<!-- 规则 -->
<h2 class="year-title" id="rules"><i></i>通用规则 <em>共 ${rules.length} 条</em></h2>
<table class="rule-table"><thead><tr>${ruleCols.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
${ruleRows}
</tbody></table>

<div class="ft">培小e · 全量数据展示 · 自动生成</div>
</div>
</body></html>`;

  const outDir = path.join(CFG.outDir, '..', '输出');
  const datedDir = path.join(outDir, new Date().toISOString().slice(0,10));
  fs.mkdirSync(datedDir, { recursive: true });
  const outPath = path.join(datedDir, '培小e全量数据.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`✅ 已生成: ${outPath}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
