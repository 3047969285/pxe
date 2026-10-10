// =====================================================
// dashboard_gen.js —— 大屏 HTML 生成（ECharts）
// 框架占位：Dify agg 聚合数据到位后填充实现
// =====================================================
const fs = require('fs');
const path = require('path');
const CFG = require('./config');

// 支持的大屏维度（与 SKILL.md 一致）
const DIMS = ['单位', '层级', '时间', '班次'];

// 聚合数据 -> 自包含大屏 HTML
// TODO: 用聚合结果按维度渲染 ECharts 图表（柱状/饼图/趋势线）
// 要点:
//  - 单文件自包含，内联 ECharts CDN 不可用(内网)，需引入本地 echarts.min.js 或内联
//  - 看板内做维度切换 tab
//  - 产物落盘 CFG.outDir/${date}_培小e大屏.html
function build(aggData, dim) {
  if (!DIMS.includes(dim)) dim = '单位';
  const out = path.join(CFG.outDir, `培小e大屏_${dim}.html`);
  console.log(`[培小e] 大屏生成(框架占位, 维度=${dim}): ${out}`);
  // TODO: 组装 ECharts 配置 + 数据 -> 写 HTML
  return out;
}

module.exports = { build, DIMS };
