// 将指定目录中的三份培小e源Excel规范化后，通过 JSON API 写入四张业务表。
// 默认仅预览；只有显式传入 --apply 并在交互确认后才会写入。
const { execFileSync } = require('child_process');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const CFG = require('./config');
const api = require('./train_api');

const LOADER = path.join(__dirname, 'excel_loader.py');
const SYSTEM_FIELDS = new Set(['guid', 'del_flag', 'created_at', 'updated_at']);
const SOURCE_TABLES = [
  { key: 'pxe_leader_info', table: CFG.tables.leader },
  { key: 'pxe_training_plan', table: CFG.tables.plan },
  { key: 'pxe_quota_alloc', table: CFG.tables.quota },
  { key: 'pxe_train_record', table: CFG.tables.record },
];

function parseArgs(argv) {
  const options = { apply: false, dataDir: null, account: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--apply') options.apply = true;
    else if (value === '--data-dir' && argv[i + 1]) options.dataDir = argv[++i];
    else if (value === '--account' && argv[i + 1]) options.account = argv[++i];
    else if (value === '--help' || value === '-h') options.help = true;
  }
  return options;
}

function loadSourceData(dataDir) {
  const python = process.env.PYTHON || 'python';
  const args = [LOADER, '--full'];
  if (dataDir) args.push('--data-dir', dataDir);
  const output = execFileSync(python, args, {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    windowsHide: true,
  });
  const result = JSON.parse(output);
  if (!result.ok) throw new Error(result.error || '源Excel解析失败');
  return result;
}

function planKey(row) {
  return [Number(row.plan_year), String(row.class_name || '').trim(), Number(row.session_no)].join('|');
}

async function queryActualPlanIds(plans, auth) {
  const years = [...new Set(plans.map(row => Number(row.plan_year)))];
  const expectedKeys = new Set(plans.map(planKey));
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const results = await Promise.all(years.map(year => api.queryAll(CFG.tables.plan, [
      { field: 'plan_year', operator: 'EQ', value: year },
    ], auth.account, auth.credential)));
    const failure = results.find(result => !result.ok);
    if (failure) throw new Error(`查询数据库计划ID失败：${failure.message || failure.error}`);

    const ids = new Map();
    for (const row of results.flatMap(result => result.rows || [])) {
      const key = planKey(row);
      if (ids.has(key)) throw new Error('数据库中存在重复的年度+班次+期次，已停止后续写入。');
      ids.set(key, row.plan_id);
    }
    const missing = [...expectedKeys].filter(key => !ids.has(key));
    if (!missing.length) return ids;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
  }
  throw new Error('读库暂未查到全部计划ID（可能存在复制延迟）；已停止名额和记录写入，请稍后使用同一源文件重试。');
}

function withoutMockFields(rows, primaryKey) {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).filter(([key, value]) => key !== primaryKey && !SYSTEM_FIELDS.has(key) && value !== undefined)
  ));
}

async function writeBatches(table, rows, auth) {
  let submitted = 0;
  let affected = 0;
  const batchSize = 500;
  const groups = new Map();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join('|');
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(row);
  }
  let batchNo = 0;
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.length; offset += batchSize) {
      batchNo += 1;
      const batch = group.slice(offset, offset + batchSize);
      const result = await api.create({ table, rows: batch, ...auth });
      if (!result.ok) {
        const reason = result.message || result.error || '接口写入失败';
        throw new Error(`${table} 第${batchNo}批失败（已成功提交${submitted}行）：${reason}`);
      }
      submitted += Number(result.data?.submittedRows ?? batch.length);
      affected += Number(result.data?.affectedRows ?? 0);
    }
  }
  return { submitted, affected };
}

async function confirmApply() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question('确认开始向后端写入这四张表？请输入“写入”继续：')).trim();
    return answer === '写入';
  } finally {
    rl.close();
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: node source_import.js [--data-dir Excel目录] [--apply] [--account admin]');
    console.log('默认只做本地解析和统计；写入须显式 --apply 并输入“写入”确认。凭证使用 PEIXIAOE_CREDENTIAL 或 scripts/config.js。');
    return;
  }

  const source = loadSourceData(options.dataDir);
  console.log('[培小e] 源Excel校验通过（仅显示行数，不显示人员信息）：');
  for (const { key } of SOURCE_TABLES) console.log(`  ${key}: ${source.counts[key]} 行`);

  if (!options.apply) {
    console.log('[培小e] 当前为预览模式；未调用后端写接口。确认后加 --apply 执行。');
    return;
  }

  const auth = {
    account: options.account || process.env.PEIXIAOE_ACCOUNT || CFG.admin.account,
    credential: process.env.PEIXIAOE_CREDENTIAL || CFG.admin.credential,
  };
  if (String(auth.account).toLowerCase() !== 'admin') {
    throw new Error('整套源Excel包含全省人员、计划和名额，只允许管理员账号执行。');
  }
  if (!auth.credential) throw new Error('缺少管理员凭证；请使用 PEIXIAOE_CREDENTIAL 或既有配置。');
  if (!(await confirmApply())) {
    console.log('[培小e] 用户取消，未写入。');
    return;
  }

  const data = source.tables;
  const results = [];
  const leaderRows = withoutMockFields(data.pxe_leader_info, 'leader_id');
  results.push({ table: CFG.tables.leader, ...(await writeBatches(CFG.tables.leader, leaderRows, auth)) });

  const planRows = withoutMockFields(data.pxe_training_plan, 'plan_id');
  results.push({ table: CFG.tables.plan, ...(await writeBatches(CFG.tables.plan, planRows, auth)) });

  // 名额和记录使用数据库实际 plan_id；不把本地Mock的计划主键提交到后端。
  const actualPlanIds = await queryActualPlanIds(data.pxe_training_plan, auth);
  const mockPlanKeys = new Map(data.pxe_training_plan.map(row => [row.plan_id, planKey(row)]));
  const resolvePlanId = row => {
    const key = mockPlanKeys.get(row.plan_id);
    const id = actualPlanIds.get(key);
    if (id === undefined || id === null) throw new Error('无法为名额或培训记录关联数据库计划ID，已停止后续写入。');
    return id;
  };

  const quotaRows = withoutMockFields(data.pxe_quota_alloc, 'quota_id').map(row => ({ ...row, plan_id: resolvePlanId(row) }));
  results.push({ table: CFG.tables.quota, ...(await writeBatches(CFG.tables.quota, quotaRows, auth)) });

  const recordRows = withoutMockFields(data.pxe_train_record, 'record_id').map(row => ({ ...row, plan_id: resolvePlanId(row) }));
  results.push({ table: CFG.tables.record, ...(await writeBatches(CFG.tables.record, recordRows, auth)) });

  console.log('[培小e] 四张表写入完成（接口按业务唯一键新增或更新）：');
  for (const item of results) {
    console.log(`  ${item.table}: 提交${item.submitted}行，接口报告影响${item.affected}行`);
  }
}

run().catch(error => {
  console.error(`[培小e] 源Excel导入失败：${error.message}`);
  console.error('[培小e] 多批次导入不是单一事务；失败时前序成功批次不会自动回滚，可按相同源文件安全重试。');
  process.exitCode = 1;
});
