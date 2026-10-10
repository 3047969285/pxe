// =====================================================
// data_maint.js —— 培小e 数据维护模块
// Excel → JSON → API 操作（导入/更新/删除）
// 交互式输入账号密码，明确结果回显
// =====================================================
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline/promises');
const CFG = require('./config');
const api = require('./train_api');

// Python 桥接脚本路径
const PARSER = path.join(__dirname, 'excel_parser.py');

// 可维护的四张表（含中文名提示）
const TABLE_NAMES = {
  leader: { table: CFG.tables.leader, label: '人员信息' },
  plan: { table: CFG.tables.plan, label: '培训计划' },
  quota: { table: CFG.tables.quota, label: '单位名额' },
  record: { table: CFG.tables.record, label: '培训记录' },
};

// =========================================
// 1. 交互式输入账号密码
//   解析优先级：命令行参数(env注入) > 配置默认 > 交互输入
// =========================================
async function promptCredentials(rl, skipPrompt) {
  const envAccount = process.env.PEIXIAOE_ACCOUNT || '';
  const envCred = process.env.PEIXIAOE_CREDENTIAL || '';

  // 命令行已提供完整身份 → 直接使用
  if (envAccount && envCred) {
    return { account: envAccount.trim(), credential: envCred.trim() };
  }
  // 命令行提供账号但缺凭证 + 配置有管理员密码 → 用管理员密码补全
  if (envAccount && CFG.admin.credential) {
    return { account: envAccount.trim(), credential: CFG.admin.credential };
  }
  // 非交互模式（skipPrompt）+ 配置有管理员密码 → 用管理员默认
  if (skipPrompt && CFG.admin.credential) {
    return { account: CFG.admin.account, credential: CFG.admin.credential };
  }

  // 交互模式：逐项输入，空值回退
  const account = (await rl.question(`请输入账号（姓名，默认 ${envAccount || CFG.admin.account}）: `)).trim() || envAccount || CFG.admin.account;
  const credential = (await rl.question(`请输入凭证（身份证后四位/管理员密码）: `)).trim() || envCred || CFG.admin.credential;

  return { account, credential };
}

// =========================================
// 2. 自动识别表名（从文件路径名称猜测）
// =========================================
function autoDetectTable(filePath) {
  const lower = path.basename(filePath, path.extname(filePath)).toLowerCase();
  if (lower.includes('参培人员分配表')) return CFG.tables.record;
  if (lower.includes('领导人员信息表')) return CFG.tables.leader;
  if (lower.includes('培训计划表')) return CFG.tables.plan;
  for (const [key, info] of Object.entries(TABLE_NAMES)) {
    if (lower.includes(key) || lower.includes(info.label)) {
      return info.table;
    }
  }
  return null; // 需要用户指定
}

// =========================================
// 3. 调用 Python 解析 Excel
// =========================================
function parseExcel(filePath, tableName) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `文件不存在: ${filePath}` };
  }

  try {
    const stdout = execFileSync('python', [PARSER, filePath, tableName], {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024, // 100MB
    });
    return JSON.parse(stdout);
  } catch (e) {
    // 尝试从 stderr 或 stdout 提取 JSON
    try {
      const data = e.stdout || e.message || '{}';
      const parsed = JSON.parse(data);
      return parsed;
    } catch {
      return {
        ok: false,
        error: `Python 解析失败: ${e.message}`,
        stderr: e.stderr || '',
      };
    }
  }
}

// =========================================
// 4. 显示表头映射（预览）
// =========================================
function showFieldMapPreview(parseResult) {
  const { fieldMap, unmatched } = parseResult;
  console.log('\n📋 字段映射:');
  console.log('  ' + '-'.repeat(40));
  for (const [en, cn] of Object.entries(fieldMap)) {
    console.log(`  ${cn.padEnd(16)} → ${en}`);
  }
  if (unmatched && unmatched.length > 0) {
    console.log(`  ⚠ 未匹配列（将被跳过）: ${unmatched.join(', ')}`);
  }
  console.log('  ' + '-'.repeat(40));
}

