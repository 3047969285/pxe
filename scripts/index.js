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

【数据维护】（用业务字段定位，不需要主键；加 --预览 只看不改）
  改 <表> 定位字段=值 [...] 字段=新值 [...]
      例：node index.js 改 人员 员工编号=00044250 任职时间=2026-03-01
      例：node index.js 改 计划 年度=2027 班次=四级领导人员进修班 期次=第一期 调训规则="…"
      例：node index.js 改 名额 年度=2027 班次=四级领导人员进修班 期次=第一期 单位=济南公司 名额=6
      例：node index.js 改 规则 规则名称=参培对象限制 是否启用=0
  删 <表> 定位字段=值 [...]                            软删除

【出名单】（一条命令自动推进，每次取接口最新数据）
  名单 --年度 2027 [--每单位上限 N] [--输出 目录]     按状态：待翻译→写草稿 / 待审核→出审核表 / 全部确认→出名单
  名单 --复现 "<运行记录_2027.json.gz>"              用当次快照重算，核对结果指纹是否一致
  规则 登记 [草稿文件] [--覆盖]                         模型翻译好草稿后登记（待用户审核）
  规则 确认 "<审核表.xlsx>"                             用户审核完后读回（确认的锁定，驳回的退回重译；审核人必填）
  规则 审计 [--年度 2027]                             检查审核日志是否完整、每条确认由谁在何时做出、有无疑点
  规则 查看 [--年度 2027]                             用中文列出每个条款的状态与筛选条件
  规则 审核表 [--年度 2027]                           需要复核时重新出完整审核表

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

  // 2.1 规则依赖的人员字段（任职时间等）接口是否返回
  const sample = await trainer.query({ table: 'pxe_leader_info', pageNum: 1, pageSize: 20 });
  if (sample.ok && sample.rows && sample.rows.length) {
    const needed = { hireDate: '任职时间(hire_date)', age: '年龄', cadreLevel: '干部级别', isPartySec: '是否党支部书记' };
    const missing = Object.keys(needed).filter(key => !sample.rows.some(row => key in row));
    if (missing.length) {
      ui.warn(`人员接口未返回：${missing.map(k => needed[k]).join('、')}，相关规则条件会按空值处理，请后端在表枚举中加上`);
    } else {
      ui.ok('人员接口返回了规则所需字段（含任职时间）');
    }
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
// =====================================================
// 命令：改 / 删 —— 用业务字段定位一条记录，不需要知道主键
//   改 人员 员工编号=00044250 任职时间=2026-03-01
//   改 计划 年度=2027 班次=四级领导人员进修班 期次=第一期 调训规则=…
//   改 名额 年度=2027 班次=… 期次=第一期 单位=济南公司 名额=6
//   改 规则 规则名称=参培对象限制 是否启用=0
// 定位字段 = 主键或业务唯一键，其余都是要改的字段；必须唯一命中才执行，加 --预览 只看不改
// =====================================================
const LOCATOR = {
  pxe_leader_info: { pk: 'leaderId', keys: ['empId'] },
  pxe_training_plan: { pk: 'planId', keys: ['planYear', 'className', 'sessionNo'] },
  pxe_quota_alloc: { pk: 'quotaId', keys: ['planId', 'unitName'] },
  pxe_train_record: { pk: 'recordId', keys: ['empId', 'planYear', 'className', 'sessionNo'] },
  pxe_training_rule: { pk: 'ruleId', keys: ['ruleCode', 'ruleName'] },
};
const PLAN_KEYS = ['planYear', 'className', 'sessionNo'];

function splitPairs(table, pairs) {
  const spec = LOCATOR[table];
  const locate = {};
  const values = {};
  const planLocate = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const raw = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const field = resolveField(table, raw);
    // 名额表没有年度/班次/期次，按计划表解释后换成计划编号
    const planField = table === 'pxe_quota_alloc' ? resolveField('pxe_training_plan', raw) : null;
    if (planField && PLAN_KEYS.includes(planField)) planLocate[planField] = value;
    else if (spec && (field === spec.pk || spec.keys.includes(field))) locate[field] = value;
    else values[field] = value;
  }
  return { spec, locate, values, planLocate };
}

