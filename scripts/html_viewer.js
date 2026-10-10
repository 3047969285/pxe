// =====================================================
// html_viewer.js —— 培小e HTML 展示页面生成器
//
// 设计：固化模块 + 占位符替换
// 每个模块是固定的 HTML 骨架，Node.js 查询 API 后填入数据。
// 不依赖任何外部 CDN/JS 库（内网可用），纯原生 HTML+CSS。
//
// 已固化模块：
//   1. 登录信息栏（显示当前账号身份）
//   2. 导航 Tab（人员/计划/记录/名额/建议/统计）
//   3. 人员查询表
//   4. 培训计划表
//   5. 培训记录表
//   6. 单位名额表
//   7. 建议名单模块（含评分和理由）
//   8. 统计看板（聚合卡片）
//   9. 搜索/筛选模块
//   10. 导出数据区（预留占位）
// =====================================================
const fs = require('fs');
const path = require('path');
const CFG = require('./config');
const api = require('./train_api');

// =========================================
// HTML 模板（固化模块嵌入）
// =========================================
function getHtmlTemplate() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>培小e · 培训数据看板</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f0f2f5; color: #333; min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #1a3a5c 0%, #2d6a9f 100%);
    color: #fff; padding: 16px 24px;
    display: flex; align-items: center; justify-content: space-between;
    box-shadow: 0 2px 8px rgba(0,0,0,.15);
    position: sticky; top: 0; z-index: 100;
  }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header .user-info { font-size: 13px; opacity: .9; }
  .header .user-info span { background: rgba(255,255,255,.15); padding: 2px 10px; border-radius: 12px; margin-left: 8px; }

  .container { max-width: 1400px; margin: 0 auto; padding: 16px; }

  .nav-tabs {
    display: flex; gap: 4px; background: #fff; border-radius: 8px;
    padding: 4px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
    flex-wrap: wrap;
  }
  .nav-tabs button {
    padding: 8px 20px; border: none; background: transparent;
    border-radius: 6px; cursor: pointer; font-size: 14px;
    color: #666; transition: all .2s; white-space: nowrap;
  }
  .nav-tabs button:hover { background: #e8f0fe; color: #1a3a5c; }
  .nav-tabs button.active { background: #1a3a5c; color: #fff; }

  .module { display: none; }
  .module.active { display: block; }

  .card {
    background: #fff; border-radius: 8px; padding: 20px;
    margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
  }
  .card h2 { font-size: 16px; color: #1a3a5c; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #e8f0fe; }

  .stats-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px; margin-bottom: 16px;
  }
  .stat-card {
    background: #fff; border-radius: 8px; padding: 16px 20px;
    text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.08);
    border-left: 4px solid #2d6a9f;
  }
  .stat-card .num { font-size: 28px; font-weight: 700; color: #1a3a5c; }
  .stat-card .label { font-size: 13px; color: #999; margin-top: 4px; }

  table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  thead { background: #f5f7fa; }
  th { padding: 10px 8px; text-align: left; font-weight: 600; color: #555; border-bottom: 2px solid #e0e4e8; white-space: nowrap; }
  td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  tr:hover { background: #f8faff; }

  .tag {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 11px; font-weight: 500;
  }
  .tag-high { background: #ffe0e0; color: #c41e1e; }
  .tag-mid { background: #fff3d6; color: #b8860b; }
  .tag-low { background: #e8f0fe; color: #2d6a9f; }
  .tag-ok { background: #e6f7e6; color: #2e7d32; }

  .filter-bar {
    display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; align-items: center;
  }
  .filter-bar input, .filter-bar select {
    padding: 6px 12px; border: 1px solid #ddd; border-radius: 6px;
    font-size: 13px; outline: none;
  }
  .filter-bar input:focus, .filter-bar select:focus { border-color: #2d6a9f; }
  .filter-bar button {
    padding: 6px 16px; background: #1a3a5c; color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 13px;
  }
  .filter-bar button:hover { background: #2d6a9f; }

  .advice-reason { font-size: 12px; color: #888; max-width: 200px; }

  .footer { text-align: center; padding: 24px; color: #aaa; font-size: 12px; }

  .empty-state { text-align: center; padding: 40px; color: #aaa; }
  .empty-state .icon { font-size: 48px; margin-bottom: 12px; }

  .section-toggle { cursor: pointer; user-select: none; }
  .section-toggle:hover { opacity: .8; }

  .pagination {
    display: flex; gap: 4px; justify-content: center; align-items: center;
    margin-top: 12px; font-size: 13px;
  }
  .pagination button {
    padding: 4px 12px; border: 1px solid #ddd; background: #fff;
    border-radius: 4px; cursor: pointer;
  }
  .pagination button:hover { background: #e8f0fe; }
  .pagination .page-info { padding: 0 8px; color: #666; }

  .place-holder { background: #fafafa; border: 2px dashed #ddd; border-radius: 8px; padding: 32px; text-align: center; color: #bbb; }
  .place-holder .ph-title { font-size: 16px; margin-bottom: 8px; }

  @media (max-width: 768px) {
    .header { flex-direction: column; gap: 8px; text-align: center; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    table { font-size: 12px; }
    th, td { padding: 6px 4px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>培小e · 培训数据看板</h1>
  <div class="user-info">
    账号: <span>{{ACCOUNT_NAME}}</span>
    身份: <span>{{IDENTITY_LABEL}}</span>
    查询时间: <span>{{QUERY_TIME}}</span>
  </div>
</div>

<div class="container">
  <!-- ======== 模块 0: 数据概览统计卡片 ======== -->
  <div class="stats-grid">
    <div class="stat-card"><div class="num">{{STAT_PERSON_COUNT}}</div><div class="label">在册人员</div></div>
    <div class="stat-card"><div class="num">{{STAT_PLAN_COUNT}}</div><div class="label">培训计划</div></div>
    <div class="stat-card"><div class="num">{{STAT_RECORD_COUNT}}</div><div class="label">培训记录</div></div>
    <div class="stat-card"><div class="num">{{STAT_QUOTA_COUNT}}</div><div class="label">单位名额</div></div>
    <div class="stat-card"><div class="num">{{STAT_UNIT_COUNT}}</div><div class="label">涉及单位</div></div>
  </div>

  <!-- ======== 导航 Tab ======== -->
  <div class="nav-tabs">
    <button class="active" data-tab="tab-person" onclick="switchTab('tab-person')">人员信息</button>
    <button data-tab="tab-plan" onclick="switchTab('tab-plan')">培训计划</button>
    <button data-tab="tab-record" onclick="switchTab('tab-record')">培训记录</button>
    <button data-tab="tab-quota" onclick="switchTab('tab-quota')">单位名额</button>
    <button data-tab="tab-advice" onclick="switchTab('tab-advice')">培训建议</button>
    <button data-tab="tab-stats" onclick="switchTab('tab-stats')">统计看板</button>
    <button data-tab="tab-export" onclick="switchTab('tab-export')">数据导出</button>
  </div>

  <!-- ======== 模块 1: 人员信息 ======== -->
  <div id="tab-person" class="module active">
    <div class="card">
      <h2>人员信息 · {{PERSON_COUNT}} 人</h2>
      <div class="filter-bar">
        <input type="text" id="person-filter" placeholder="姓名/单位/地区搜索..." oninput="filterTable('person-table', this.value)">
        <button onclick="filterTable('person-table', document.getElementById('person-filter').value)">筛选</button>
        <span style="font-size:12px;color:#999;">共 {{PERSON_COUNT}} 条</span>
      </div>
      <div style="overflow-x:auto;">
        <table id="person-table">
          <thead>{{PERSON_HEADERS}}</thead>
          <tbody>{{PERSON_ROWS}}</tbody>
        </table>
      </div>
      <div class="empty-state" id="person-empty" style="display:none;">
        <div class="icon">📋</div>
        <div>暂无人员数据</div>
      </div>
    </div>
  </div>

  <!-- ======== 模块 2: 培训计划 ======== -->
  <div id="tab-plan" class="module">
    <div class="card">
      <h2>培训计划 · {{PLAN_COUNT}} 个</h2>
      <div class="filter-bar">
        <input type="text" id="plan-filter" placeholder="培训班名称/年份..." oninput="filterTable('plan-table', this.value)">
        <button onclick="filterTable('plan-table', document.getElementById('plan-filter').value)">筛选</button>
        <span style="font-size:12px;color:#999;">共 {{PLAN_COUNT}} 条</span>
      </div>
      <div style="overflow-x:auto;">
        <table id="plan-table">
          <thead>{{PLAN_HEADERS}}</thead>
          <tbody>{{PLAN_ROWS}}</tbody>
        </table>
      </div>
      <div class="empty-state" id="plan-empty" style="display:none;">
        <div class="icon">📅</div>
        <div>暂无培训计划</div>
      </div>
    </div>
  </div>

  <!-- ======== 模块 3: 培训记录 ======== -->
  <div id="tab-record" class="module">
    <div class="card">
      <h2>培训记录 · {{RECORD_COUNT}} 条</h2>
      <div class="filter-bar">
        <input type="text" id="record-filter" placeholder="姓名/培训班/单位..." oninput="filterTable('record-table', this.value)">
        <button onclick="filterTable('record-table', document.getElementById('record-filter').value)">筛选</button>
        <span style="font-size:12px;color:#999;">共 {{RECORD_COUNT}} 条</span>
      </div>
      <div style="overflow-x:auto;">
        <table id="record-table">
          <thead>{{RECORD_HEADERS}}</thead>
          <tbody>{{RECORD_ROWS}}</tbody>
        </table>
      </div>
      <div class="empty-state" id="record-empty" style="display:none;">
        <div class="icon">📝</div>
        <div>暂无培训记录</div>
      </div>
    </div>
  </div>

  <!-- ======== 模块 4: 单位名额 ======== -->
  <div id="tab-quota" class="module">
    <div class="card">
      <h2>单位名额分配 · {{QUOTA_COUNT}} 条</h2>
      <div class="filter-bar">
        <input type="text" id="quota-filter" placeholder="单位名称..." oninput="filterTable('quota-table', this.value)">
        <button onclick="filterTable('quota-table', document.getElementById('quota-filter').value)">筛选</button>
        <span style="font-size:12px;color:#999;">共 {{QUOTA_COUNT}} 条</span>
      </div>
      <div style="overflow-x:auto;">
        <table id="quota-table">
          <thead>{{QUOTA_HEADERS}}</thead>
          <tbody>{{QUOTA_ROWS}}</tbody>
        </table>
      </div>
      <div class="empty-state" id="quota-empty" style="display:none;">
        <div class="icon">🎯</div>
        <div>暂无名额分配数据</div>
      </div>
    </div>
  </div>

  <!-- ======== 模块 5: 培训建议 ======== -->
  <div id="tab-advice" class="module">
    <div class="card">
      <h2>培训建议 · 应训未训分析</h2>
      <div style="overflow-x:auto;">
        {{ADVICE_CONTENT}}
      </div>
    </div>
    <div class="card">
      <h2>建议统计</h2>
      <div class="stats-grid">
        <div class="stat-card"><div class="num">{{ADVICE_TOTAL}}</div><div class="label">建议人数</div></div>
        <div class="stat-card"><div class="num">{{ADVICE_GAP}}</div><div class="label">计划缺口</div></div>
        <div class="stat-card"><div class="num">{{ADVICE_HIGH}}</div><div class="label">高优先级</div></div>
        <div class="stat-card"><div class="num">{{ADVICE_MID}}</div><div class="label">中优先级</div></div>
      </div>
    </div>
    <div class="card">
      <h2>建议按单位分布</h2>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>单位</th><th>建议人数</th></tr></thead>
          <tbody>{{ADVICE_BY_UNIT}}</tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ======== 模块 6: 统计看板 ======== -->
  <div id="tab-stats" class="module">
    <div class="card">
      <h2>培训数据统计</h2>
      <div class="stats-grid">
        <div class="stat-card"><div class="num">{{STAT_PERSON_COUNT}}</div><div class="label">在册人员</div></div>
        <div class="stat-card"><div class="num">{{STAT_PLAN_COUNT}}</div><div class="label">培训计划</div></div>
        <div class="stat-card"><div class="num">{{STAT_RECORD_COUNT}}</div><div class="label">培训记录</div></div>
        <div class="stat-card"><div class="num">{{STAT_QUOTA_COUNT}}</div><div class="label">名额分配</div></div>
      </div>
    </div>
    <div class="card">
      <h2>按单位统计</h2>
      <div style="overflow-x:auto;">
        <table><thead><tr><th>单位</th><th>人员数</th><th>培训记录数</th></tr></thead>
        <tbody>{{STATS_BY_UNIT}}</tbody></table>
      </div>
    </div>
    <div class="card">
      <h2>按层级统计</h2>
      <div style="overflow-x:auto;">
        <table><thead><tr><th>干部层级</th><th>人数</th><th>已训人数</th></tr></thead>
        <tbody>{{STATS_BY_LEVEL}}</tbody></table>
      </div>
    </div>
    <div class="card place-holder">
      <div class="ph-title">📊 图表模块（占位）</div>
      <div>此处预留 ECharts 图表集成位置，可按需添加柱状图/饼图/趋势图</div>
      <div style="margin-top:12px;font-size:12px;color:#ccc;">{{CHART_PLACEHOLDER}}</div>
    </div>
  </div>

  <!-- ======== 模块 7: 数据导出区（占位） ======== -->
  <div id="tab-export" class="module">
    <div class="card place-holder">
      <div class="ph-title">📥 数据导出模块（占位）</div>
      <div>此处预留数据导出功能：可导出当前查询结果为 Excel/CSV 格式</div>
      <div style="margin-top:12px;">{{EXPORT_PLACEHOLDER}}</div>
    </div>
  </div>

</div>

<div class="footer">
  培小e · 培训数据智能助手 | 生成时间: {{GENERATE_TIME}} | 数据来源: 培训数据接口 v1
</div>

<script>
// ---------- Tab 切换 ----------
function switchTab(tabId) {
  var target = document.getElementById(tabId);
  if (!target) return;
  document.querySelectorAll('.module').forEach(function(m) { m.classList.remove('active'); });
  document.querySelectorAll('.nav-tabs button').forEach(function(b) { b.classList.remove('active'); });
  target.classList.add('active');
  // 通过 data-tab 定位按钮高亮（不依赖 event 对象）
  var btn = document.querySelector('.nav-tabs button[data-tab="' + tabId + '"]');
  if (btn) btn.classList.add('active');
}

// ---------- 表格搜索筛选 ----------
function filterTable(tableId, keyword) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  const kw = keyword.trim().toLowerCase();
  let visibleCount = 0;
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const match = !kw || text.includes(kw);
    row.style.display = match ? '' : 'none';
    if (match) visibleCount++;
  });
  // 显示/隐藏空状态
  const container = table.closest('.card');
  const emptyEl = container ? container.querySelector('.empty-state') : null;
  if (emptyEl) emptyEl.style.display = visibleCount === 0 ? 'block' : 'none';
}
</script>
</body>
</html>`;
}

// Helper: HTML 转义（防止 API 数据含特殊字符破坏页面）
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =========================================
// Helper: 构建表格标题行
// =========================================
function buildTableHeaders(fields) {
  const labels = {
    leader_id: 'ID', seq_no: '序号', region_name: '地区', unit_name: '单位',
    emp_name: '姓名', emp_id: '编号', id_card: '身份证', gender: '性别',
    age: '年龄', assist_date: '辅助日期', b_role: '角色',
    cadre_level: '干部层级', staff_grade: '职级', is_party_sec: '党委',
    trained_2026: '2026已训', total_hours: '总学时', is_prod_head: '生产骨干',
    remark: '备注',
    plan_id: '计划ID', batch_id: '批次', plan_year: '年份',
    class_name: '培训班', session_no: '期次', train_period: '周期',
    start_date: '开始', end_date: '结束', train_place: '地点',
    plan_count: '计划人数', target_group: '对象', rule_desc: '规则说明',
    rule_key: '规则键', matching_rules: '匹配规则',
    quota_id: '名额ID', unit_name: '单位', quota_count: '名额',
    record_id: '记录ID', emp_id: '人员编号', class_type: '类别',
    hours: '学时', unit_at_time: '参训单位', data_source: '来源',
  };
  return fields.map(f => `<th>${escapeHtml(labels[f] || f)}</th>`).join('');
}

// =========================================
// Helper: 构建数据行
// =========================================
function buildTableRows(rows, fields) {
  if (!rows || rows.length === 0) return '<tr><td colspan="100" style="text-align:center;color:#aaa;">暂无数据</td></tr>';
  return rows.map(r => {
    const cells = fields.map(f => {
      let val = r[f];
      if (val === null || val === undefined) return '<td>-</td>';
      // 特殊渲染
      if (f === 'is_prod_head' || f === 'is_party_sec' || f === 'trained_2026') {
        const ok = val === '是' || val === 1 || val === true || String(val) === '1';
        return `<td><span class="tag ${ok ? 'tag-ok' : ''}">${ok ? '是' : '否'}</span></td>`;
      }
      if (f === 'gender') {
        const gt = val === '1' ? '男' : val === '2' ? '女' : String(val);
        return `<td>${escapeHtml(gt)}</td>`;
      }
      return `<td>${escapeHtml(val)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
}

// =========================================
// 建议名单 HTML 片段（ai_advisor 调用）
// =========================================
function renderAdviceHtml(result, auth) {
  if (!result || !result.plans || result.plans.length === 0) {
    return '<div class="empty-state"><div class="icon">📊</div><div>暂无建议数据</div></div>';
  }
  let html = '';
  for (const p of result.plans) {
    const gapLabel = p.gap > 0 ? `<span style="color:#c41e1e;">缺口 ${p.gap} 人</span>` : '名额充足';
    const cls = escapeHtml(p.className || '(未命名)');
    const sess = p.sessionNo ? `· 第${escapeHtml(p.sessionNo)}期` : '';
    const rules = p.rules && p.rules.length ? p.rules.map(escapeHtml).join('; ') : '';
    html += `<div style="margin-bottom:20px;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden;">
      <div style="background:#f5f7fa;padding:10px 14px;font-weight:600;display:flex;justify-content:space-between;align-items:center;">
        <span>${cls} ${sess}</span>
        <span style="font-size:12px;font-weight:400;">建议 ${p.suggestCount} 人 | ${gapLabel} | ${rules}</span>
      </div>
      <div style="padding:8px;">
        <table>
          <thead><tr><th>姓名</th><th>单位</th><th>地区</th><th>干部层级</th><th>角色</th><th>骨干</th><th>历史已训</th><th>学时</th><th>优先级</th><th>评分</th><th>理由</th></tr></thead>
          <tbody>`;
    for (const a of p.advice) {
      const tagClass = a.priority === '高' ? 'tag-high' : a.priority === '中' ? 'tag-mid' : 'tag-low';
      const reasons = (a.reasons || []).map(escapeHtml).join('; ');
      html += `<tr>
        <td><strong>${escapeHtml(a.empName || '-')}</strong></td>
        <td>${escapeHtml(a.unitName || '-')}</td>
        <td>${escapeHtml(a.regionName || '-')}</td>
        <td>${escapeHtml(a.cadreLevel || '-')}</td>
        <td>${escapeHtml(a.bRole || '-')}</td>
        <td>${a.isProdHead ? '是' : '否'}</td>
        <td>${a.trainedBefore ? `<span class="tag tag-ok">已训</span>` : `<span class="tag tag-low">未训</span>`} ${a.needMakeup ? '(补)' : ''}</td>
        <td>${a.totalHours || 0}</td>
        <td><span class="tag ${tagClass}">${escapeHtml(a.priority)}</span></td>
        <td>${a.score}</td>
        <td class="advice-reason">${reasons}</td>
      </tr>`;
    }
    html += `</tbody></table></div></div>`;
  }
  return html;
}

// 建议按单位分布
function renderAdviceByUnit(stats) {
  if (!stats || !stats.byUnit) return '<tr><td colspan="2" style="text-align:center;color:#aaa;">暂无统计</td></tr>';
  return Object.entries(stats.byUnit).map(([unit, cnt]) =>
    `<tr><td>${escapeHtml(unit)}</td><td>${cnt}</td></tr>`
  ).join('');
}

// =========================================
// 渲染主流程：查询 API → 填充模板 → 写文件
// =========================================
async function buildViewer(account, credential, adviceData = null) {
  const auth = { account, credential };
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN');

  // 如果 adviceData 含 rawTables，复用预加载数据，避免重复查库
  const preload = adviceData?.rawTables || null;

  let persons, plans, records, quotas;
  if (preload) {
    persons = preload.persons || [];
    plans = preload.plans || [];
    records = preload.records || [];
    quotas = preload.quotas || [];
  } else {
    // 并行拉取四张表（全部降级，单表失败不影响整体）
    const results = await Promise.allSettled([
      api.queryAll(CFG.tables.leader, [], account, credential),
      api.queryAll(CFG.tables.plan, [], account, credential),
      api.queryAll(CFG.tables.record, [], account, credential),
      api.queryAll(CFG.tables.quota, [], account, credential),
    ]);

    const extract = (res, fallback = []) =>
      res.status === 'fulfilled' && res.value.ok ? (res.value.rows || []) : fallback;
    persons = extract(results[0]);
    plans = extract(results[1]);
    records = extract(results[2]);
    quotas = extract(results[3]);

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        console.error(`[看板] 表 #${i} 查询异常: ${results[i].reason?.message || results[i].reason}`);
      } else if (results[i].status === 'fulfilled' && !results[i].value.ok) {
        console.error(`[看板] 表 #${i} 查询失败: ${results[i].value.message || results[i].value.error}`);
      }
    }
  }

  // 统计：去重单位
  const unitSet = new Set();
  persons.forEach(p => { if (p.unit_name) unitSet.add(p.unit_name); });
  records.forEach(r => { if (r.unit_at_time) unitSet.add(r.unit_at_time); });
  quotas.forEach(q => { if (q.unit_name) unitSet.add(q.unit_name); });

  // 按单位/层级聚合
  const byUnit = {};
  for (const p of persons) {
    const u = p.unit_name || '(未知)';
    if (!byUnit[u]) byUnit[u] = { unit: u, personCount: 0, recordCount: 0 };
    byUnit[u].personCount++;
  }
  for (const r of records) {
    const u = r.unit_at_time || '(未知)';
    if (!byUnit[u]) byUnit[u] = { unit: u, personCount: 0, recordCount: 0 };
    byUnit[u].recordCount++;
  }

  // 按层级聚合（先建 人→层级 Map 索引，避免 O(记录×人员) 逐条 find）
  const personLevelMap = new Map();
  for (const p of persons) {
    const key = p.emp_id || p.emp_name;
    if (key && p.cadre_level) personLevelMap.set(key, p.cadre_level);
  }
  const byLevel = {};
  for (const p of persons) {
    const l = p.cadre_level || '(未知)';
    if (!byLevel[l]) byLevel[l] = { level: l, count: 0, trained: 0 };
    byLevel[l].count++;
  }
  for (const r of records) {
    // 通过索引 O(1) 定位人员层级
    const pid = r.emp_id || r.emp_name;
    const cl = pid ? personLevelMap.get(pid) : null;
    if (cl) {
      if (!byLevel[cl]) byLevel[cl] = { level: cl, count: 0, trained: 0 };
      byLevel[cl].trained++;
    }
  }

  // 生成各类表头和数据
  const leaderFields = ['seq_no', 'region_name', 'unit_name', 'emp_name', 'emp_id', 'gender', 'age', 'cadre_level', 'b_role', 'is_prod_head', 'trained_2026', 'total_hours', 'remark'];
  const planFields = ['plan_year', 'class_name', 'session_no', 'start_date', 'end_date', 'train_place', 'plan_count', 'target_group', 'rule_desc', 'remark'];
  const recordFields = ['emp_name', 'emp_id', 'class_name', 'session_no', 'class_type', 'start_date', 'end_date', 'hours', 'unit_at_time', 'data_source', 'remark'];
  const quotaFields = ['plan_id', 'unit_name', 'quota_count', 'remark'];

  // 建议相关占位符：有建议数据则渲染；否则空态
  let adviceContent, adviceByUnit, adviceTotal = 0, adviceGap = 0, adviceHigh = 0, adviceMid = 0;
  if (adviceData && adviceData.plans && adviceData.plans.length > 0) {
    adviceContent = renderAdviceHtml(adviceData);
    adviceByUnit = renderAdviceByUnit(adviceData.stats || {});
    adviceTotal = adviceData.stats?.totalSuggest || 0;
    adviceGap = adviceData.stats?.totalGap || 0;
    for (const p of adviceData.plans) {
      adviceHigh += p.advice.filter(a => a.priority === '高').length;
      adviceMid += p.advice.filter(a => a.priority === '中').length;
    }
  } else {
    adviceContent = '<div class="empty-state"><div class="icon">💡</div><div>运行 <code>node index.js 建议</code> 生成培训建议后统一展示</div></div>';
    adviceByUnit = '<tr><td colspan="2" style="text-align:center;color:#aaa;">暂无建议数据</td></tr>';
  }

  // 构建占位符替换
  const isAdmin = account === CFG.admin.account || (account || '').toLowerCase() === 'admin';
  const placeholders = {
    '{{ACCOUNT_NAME}}': account || 'admin',
    '{{IDENTITY_LABEL}}': isAdmin ? '管理员' : '普通用户',
    '{{QUERY_TIME}}': timeStr,
    '{{GENERATE_TIME}}': timeStr,
    '{{STAT_PERSON_COUNT}}': persons.length,
    '{{STAT_PLAN_COUNT}}': plans.length,
    '{{STAT_RECORD_COUNT}}': records.length,
    '{{STAT_QUOTA_COUNT}}': quotas.length,
    '{{STAT_UNIT_COUNT}}': unitSet.size,
    '{{PERSON_COUNT}}': persons.length,
    '{{PERSON_HEADERS}}': buildTableHeaders(leaderFields),
    '{{PERSON_ROWS}}': buildTableRows(persons, leaderFields),
    '{{PLAN_COUNT}}': plans.length,
    '{{PLAN_HEADERS}}': buildTableHeaders(planFields),
    '{{PLAN_ROWS}}': buildTableRows(plans, planFields),
    '{{RECORD_COUNT}}': records.length,
    '{{RECORD_HEADERS}}': buildTableHeaders(recordFields),
    '{{RECORD_ROWS}}': buildTableRows(records, recordFields),
    '{{QUOTA_COUNT}}': quotas.length,
    '{{QUOTA_HEADERS}}': buildTableHeaders(quotaFields),
    '{{QUOTA_ROWS}}': buildTableRows(quotas, quotaFields),
    '{{STATS_BY_UNIT}}': Object.values(byUnit).sort((a, b) => b.personCount - a.personCount)
      .map(u => `<tr><td>${escapeHtml(u.unit)}</td><td>${u.personCount}</td><td>${u.recordCount}</td></tr>`).join(''),
    '{{STATS_BY_LEVEL}}': Object.values(byLevel).sort((a, b) => b.count - a.count)
      .map(l => `<tr><td>${escapeHtml(l.level)}</td><td>${l.count}</td><td>${l.trained}</td></tr>`).join(''),
    '{{ADVICE_CONTENT}}': adviceContent,
    '{{ADVICE_TOTAL}}': adviceTotal,
    '{{ADVICE_GAP}}': adviceGap,
    '{{ADVICE_HIGH}}': adviceHigh,
    '{{ADVICE_MID}}': adviceMid,
    '{{ADVICE_BY_UNIT}}': adviceByUnit,
    '{{CHART_PLACEHOLDER}}': '图表集成占位 — 可在此处嵌入 ECharts（需内网部署 echarts.min.js）',
    '{{EXPORT_PLACEHOLDER}}': '数据导出功能占位 — 可在此处添加导出按钮（CSV/Excel）',
  };

  let html = getHtmlTemplate();
  for (const [key, val] of Object.entries(placeholders)) {
    html = html.replaceAll(key, String(val));
  }

  return html;
}

// 带建议数据的高级渲染（供 ai_advisor 调用）
async function renderAdvice(adviceResult, auth) {
  // 直接把建议数据传给 buildViewer，一次性完成占位符填充
  return buildViewer(auth.account, auth.credential, adviceResult);
}

module.exports = { buildViewer, renderAdvice, renderAdviceHtml };