// 4.1 显示数据行预览（前几行）
function showDataPreview(rows, maxRows = 3) {
  if (!rows || rows.length === 0) return;
  console.log('\n👀 数据预览（前 ' + Math.min(maxRows, rows.length) + ' 行）:');
  const sample = rows.slice(0, maxRows);
  const allKeys = Array.from(new Set(sample.flatMap(r => Object.keys(r))));
  console.log('  ' + allKeys.join('\t'));
  console.log('  ' + '-'.repeat(60));
  for (const r of sample) {
    const vals = allKeys.map(k => {
      const v = r[k];
      if (v === null || v === undefined) return '';
      if (['id_card', 'emp_id', 'emp_name', 'account', 'credential', 'password'].includes(k)) return '***已遮蔽***';
      return String(v);
    });
    console.log('  ' + vals.join('\t'));
  }
}

// =========================================
// 5. 批量导入（Excel→UPSERT）
//   options.confirm: 是否交互确认后再写库（true=询问；false=直接写）
// =========================================
async function importExcel(filePath, tableName, auth, options = {}) {
  console.log(`\n[培小e] 解析 Excel: ${path.basename(filePath)}`);

  const parsed = parseExcel(filePath, tableName);
  if (!parsed.ok) {
    console.error(`[培小e] 解析失败: ${parsed.error}`);
    return { ok: false, error: parsed.error };
  }

  const rows = parsed.rows;
  if (!rows || rows.length === 0) {
    console.log('[培小e] Excel 中无有效数据行');
    return { ok: true, action: 'skip', reason: 'empty', totalRows: 0 };
  }

  console.log(`[培小e] 识别为表: ${tableName}（${rows.length} 行数据）`);
  showFieldMapPreview(parsed);
  showDataPreview(rows);

  // 交互确认（可选）
  if (options.confirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ans = await rl.question(`\n确认向接口写入 ${rows.length} 行？(y 确认/n 取消): `);
      if (ans.trim().toLowerCase() !== 'y') {
        console.log('[培小e] 已取消导入');
        return { ok: true, action: 'cancelled', totalRows: rows.length };
      }
    } finally {
      rl.close();
    }
  }

  // 分批提交（每批最多 500 条）
  const batchSize = 500;
  let totalAffected = 0;
  let totalSubmitted = 0;
  let hasError = false;

  // 空单元格不会生成字段，按字段集合拆批以符合接口“每批字段一致”的要求。
  const groups = new Map();
  for (const row of rows) {
    const shape = Object.keys(row).sort().join('|');
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(row);
  }
  let batchNo = 0;
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += batchSize) {
      const batch = group.slice(i, i + batchSize);
      batchNo += 1;
      console.log(`[培小e] 正在写入第 ${batchNo} 批（${batch.length} 行）...`);

      const result = await api.create({
        table: tableName,
        rows: batch,
        account: auth.account,
        credential: auth.credential,
      });

      if (result.ok) {
        const submitted = Number(result.data?.submittedRows ?? batch.length);
        const affected = Number(result.data?.affectedRows ?? 0);
        totalSubmitted += submitted;
        totalAffected += affected;
        console.log(`  ✅ 提交 ${submitted} 行，影响 ${affected} 行`);
      } else {
        hasError = true;
        console.error(`  ❌ 写入失败: ${result.message || result.error}`);
        console.error(`  HTTP状态: ${result.httpStatus || '-'}, 错误码: ${result.code || '-'}`);
        break;
      }
    }
    if (hasError) break;
  }

  const summary = {
    ok: !hasError,
    action: 'import',
    table: tableName,
    totalRows: rows.length,
    submitted: totalSubmitted,
    affected: totalAffected,
    hasError,
  };

  console.log(`\n[培小e] 导入完成: 共 ${rows.length} 行`);
  console.log(`  📥 提交 ${totalSubmitted} 行`);
  console.log(`  💾 影响 ${totalAffected} 行`);
  if (hasError) console.log(`  ⚠ 部分批次写入失败，请检查上面的错误`);

  return summary;
}

// =========================================
// 6. 按主键修改
// =========================================
async function updateRecord(tableName, primaryKey, pkValue, updates, auth) {
  console.log(`\n[培小e] 修改 ${tableName} 中 ${primaryKey}=${pkValue} 的记录`);

  const result = await api.update({
    table: tableName,
    filters: [{ field: primaryKey, operator: 'EQ', value: pkValue }],
    values: updates,
    account: auth.account,
    credential: auth.credential,
  });

  if (result.ok) {
    console.log(`  ✅ 修改成功`);
    console.log(`  受影响行: ${result.data?.affectedRows || 1}`);
  } else {
    console.error(`  ❌ 修改失败: ${result.message || result.error}`);
  }

  return result;
}

