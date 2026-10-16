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
const ui = require('./display');
const { resolveField } = require('./field_map');

// =====================================================
// 结果目录与操作日志
// =====================================================

// 解析本次运行的结果目录（按日期归档时带日期子目录）
function resolveOutDir() {
  const base = CFG.outDir;
  if (!CFG.outputByDate) {
    return base;
  }
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return path.join(base, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
}

// 追加一行操作日志，记录时间、命令与结果
function logAction(action, detail, okFlag) {
  if (!CFG.operationLog) {
    return;
  }
  try {
    const dir = CFG.outDir;
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const line = `[${stamp}] ${okFlag ? '成功' : '失败'}  ${action}  ${detail}
`;
    fs.appendFileSync(path.join(dir, '操作日志.txt'), line, 'utf8');
  } catch (err) {
    // 日志写不了不影响主流程
  }
}

const SCRIPTS = __dirname;

// =====================================================
// 帮助菜单（能力清单）
// =====================================================
const HELP = `
培小e 培训数据助手 —— 可用命令

【数据导入】
  导入 <文件> [--table 人员|计划|名额|记录|规则] [--wide] [--sheet 工作表名]
      不传 --table 时自动识别文件属于哪张表
      --wide 用于「名额分配」这类 单位×班次期次 的交叉表
      例：node index.js 导入 "D:/培小e输入/人员.xlsx"
      例：node index.js 导入 "D:/培小e输入/计划表.xlsx" --wide

【数据查询】
  查询 <表> [--条件 字段=值] [--like 字段=值] [--字段 a,b,c] [--排序 字段] [--倒序] [--页 N] [--每页 N]
      表 可取：人员 / 计划 / 名额 / 记录 / 规则
      字段 写中文即可，如 姓名、单位、班次名称、学时
      例：node index.js 查询 人员 --like 姓名=张 --字段 姓名,单位 --每页 10
      例：node index.js 查询 记录 --条件 单位=济南公司 --排序 学时 --倒序

【数据导出】
  导出 <表> [--输出 文件路径]        导出该表为 Excel（列与导入模板一致）
  模板 <表> [--输出 文件路径]        生成空白录入模板

【数据维护】
  改  <表> 主键字段=值 字段=新值 [字段=新值 ...]
  删  <表> 主键字段=值

【规则匹配】
  建议 --年度 2027 [--每单位上限 N] [--输出 目录]     生成应训未训建议名单

【统计看板】
  看板 --年度 2027 [--输出 文件路径]                  生成 HTML 统计看板

【自检】
  自检                                                  检查接口配置、后端连通、结果目录、解析环境

【其它】
  帮助                                                  显示本菜单

说明：所有命令默认使用 config.js 里的管理员凭据；可用 --account / --credential 指定身份。
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
// 命令：自检（逐个检查运行依赖）
// =====================================================
async function cmdSelfCheck() {
  ui.title('运行环境自检');
  let allOk = true;

  // 1 接口配置
  ui.info(`接口地址：${CFG.api.baseUrl}`);
  ui.info(`接口密钥：${CFG.api.apiSecret ? '已配置' : '未配置'}`);
  if (!CFG.api.baseUrl || !CFG.api.apiSecret) {
    ui.fail('接口地址或密钥未配置，请检查 scripts/config.js');
    allOk = false;
  } else {
    ui.ok('接口配置正常');
  }

  // 2 后端连通
  const probe = await trainer.query({ table: 'pxe_training_rule', pageNum: 1, pageSize: 1 });
  if (probe.ok) {
    ui.ok(`后端连通正常（规则表共 ${probe.total} 条）`);
  } else {
    ui.fail(`后端不通：${probe.message || probe.error}`);
    ui.info('请确认后端服务已启动，且地址与 config.js 一致');
    allOk = false;
  }

  // 3 结果目录可写
  const dir = resolveOutDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probeFile = path.join(dir, '.write_test');
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    ui.ok(`结果目录可写：${dir}`);
  } catch (err) {
    ui.fail(`结果目录不可写：${dir}（${err.message}）`);
    allOk = false;
  }

  // 4 图表库
  const charts = path.join(__dirname, 'assets', 'echarts.min.js');
  if (fs.existsSync(charts)) {
    ui.ok('图表库就绪（生成 HTML 可离线打开）');
  } else {
    ui.warn('未找到 assets/echarts.min.js，HTML 图表将回退到外网 CDN');
  }

  // 5 Python 解析环境
  try {
    const { execFileSync } = require('child_process');
    const ver = execFileSync(CFG.python || 'python', ['-c', 'import openpyxl,sys;print(openpyxl.__version__)'],
      { encoding: 'utf8' }).trim();
    ui.ok(`Excel 解析环境就绪（openpyxl ${ver}）`);
  } catch (err) {
    ui.fail('未找到 Python 或 openpyxl，Excel 解析将不可用');
    allOk = false;
  }

  ui.blank();
  if (allOk) {
    logAction('自检', '全部通过', true);
    ui.ok('自检通过，可以正常使用全部功能');
    return 0;
  }
  logAction('自检', '存在未通过项', false);
  ui.fail('自检未全部通过，请按上面提示处理');
  return 1;
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
    ui.title('查询失败');
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.title(`查询结果 · ${ui.labelOfTable(table)}`);
  ui.info(`共 ${result.total} 条，当前第 ${result.pageNum} 页，本页显示 ${result.rows.length} 条`);
  const showColumns = options['字段']
    ? String(options['字段']).split(',').map(s => resolveField(table, s.trim())).filter(Boolean)
    : undefined;
  ui.table(result.rows, showColumns);
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
    ui.title('导出失败');
    ui.fail(all.message || all.error || '接口调用失败');
    return 1;
  }
  const target = options['输出'] || path.join(resolveOutDir(), `${ui.labelOfTable(table)}.xlsx`);
  const jsonPath = path.join(CFG.processDir || os.tmpdir(), `peixiaoe_export_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(all.rows), 'utf8');
  let result;
  try {
    result = runParser(['--export', jsonPath, target, table]);
  } finally {
    fs.unlinkSync(jsonPath);
  }
  if (!result.ok) {
    ui.fail(`写入 Excel 失败：${result.error}`);
    return 1;
  }
  ui.title('导出完成');
  ui.ok(`${ui.labelOfTable(table)}：已导出 ${all.rows.length} 条`);
  ui.info(`文件位置：${target}`);
  logAction('导出', `${ui.labelOfTable(table)} ${all.rows.length} 条 -> ${target}`, true);
  return 0;
}