async function locateOne(table, pairs, options) {
  const auth = { account: options.account, credential: options.credential };
  const { spec, locate, values, planLocate } = splitPairs(table, pairs);
  if (!spec) return { error: `不支持的表：${table}` };
  if (Object.keys(planLocate).length) {
    const plan = await locateOne('pxe_training_plan',
      Object.entries(planLocate).map(([k, v]) => `${k}=${v}`), options);
    if (plan.error) return { error: `定位计划失败：${plan.error}` };
    locate.planId = plan.row.planId;
  }
  if (!Object.keys(locate).length) {
    return { error: `缺少定位字段，请给出 ${[spec.pk].concat(spec.keys).map(k => ui.labelOf(k)).join(' / ')}` };
  }
  const filters = Object.entries(locate).map(([field, value]) => ({ field, operator: 'EQ', value }));
  const found = await trainer.query(Object.assign({ table, filters, pageNum: 1, pageSize: 5 }, auth));
  if (!found.ok) return { error: found.message || found.error || '接口调用失败' };
  if (found.total !== 1) {
    const hint = (found.rows || []).map(r => spec.keys.map(k => r[k]).filter(Boolean).join(' ')).join('；');
    return { error: found.total ? `命中 ${found.total} 条，请补充定位字段（${hint}）` : '没有找到这条记录' };
  }
  return { row: found.rows[0], values, spec };
}