// =========================================
// 7. 软删除
// =========================================
async function deleteRecord(tableName, primaryKey, pkValue, auth) {
  console.log(`\n[培小e] 删除 ${tableName} 中 ${primaryKey}=${pkValue} 的记录`);

  const result = await api.del({
    table: tableName,
    filters: [{ field: primaryKey, operator: 'EQ', value: pkValue }],
    account: auth.account,
    credential: auth.credential,
  });

  if (result.ok) {
    console.log(`  ✅ 删除成功`);
  } else {
    console.error(`  ❌ 删除失败: ${result.message || result.error}`);
  }

  return result;
}

// 检查接口是否已配置（给出可读性提示）
function checkApiReady() {
  if (!CFG.api.baseUrl || CFG.api.baseUrl.includes('localhost') || CFG.api.baseUrl.includes('127.0.0.1')) {
    return false;
  }
  return true;
}

// =========================================
// 8. 交互式维护主流程
//   preFilePath: 命令行预传入的 Excel 路径（可跳过文件输入步骤）
//   preAuth: 命令行预传入的认证信息 {account, credential}（可跳过凭证输入）
// =========================================
async function interactiveMaintenance(preFilePath, preAuth = null) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('╔══════════════════════════════════════╗');
    console.log('║      培小e · 数据维护终端             ║');
    console.log('╚══════════════════════════════════════╝');

    // 接口配置提醒
    if (!checkApiReady()) {
      console.log('\n⚠ 提示: 未检测到后端接口地址（config.js 的 api.baseUrl）');
      console.log('  当前为示例地址 localhost:7529，写入将会失败。');
      console.log('  请先在 scripts/config.js 填入：baseUrl、apiSecret。\n');
    }

    // 凭证输入（允许 CLI 预传入跳过交互式）
    const auth = preAuth || await promptCredentials(rl, false);
    if (!auth.account || !auth.credential) {
      console.error('[培小e] 账号和凭证不能为空');
      return { ok: false, error: 'MISSING_CREDENTIALS' };
    }

    console.log(`  账号: ${String(auth.account).toLowerCase() === 'admin' ? 'admin' : '普通用户（已隐藏）'}`);
    console.log(`  凭证: ${'*'.repeat(auth.credential.length)}\n`);

    // 操作选择
    console.log('可选操作:');
    console.log('  1) 导入 Excel（新增/更新数据）');
    console.log('  2) 修改记录（按主键更新字段）');
    console.log('  3) 删除记录（软删除）');
    console.log('  q) 退出\n');

    const choice = await rl.question('请选择操作 (1/2/3/q): ');
    const choiceTrimmed = choice.trim().toLowerCase();

    if (choiceTrimmed === 'q') {
      console.log('[培小e] 已退出');
      return { ok: true, action: 'exit' };
    }

    if (choiceTrimmed === '1') {
      // 导入 Excel（支持命令行预传入路径）
      let trimmedPath = '';
      if (preFilePath) {
        trimmedPath = preFilePath;
        console.log(`[培小e] 使用命令行指定文件: ${trimmedPath}`);
      } else {
        const filePath = await rl.question('请输入 Excel 文件路径（可直接拖入文件）: ');
        trimmedPath = filePath.trim();
      }

      if (!fs.existsSync(trimmedPath)) {
        console.error(`[培小e] 文件不存在: ${trimmedPath}`);
        // 尝试解析引号包裹的拖入路径
        const unquoted = trimmedPath.replace(/^"|"$/g, '');
        if (unquoted !== trimmedPath && fs.existsSync(unquoted)) {
          trimmedPath = unquoted;
          console.log(`[培小e] 已去除引号: ${trimmedPath}`);
        } else {
          return { ok: false, error: 'FILE_NOT_FOUND' };
        }
      }

      // 自动或手动指定表名
      let table = autoDetectTable(trimmedPath);
      if (!table) {
        console.log('\n可选表:');
        for (const [key, info] of Object.entries(TABLE_NAMES)) {
          console.log(`  ${key}: ${info.label}（${info.table}）`);
        }
        const tableKey = (await rl.question('请输入表名 (leader/plan/quota/record): ')).trim().toLowerCase();
        table = TABLE_NAMES[tableKey]?.table;
        if (!table) {
          console.error(`[培小e] 无效表名: ${tableKey}`);
          return { ok: false, error: 'INVALID_TABLE' };
        }
      } else {
        console.log(`[培小e] 自动识别表: ${table}`);
      }

      return await importExcel(trimmedPath, table, auth, { confirm: true });

    } else if (choiceTrimmed === '2') {
      // 修改记录
      console.log('\n可选表:');
      for (const [key, info] of Object.entries(TABLE_NAMES)) {
        console.log(`  ${key}: ${info.label}（主键: ${getPrimaryKey(info.table)}）`);
      }
      const tableKey = (await rl.question('请输入表名: ')).trim().toLowerCase();
      const table = TABLE_NAMES[tableKey]?.table;
      if (!table) { console.error(`无效表名`); return { ok: false, error: 'INVALID_TABLE' }; }

      const pk = getPrimaryKey(table);
      const pkVal = await rl.question(`请输入 ${pk} 值: `);
      console.log('请输入要修改的字段（每行一个，空行结束）:');
      const updates = {};
      while (true) {
        const line = await rl.question('  field=value: ');
        if (!line.trim()) break;
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          updates[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }
      return await updateRecord(table, pk, pkVal, updates, auth);

    } else if (choiceTrimmed === '3') {
      // 删除记录
      console.log('\n可选表:');
      for (const [key, info] of Object.entries(TABLE_NAMES)) {
        console.log(`  ${key}: ${info.label}（主键: ${getPrimaryKey(info.table)}）`);
      }
      const tableKey = (await rl.question('请输入表名: ')).trim().toLowerCase();
      const table = TABLE_NAMES[tableKey]?.table;
      if (!table) { console.error(`无效表名`); return { ok: false, error: 'INVALID_TABLE' }; }

      const pk = getPrimaryKey(table);
      const pkVal = await rl.question(`请输入要删除的 ${pk} 值: `);
      const confirm = await rl.question(`确认删除 ${table} 中 ${pk}=${pkVal}？(y/n): `);
      if (confirm.trim().toLowerCase() !== 'y') {
        console.log('[培小e] 已取消删除');
        return { ok: true, action: 'cancelled' };
      }
      return await deleteRecord(table, pk, pkVal, auth);

    } else {
      console.error(`[培小e] 无效选项: ${choiceTrimmed}`);
      return { ok: false, error: 'INVALID_CHOICE' };
    }

  } finally {
    rl.close();
  }
}

