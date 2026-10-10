#!/usr/bin/env node
// =====================================================
// index.js —— 培小e 技能统一入口
// 用法： node index.js <命令> [参数...]
// 每个命令都是固定流程，直接调用 scripts 下已有代码完成，无需临场编写
// =====================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const CFG = require('./config');
const trainer = require('./train_api');

const SCRIPTS = __dirname;

// =====================================================
// 帮助菜单（能力清单）
// =====================================================
const HELP = `
培小e 培训数据助手 —— 可用命令

【数据导入】
  导入 <文件> [--table leader|plan|quota|record|rule] [--wide] [--sheet 名称]
      不传 --table 时自动识别表类型
      --wide 用于「名额分配」这类 单位×班次期次 的交叉表
      例：node index.js 导入 "D:/培小e输入/人员.xlsx"
      例：node index.js 导入 "D:/培小e输入/名额.xlsx" --wide

【数据查询】
  查询 <表> [--条件 字段=值] [--like 字段=值] [--字段 a,b,c] [--排序 字段] [--倒序] [--页 N] [--每页 N]
      表可取 leader|plan|quota|record|rule
      例：node index.js 查询 leader --like 姓名=张 --字段 姓名,单位 --每页 10
      例：node index.js 查询 record --条件 单位=济南公司 --排序 学时 --倒序

【数据导出】
  导出 <表> [--输出 文件路径]        导出全表为 Excel
  模板 <表> [--输出 文件路径]        生成空白录入模板

【数据维护】
  改  <表> 主键字段=值 字段=新值 [字段=新值 ...]
  删  <表> 主键字段=值

【规则匹配】
  建议 --年度 2027 [--每单位上限 N] [--输出 目录]     生成应训未训建议名单

【统计看板】
  看板 --年度 2027 [--输出 文件路径]                  生成 HTML 统计看板

【其它】
  帮助                                                  显示本菜单

提示：所有命令默认使用 config.js 里的管理员凭据；可用 --account / --credential 指定身份。
`;

// =====================================================
// 参数解析
// =====================================================
function parseArgs(argv) {
  const positionals = [];
  const options = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index++;
      }
    } else {
      positionals.push(token);
    }
    index++;
  }
  return { positionals, options };
}

// 收集同名多个选项值
function collectAll(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      values.push(argv[i + 1]);
    }
  }
  return values;
}

// 表简写转数据库表名
function tableOf(name) {
  const picked = name || 'record';
  return trainer.normalizeTable(picked);
}

// 把「字段=值」数组转成 filters
function toFilters(pairs, operator) {
  return (pairs || []).map(pair => {
    const at = pair.indexOf('=');
    return at < 0 ? null : { field: pair.slice(0, at).trim(), operator, value: pair.slice(at + 1).trim() };
  }).filter(Boolean);
}

// =====================================================
// 命令：导入
// =====================================================
async function cmdImport(file, options, argv) {
  if (!file) {
    console.error('用法: node index.js 导入 <文件> [--table ...] [--wide]');
    return 1;
  }
  const importer = require('./import_excel');
  return await importer.importFile({
    file,
    table: options.table ? tableOf(options.table) : undefined,
    wide: Boolean(options.wide),
    sheet: options.sheet,
    account: options.account,
    credential: options.credential,
  });
}

// =====================================================
// 命令：查询
// =====================================================
async function cmdQuery(tableName, options, argv) {
  const table = tableOf(tableName);
  const filters = [
    ...toFilters(collectAll(argv, '条件'), 'EQ'),
    ...toFilters(collectAll(argv, 'like'), 'LIKE'),
  ];
  const result = await trainer.query({
    table,
    filters,
    columns: options['字段']
      ? String(options['字段']).split(',').map(item => item.trim()).filter(Boolean) : undefined,
    orderBy: options['排序'],
    orderDirection: options['倒序'] ? 'DESC' : undefined,
    pageNum: options['页'] ? Number(options['页']) : 1,
    pageSize: options['每页'] ? Number(options['每页']) : 20,
    account: options.account,
    credential: options.credential,
  });
  if (!result.ok) {
    console.error(`查询失败: ${result.message || result.error}`);
    return 1;
  }
  console.log(`共 ${result.total} 条，当前第 ${result.pageNum} 页，返回 ${result.rows.length} 条`);
  console.log(JSON.stringify(result.rows, null, 2));
  return 0;
}