async function cmdModify(positionals, options) {
  const table = tableOf(positionals[1]);
  const target = await locateOne(table, positionals.slice(2), options);
  if (target.error) {
    ui.fail(`修改失败：${target.error}`);
    return 1;
  }
  const { row, values, spec } = target;
  if (!Object.keys(values).length) {
    ui.fail('没有要修改的字段：定位字段之外写上 字段=新值');
    return 1;
  }
  ui.title(options['预览'] ? '修改预览（未写入）' : '修改');
  Object.entries(values).forEach(([field, value]) => ui.info(`${ui.labelOf(field)}：${row[field] ?? '（空）'} → ${value}`));
  if (options['预览']) return 0;
  const result = await trainer.update({ table, single: Object.assign({ [spec.pk]: row[spec.pk] }, values),
    account: options.account, credential: options.credential });
  if (!result.ok) {
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.ok(`已修改 ${result.data} 条`);
  logAction('修改', `${ui.labelOfTable(table)} ${positionals.slice(2).join(' ')}`, true);
  return 0;
}

async function cmdRemove(positionals, options) {
  const table = tableOf(positionals[1]);
  const target = await locateOne(table, positionals.slice(2), options);
  if (target.error) {
    ui.fail(`删除失败：${target.error}`);
    return 1;
  }
  const { row, spec } = target;
  ui.title(options['预览'] ? '删除预览（未写入）' : '删除');
  ui.info(spec.keys.map(k => `${ui.labelOf(k)}=${row[k] ?? ''}`).join('  '));
  if (options['预览']) return 0;
  const result = await trainer.del({ table, single: { [spec.pk]: row[spec.pk] },
    account: options.account, credential: options.credential });
  if (!result.ok) {
    ui.fail(result.message || result.error || '接口调用失败');
    return 1;
  }
  ui.ok(`已删除 ${result.data} 条（软删除，数据仍保留）`);
  logAction('删除', `${ui.labelOfTable(table)} ${positionals.slice(2).join(' ')}`, true);
  return 0;
}

// =====================================================
// 命令：名单（= 建议）—— 一条命令按状态自动推进，每次取接口最新数据
//   退出码：0 名单已生成 / 2 需模型翻译 / 3 需用户审核 / 1 出错
// =====================================================
function showErrors(title, errors) {
  ui.title(title);
  errors.forEach(err => ui.fail(err));
  return 1;
}

async function cmdList(options) {
  const wf = require('./workflow');
  if (options['复现']) {
    const check = wf.reproduce(options['复现']);
    ui.title('复现核对');
    ui.info(`数据指纹 ${check.record.数据指纹}  规则指纹 ${check.record.规则指纹}  代码指纹 ${check.record.代码指纹}`);
    if (check.codeChanged) ui.warn('引擎代码已变化（代码指纹不同），结果不一致属正常');
    if (check.ok) ui.ok(`复现一致：结果指纹 ${check.actual}`);
    else ui.fail(`复现不一致：记录 ${check.expected}，重算 ${check.actual}`);
    return check.ok ? 0 : 1;
  }
  const year = String(options['年度'] || '2027');
  const state = await wf.loadState({ year, account: options.account, credential: options.credential });
  if (!state.ok) return showErrors('读取数据失败', [state.message]);
  const c = state.counts;
  ui.title(`${year} 年度出名单`);
  ui.info(`条款 ${state.resolved.length} 条：已确认 ${c.已确认}，待审核 ${c.待审核}，驳回 ${c.驳回}，待翻译 ${c.待翻译}`);

  if (state.todo.length) {
    const draft = wf.writeDraft(state.todo);
    state.todo.forEach(r => ui.warn(`[${r.errors.length ? '译文有误' : r.status}] ${r.clause.名称}`));
    ui.blank();
    ui.warn(`第 1 步（模型）：按 references/rule_dsl.md 填写草稿 ${draft}`);
    ui.info('然后执行：node index.js 规则 登记，再执行：node index.js 名单 --年度 ' + year);
    logAction('名单', `${year} 待翻译 ${state.todo.length}`, true);
    return 2;
  }
  if (state.pending.length) {
    const sheet = wf.makeReviewSheet(state, path.join(resolveOutDir(), `规则审核表_${year}.xlsx`));
    state.pending.forEach(r => ui.warn(`[待审核] ${r.clause.名称}`));
    ui.blank();
    ui.warn(`第 2 步（用户本人）：用 Excel/WPS 打开审核表，逐条选 确认/修改/驳回 并填审核人，保存：${sheet}`);
    ui.info('模型不得代填审核结果或审核人；程序改写的审核表会被记为疑点');
    ui.info(`审核完执行：node index.js 规则 确认 "${sheet}"，再执行：node index.js 名单 --年度 ${year}`);
    logAction('名单', `${year} 待审核 ${state.pending.length} -> ${sheet}`, true);
    return 3;
  }

  const result = wf.produceList(state, {
    limitPerUnit: options['每单位上限'] ? Number(options['每单位上限']) : undefined,
    outDir: options['输出'] || resolveOutDir(),
  });
  ui.ok(`名单已生成：${result.summary.plans} 个期次，建议 ${result.summary.total} 人次，剔除 ${result.summary.excluded} 人次`);
  result.summary.rules.hits.forEach(hit => ui.info(`  ${hit.来源}｜${hit.名称}：生效 ${hit.命中} 人次`));
  result.summary.rules.skipped.forEach(item => ui.warn(`  不执行｜${item.name}：${item.note}`));
  result.reviewWarnings.forEach(w => ui.warn(`  审核疑点｜${w}`));
  const f = result.fingerprints;
  ui.info(`数据指纹 ${f.数据指纹}  规则指纹 ${f.规则指纹}  代码指纹 ${f.代码指纹}  结果指纹 ${f.结果指纹}`);
  result.files.forEach(file => ui.info(`文件位置：${file}`));
  logAction('名单', `${year} ${result.summary.total} 人次 结果指纹 ${f.结果指纹}`, true);
  return 0;
}

// =====================================================
// 命令：规则 登记 / 确认 / 审核表 / 查看（名单命令会提示何时用哪个）
// =====================================================
function askLine(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

async function cmdRule(positionals, options) {
  const wf = require('./workflow');
  const dsl = require('./rule_dsl');
  const action = positionals[1] || '查看';
  const year = String(options['年度'] || '2027');
  const state = await wf.loadState({ year, account: options.account, credential: options.credential });
  if (!state.ok) return showErrors('读取数据失败', [state.message]);

  if (action === '登记') {
    const result = wf.register(state, positionals[2] || dsl.DRAFT_FILE, options['覆盖']);
    if (!result.ok) return showErrors('译文未通过校验（一条都没有登记）', result.errors);
    ui.title('译文已登记（待用户审核）');
    ui.ok(`登记 ${result.count} 条`);
    ui.info(`下一步：node index.js 名单 --年度 ${year}（自动生成审核表）`);
    logAction('规则登记', `${result.count} 条`, true);
    return 0;
  }
  if (action === '确认') {
    if (!positionals[2]) return showErrors('缺少审核表', ['用法：node index.js 规则 确认 "<规则审核表.xlsx>"']);
    let terminalReviewer;
    if (CFG.review && CFG.review.requireTerminal) {
      // 只有用户本人在交互终端里才能完成确认；模型在后台调用没有终端，会被拒绝
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return showErrors('需要用户本人确认', ['已开启 requireTerminal：请用户本人在终端执行此命令并输入审核人姓名']);
      }
      terminalReviewer = await askLine('请输入审核人姓名以确认审核结果：');
      if (!terminalReviewer) return showErrors('已取消', ['未输入审核人姓名']);
    }
    const result = wf.confirmReview(state, positionals[2], { terminalReviewer });
    if (!result.ok) return showErrors('审核表有问题（一条都没有保存）', result.errors);
    ui.title('审核结果已保存');
    ui.ok(`确认 ${result.confirmed} 条，驳回 ${result.rejected} 条`);
    result.flags.forEach(flag => ui.warn(`疑点已记入审核日志：${flag}`));
    ui.info(`下一步：node index.js 名单 --年度 ${year}`);
    logAction('规则确认', `确认 ${result.confirmed} / 驳回 ${result.rejected}`, true);
    return 0;
  }
  if (action === '审计') {
    const report = wf.audit(state);
    ui.title('审核审计');
    if (report.chain.ok) ui.ok(`审核日志完整（${state.ledger.length} 条，末条哈希 ${report.chain.head}）`);
    else ui.fail(`审核日志第 ${report.chain.brokenAt} 条被改动`);
    report.entries.forEach(e => {
      const line = `${e.时间.slice(0, 19).replace('T', ' ')} 审核单 ${e.审核单号}  ${e.条款.length} 条  `
        + `审核人 ${[...new Set(e.条款.map(c => c.审核人))].join('、')}  保存程序 ${e.保存程序 || '未知'}  用时 ${e.用时秒} 秒`
        + `${e.终端确认 === '是' ? '  终端确认' : ''}`;
      (e.疑点 && e.疑点.length ? ui.warn : ui.ok)(line);
      (e.疑点 || []).forEach(f => ui.warn(`    疑点：${f}`));
    });
    report.unproven.forEach(u => ui.fail(`[退回待审核] ${u.名称}：${u.原因}`));
    return report.chain.ok && !report.unproven.length ? 0 : 1;
  }
  if (action === '审核表') {
    if (state.todo.length) return showErrors('还有条款没有可用译文', state.todo.map(r => r.clause.名称));
    const sheet = wf.makeReviewSheet(state, options['输出'] || path.join(resolveOutDir(), `规则审核表_${year}.xlsx`));
    ui.title('规则审核表已生成（含已确认条款，可复核）');
    ui.ok(`文件位置：${sheet}`);
    return 0;
  }
  if (action === '查看' || action === '识别') {
    ui.title(`${year} 年度规则条款`);
    state.resolved.forEach(r => {
      const status = r.errors.length ? '译文有误' : r.status;
      (status === '已确认' ? ui.ok : ui.warn)(`[${status}] ${r.clause.名称}（${r.clause.来源}，指纹 ${r.clause.指纹}）`);
      if (r.entry && !r.errors.length) dsl.describeEntry(r.entry).forEach(line => ui.info(`    ${line}`));
      r.errors.forEach(err => ui.fail(`    ${err}`));
    });
    return 0;
  }
  return showErrors('没有这个动作', [`规则 可用：登记 / 确认 / 审计 / 审核表 / 查看`]);
}

// =====================================================
// 命令：看板
// =====================================================
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
    case '规则':
      return await cmdRule(positionals, options);
    case '名单':
    case '建议':
      return await cmdList(options);
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