async function cmdTemplate(tableName, options) {
  const { runParser } = require('./import_excel');
  const table = tableOf(tableName);
  const target = options['输出'] || path.join(resolveOutDir(), `${ui.labelOfTable(table)}导入模板.xlsx`);
  const result = runParser(['--template', target, table]);
  if (!result.ok) {
    ui.fail(`生成模板失败：${result.error}`);
    return 1;
  }
  ui.title('模板已生成');
  ui.ok(`文件位置：${target}`);
  logAction('模板', `${ui.labelOfTable(table)} -> ${target}`, true);
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
      data[resolveField(table, pair.slice(0, at).trim())] = pair.slice(at + 1).trim();
    }
  });
  const result = await trainer.update({ table, single: data, account: options.account, credential: options.credential });
  if (!result.ok) {
    ui.title('修改失败');
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.title('修改完成');
  ui.ok(`已修改 ${result.data} 条数据`);
  logAction('修改', `${ui.labelOfTable(table)} ${result.data} 条`, true);
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
  const data = { [resolveField(table, pair.slice(0, at).trim())]: pair.slice(at + 1).trim() };
  const result = await trainer.del({ table, single: data, account: options.account, credential: options.credential });
  if (!result.ok) {
    ui.title('删除失败');
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.title('删除完成');
  ui.ok(`已删除 ${result.data} 条数据（软删除，数据仍保留）`);
  logAction('删除', `${ui.labelOfTable(table)} ${result.data} 条`, true);
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
    outDir: options['输出'] || resolveOutDir(),
    account: options.account,
    credential: options.credential,
  });
  if (!result.ok) {
    ui.title('生成失败');
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.title('建议名单已生成');
  const peopleText = result.summary.people !== undefined ? `（${result.summary.people} 人）` : '';
  ui.ok(`共 ${result.summary.plans} 个班次，建议 ${result.summary.total} 人次${peopleText}，剔除 ${result.summary.excluded} 人次`);
  const ruleInfo = result.summary.rules || {};
  (ruleInfo.unknown || []).forEach(rule => ui.warn(`未识别规则：${rule.name || rule.code}（未参与计算）`));
  (ruleInfo.warnings || []).forEach(text => ui.warn(text));
  if (result.writeError) {
    ui.fail(`结果文件写出失败：${result.writeError}`);
  }
  (result.files || []).forEach(file => ui.info(`文件位置：${file}`));
  logAction('建议名单', `${result.summary.plans} 个班次 / ${result.summary.total} 人次`, true);
  return 0;
}

async function cmdDashboard(options) {
  const viewer = require('./html_viewer');
  const result = await viewer.buildDashboard({
    year: options['年度'] || '2027',
    target: options['输出'] || path.join(resolveOutDir(), `培小e看板_${options['年度'] || '2027'}.html`),
    account: options.account,
    credential: options.credential,
  });
  if (!result.ok) {
    ui.title('生成失败');
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.title('统计看板已生成');
  ui.ok(`文件位置：${result.file}`);
  logAction('统计看板', `${options['年度'] || '2027'} -> ${result.file}`, true);
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
    case '自检':
      return await cmdSelfCheck();
    default:
      console.error(`
  没有这个命令：「${positionals[0]}」
`);
      console.log(HELP);
      return 1;
  }
}

main().then(code => process.exit(code || 0)).catch(err => {
  ui.fail('执行出错：' + err.message);
  process.exit(1);
});