// =====================================================
// 命令：导出 / 模板
// =====================================================
async function cmdExport(tableName, options) {
  const { runParser } = require('./import_excel');
  const table = tableOf(tableName);
  const all = await trainer.queryAll(table, {}, options.account, options.credential);
  if (!all.ok) {
    console.error(`导出失败: ${all.message || all.error}`);
    return 1;
  }
  const target = options['输出'] || path.join(CFG.outDir || '.', `${table}.xlsx`);
  const jsonPath = path.join(os.tmpdir(), `peixiaoe_export_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(all.rows), 'utf8');
  let result;
  try {
    result = runParser(['--export', jsonPath, target, table]);
  } finally {
    fs.unlinkSync(jsonPath);
  }
  if (!result.ok) {
    console.error(`写 Excel 失败: ${result.error}`);
    return 1;
  }
  console.log(`已导出 ${all.rows.length} 条 -> ${target}`);
  return 0;
}

async function cmdTemplate(tableName, options) {
  const { runParser } = require('./import_excel');
  const table = tableOf(tableName);
  const target = options['输出'] || path.join(CFG.outDir || '.', `${table}-模板.xlsx`);
  const result = runParser(['--template', target, table]);
  if (!result.ok) {
    console.error(`生成模板失败: ${result.error}`);
    return 1;
  }
  console.log(`模板已生成 -> ${target}`);
  return 0;
}

// =====================================================
// 命令：修改 / 删除
// =====================================================
async function cmdModify(positionals, options) {
  const table = tableOf(positionals[1]);
  const pairs = positionals.slice(2);
  if (pairs.length < 2) {
    console.error('用法: node index.js 改 <表> 主键字段=值 字段=新值 [字段=新值 ...]');
    return 1;
  }
  const data = {};
  pairs.forEach(pair => {
    const at = pair.indexOf('=');
    if (at > 0) {
      data[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
  });
  const result = await trainer.update({ table, single: data, account: options.account, credential: options.credential });
  if (!result.ok) {
    console.error(`修改失败: ${result.message || result.error}`);
    return 1;
  }
  console.log(`修改成功，影响 ${result.data} 行`);
  return 0;
}

async function cmdRemove(positionals, options) {
  const table = tableOf(positionals[1]);
  const pair = positionals[2];
  if (!pair || pair.indexOf('=') < 0) {
    console.error('用法: node index.js 删 <表> 主键字段=值');
    return 1;
  }
  const at = pair.indexOf('=');
  const data = { [pair.slice(0, at).trim()]: pair.slice(at + 1).trim() };
  const result = await trainer.del({ table, single: data, account: options.account, credential: options.credential });
  if (!result.ok) {
    console.error(`删除失败: ${result.message || result.error}`);
    return 1;
  }
  console.log(`删除成功，影响 ${result.data} 行`);
  return 0;
}

// =====================================================
// 命令：建议名单 / 看板
// =====================================================
async function cmdAdvice(options) {
  const advisor = require('./ai_advisor');
  const result = await advisor.generateAdvice({
    year: options['年度'] || '2027',
    limitPerUnit: options['每单位上限'] ? Number(options['每单位上限']) : undefined,
    outDir: options['输出'] || CFG.outDir,
    account: options.account,
    credential: options.credential,
  });
  if (!result.ok) {
    console.error(`生成建议失败: ${result.message || result.error}`);
    return 1;
  }
  console.log(`建议名单已生成：${result.summary.plans} 个班次，建议 ${result.summary.total} 人次`);
  (result.files || []).forEach(file => console.log('  ->', file));
  return 0;
}

async function cmdDashboard(options) {
  const viewer = require('./html_viewer');
  const result = await viewer.buildDashboard({
    year: options['年度'] || '2027',
    target: options['输出'] || path.join(CFG.outDir || '.', `培小e看板_${options['年度'] || '2027'}.html`),
    account: options.account,
    credential: options.credential,
  });
  if (!result.ok) {
    console.error(`生成看板失败: ${result.message || result.error}`);
    return 1;
  }
  console.log(`看板已生成 -> ${result.file}`);
  return 0;
}

// =====================================================
// 主入口
// =====================================================
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '帮助' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    return 0;
  }
  const { positionals, options } = parseArgs(argv);
  switch (positionals[0]) {
    case '导入':
      return await cmdImport(positionals[1], options, argv);
    case '查询':
      return await cmdQuery(positionals[1], options, argv);
    case '导出':
      return await cmdExport(positionals[1], options);
    case '模板':
      return await cmdTemplate(positionals[1], options);
    case '改':
      return await cmdModify(positionals, options);
    case '删':
      return await cmdRemove(positionals, options);
    case '建议':
      return await cmdAdvice(options);
    case '看板':
      return await cmdDashboard(options);
    default:
      console.error(`未知命令: ${positionals[0]}`);
      console.log(HELP);
      return 1;
  }
}

main().then(code => process.exit(code || 0)).catch(err => {
  console.error('执行异常:', err.message);
  process.exit(1);
});