function getPrimaryKey(tableName) {
  const pkMap = {
    [CFG.tables.leader]: 'leader_id',
    [CFG.tables.plan]: 'plan_id',
    [CFG.tables.quota]: 'quota_id',
    [CFG.tables.record]: 'record_id',
  };
  return pkMap[tableName] || 'id';
}

// =========================================
// 非交互式单命令入口（供 index.js 调用）
// =========================================
async function importDirect(filePath, tableName, account, credential, confirm = false) {
  const auth = { account: account || CFG.admin.account, credential: credential || CFG.admin.credential };
  if (!tableName) {
    tableName = autoDetectTable(filePath);
    if (!tableName) {
      return { ok: false, error: '无法自动识别表名，请指定 --table 参数' };
    }
  }
  return await importExcel(filePath, tableName, auth, { confirm });
}

async function updateDirect(tableName, filters, values, account, credential) {
  const auth = { account: account || CFG.admin.account, credential: credential || CFG.admin.credential };
  return await api.update({ table: tableName, filters, values, ...auth });
}

async function deleteDirect(tableName, filters, account, credential) {
  const auth = { account: account || CFG.admin.account, credential: credential || CFG.admin.credential };
  return await api.del({ table: tableName, filters, ...auth });
}

module.exports = {
  interactiveMaintenance,
  importDirect,
  updateDirect,
  deleteDirect,
  parseExcel,
  autoDetectTable,
  promptCredentials,
  checkApiReady,
};
