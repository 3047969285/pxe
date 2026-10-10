#!/usr/bin/env node
// =====================================================
// mock_server.js —— 培小e Mock 后端（内存虚拟数据）
// 复刻真实后端 4 个 API 的行为，用于全链路联调
// 用法: node mock_server.js [端口号]
// 默认端口 27599
// =====================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const CFG = require('./config');

const PORT = parseInt(process.argv[2], 10) || 27599;
const API_SECRET = CFG.api.apiSecret || 'Tcm@950t';
const ADMIN_CRED = CFG.admin.credential || 'Tcm@950t';

// ---- 内存数据存储 ----
let pkSeq = { leader_id: 100, plan_id: 50, quota_id: 200, record_id: 500 };
const TABLES = {};

// ============================
// 虚拟种子数据（从桌面Excel直接提取，由 excel_loader.py 桥接）
// 固化逻辑：mock_server 启动时自动调用 Python 读 Excel → 构建4张内存表
// ============================
function seedData() {
  const loaderScript = path.join(__dirname, 'excel_loader.py');
  if (!fs.existsSync(loaderScript)) {
    console.error(`[培小e Mock] 找不到 excel_loader.py: ${loaderScript}`);
    process.exit(1);
  }

  try {
    const stdout = execFileSync(process.env.PYTHON || 'python', [loaderScript, '--full'], {
      encoding: 'utf-8',
      maxBuffer: 500 * 1024 * 1024, // 500MB（1665人 × 多字段）
    });
    const result = JSON.parse(stdout);
    if (!result.ok) {
      console.error(`[培小e Mock] 加载Excel数据失败: ${result.error}`);
      process.exit(1);
    }
    const tables = result.tables;
    TABLES.pxe_leader_info = tables.pxe_leader_info || [];
    TABLES.pxe_training_plan = tables.pxe_training_plan || [];
    TABLES.pxe_train_record = tables.pxe_train_record || [];
    TABLES.pxe_quota_alloc = tables.pxe_quota_alloc || [];

    const counts = result.counts || {};
    console.log(`[培小e Mock] Excel数据已加载:`);
    console.log(`    人员: ${counts.pxe_leader_info || 0} 人`);
    console.log(`    计划: ${counts.pxe_training_plan || 0} 个 (2027年度)`);
    console.log(`    名额: ${counts.pxe_quota_alloc || 0} 条`);
    console.log(`    记录: ${counts.pxe_train_record || 0} 条`);

    // 主键自增起点
    const maxId = (rows, key) => rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);
    pkSeq.leader_id = maxId(TABLES.pxe_leader_info, 'leader_id');
    pkSeq.plan_id = maxId(TABLES.pxe_training_plan, 'plan_id');
    pkSeq.quota_id = maxId(TABLES.pxe_quota_alloc, 'quota_id');
    pkSeq.record_id = maxId(TABLES.pxe_train_record, 'record_id');
  } catch (e) {
    console.error(`[培小e Mock] 调用 excel_loader.py 失败:`, e.message);
    if (e.stderr) console.error('  stderr:', e.stderr);
    process.exit(1);
  }
}

// ============================
// 业务主键判定（UPSERT 用）
// ============================
function getBusinessKey(table) {
  switch (table) {
    case 'pxe_leader_info': return ['emp_id'];
    case 'pxe_training_plan': return ['plan_year', 'class_name', 'session_no'];
    case 'pxe_quota_alloc': return ['plan_id', 'unit_name'];
    case 'pxe_train_record': return ['emp_id', 'plan_year', 'class_name', 'session_no'];
    default: return [];
  }
}

function matchBusinessKey(row, existing, keys) {
  return keys.every(k => String(row[k] ?? '') === String(existing[k] ?? ''));
}

// ============================
// 筛选引擎
// ============================
function applyFilters(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(row => {
    return filters.every(f => {
      const val = row[f.field];
      const target = f.value;
      switch (f.operator) {
        case 'EQ': return String(val ?? '') === String(target ?? '');
        case 'NE': return String(val ?? '') !== String(target ?? '');
        case 'GT': return Number(val) > Number(target);
        case 'GE': return Number(val) >= Number(target);
        case 'LT': return Number(val) < Number(target);
        case 'LE': return Number(val) <= Number(target);
        case 'LIKE': return String(val ?? '').includes(String(target ?? ''));
        case 'NOT_LIKE': return !String(val ?? '').includes(String(target ?? ''));
        case 'IN': return Array.isArray(target) && target.some(t => String(val ?? '') === String(t));
        case 'NOT_IN': return Array.isArray(target) && !target.some(t => String(val ?? '') === String(t));
        case 'BETWEEN': return Array.isArray(target) && target.length === 2 && String(val) >= String(target[0]) && String(val) <= String(target[1]);
        case 'IS_NULL': return val === null || val === undefined || val === '';
        case 'IS_NOT_NULL': return val !== null && val !== undefined && val !== '';
        default: return true;
      }
    });
  });
}

// ============================
// 认证检查
// ============================
function authenticate(body, headers) {
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (authHeader !== API_SECRET) {
    return { ok: false, code: 'INVALID_REQUEST', httpStatus: 401, message: 'Authorization 无效' };
  }
  const account = String(body.account || '').trim();
  const credential = String(body.credential || '').trim();
  if (!account) {
    return { ok: false, code: '40000', httpStatus: 200, message: '缺少 account' };
  }
  if (!credential) {
    return { ok: false, code: '40000', httpStatus: 200, message: '缺少 credential' };
  }
  // 管理员身份校验
  if (account.toLowerCase() === 'admin') {
    if (credential !== ADMIN_CRED) {
      return { ok: false, code: '40101', httpStatus: 200, message: '管理层身份校验失败' };
    }
  } else {
    // 普通用户：检查人员表中是否有该姓名+身份证后四位
    const personRows = TABLES.pxe_leader_info || [];
    const found = personRows.some(p => {
      if (String(p.emp_name) !== account) return false;
      if (p.id_card && p.id_card.endsWith(credential)) return true;
      return false;
    });
    if (!found) {
      const hasIdentityColumn = personRows.some(p => p.id_card);
      const message = hasIdentityColumn
        ? '普通用户身份校验失败'
        : '当前测试人员表没有身份证号，无法验证普通用户身份';
      return { ok: false, code: '40101', httpStatus: 200, message };
    }
  }
  return { ok: true };
}

// ============================
// 分布式 ID（模拟）
// ============================
let guidCounter = 1000;
function genGuid() { return `guid-${++guidCounter}-${Date.now()}`; }

// ============================
// 请求分发
// ============================
async function handleRequest(method, body, headers) {
  // 认证
  const auth = authenticate(body, headers);
  if (!auth.ok) return auth;

  const table = String(body.table || '').trim();
  if (!table || !TABLES[table]) {
    return { ok: false, code: '40000', httpStatus: 200, message: `无效表名: ${table}`, data: null };
  }

  switch (method) {
    case 'query': return handleQuery(body, table);
    case 'create': return handleCreate(body, table);
    case 'update': return handleUpdate(body, table);
    case 'delete': return handleDelete(body, table);
    default:
      return { ok: false, code: '40000', httpStatus: 200, message: `未知操作: ${method}` };
  }
}

// ---- 查询 ----
function handleQuery(body, table) {
  const rows = TABLES[table];

  // 默认只返回 del_flag=0 的有效记录
  let filtered = rows.filter(r => r.del_flag === 0 || r.del_flag === undefined);

  // 筛选条件
  if (body.filters && Array.isArray(body.filters)) {
    filtered = applyFilters(filtered, body.filters);
  }

  // 排序
  const orderBy = body.orderBy || '';
  const orderDir = (body.orderDirection || 'ASC').toUpperCase();
  if (orderBy) {
    filtered.sort((a, b) => {
      const va = a[orderBy], vb = b[orderBy];
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return orderDir === 'DESC' ? -cmp : cmp;
    });
  }

  // 列选择
  let cols = body.columns;
  let projected = filtered;
  if (cols && Array.isArray(cols) && cols.length > 0) {
    projected = filtered.map(r => {
      const obj = {};
      for (const c of cols) obj[c] = r[c];
      return obj;
    });
  }

  // 分页
  const total = projected.length;
  const pageNum = body.pageNum || 1;
  const pageSize = body.pageSize || 20;
  const start = (pageNum - 1) * pageSize;
  const paged = projected.slice(start, start + pageSize);

  return {
    ok: true,
    code: 0,
    data: { rows: paged, total, pageNum, pageSize },
    message: 'ok',
  };
}

// ---- 新增/更新 UPSERT ----
function handleCreate(body, table) {
  const rows = TABLES[table];
  const bizKeys = getBusinessKey(table);

  const inputRows = body.rows || (body.values ? [body.values] : []);
  if (inputRows.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '无数据行', data: null };
  }
  if (inputRows.length > 500) {
    return { ok: false, code: '40000', httpStatus: 200, message: '批量最多 500 行', data: null };
  }

  let affectedRows = 0;
  let submittedRows = inputRows.length;

  for (const row of inputRows) {
    // 查找已有记录（按业务键）
    let foundIdx = -1;
    if (bizKeys.length > 0) {
      foundIdx = rows.findIndex(r =>
        (r.del_flag === 0 || r.del_flag === undefined) &&
        matchBusinessKey(row, r, bizKeys)
      );
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    if (foundIdx >= 0) {
      // 更新已有记录（保留主键和系统字段）
      const existing = rows[foundIdx];
      for (const [k, v] of Object.entries(row)) {
        if (!['leader_id', 'plan_id', 'quota_id', 'record_id', 'guid', 'del_flag', 'created_at'].includes(k)) {
          existing[k] = v;
        }
      }
      existing.updated_at = now;
      affectedRows++;
    } else {
      // 新增
      const pkMap = { pxe_leader_info: 'leader_id', pxe_training_plan: 'plan_id', pxe_quota_alloc: 'quota_id', pxe_train_record: 'record_id' };
      const pk = pkMap[table] || 'id';
      pkSeq[pk] = (pkSeq[pk] || 100) + 1;
      const newRow = {
        [pk]: pkSeq[pk],
        guid: genGuid(),
        del_flag: 0,
        created_at: now,
        updated_at: now,
        ...row,
      };
      rows.push(newRow);
      affectedRows++;
    }
  }

  return {
    ok: true,
    code: 0,
    data: { table, action: 'UPSERT', submittedRows, affectedRows, success: true },
    message: 'ok',
  };
}

// ---- 修改 ----
function handleUpdate(body, table) {
  const rows = TABLES[table];
  if (!body.filters || !Array.isArray(body.filters) || body.filters.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '修改必须提供 filters（含主键 EQ）', data: null };
  }
  if (!body.values || typeof body.values !== 'object') {
    return { ok: false, code: '40000', httpStatus: 200, message: '修改必须提供 values', data: null };
  }

  const filtered = applyFilters(rows.filter(r => r.del_flag === 0 || r.del_flag === undefined), body.filters);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let affectedRows = 0;

  for (const row of filtered) {
    for (const [k, v] of Object.entries(body.values)) {
      if (!['leader_id', 'plan_id', 'quota_id', 'record_id', 'guid', 'del_flag', 'created_at'].includes(k)) {
        row[k] = v;
      }
    }
    row.updated_at = now;
    affectedRows++;
  }

  return {
    ok: true,
    code: 0,
    data: { table, action: 'UPDATE', affectedRows, success: true },
    message: 'ok',
  };
}

// ---- 软删除 ----
function handleDelete(body, table) {
  const rows = TABLES[table];
  if (!body.filters || !Array.isArray(body.filters) || body.filters.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '删除必须提供 filters（含主键 EQ）', data: null };
  }

  const filtered = applyFilters(rows.filter(r => r.del_flag === 0 || r.del_flag === undefined), body.filters);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let affectedRows = 0;

  for (const row of filtered) {
    row.del_flag = 2;
    row.updated_at = now;
    affectedRows++;
  }

  return {
    ok: true,
    code: 0,
    data: { table, action: 'DELETE', affectedRows, success: true },
    message: 'ok',
  };
}

// ============================
// HTTP Server
// ============================
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ code: -1, message: '仅支持 POST' }));
    return;
  }

  const url = req.url || '';
  let method = '';

  // 匹配 /api/HuangDao/training/{query,create,update,delete}
  const m = url.match(/\/api\/HuangDao\/training\/(query|create|update|delete)$/i);
  if (m) {
    method = m[1].toLowerCase();
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ code: -1, message: `未知路径: ${url}` }));
    return;
  }

  // 读取 body
  let bodyRaw = '';
  req.on('data', chunk => { bodyRaw += chunk; });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(bodyRaw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ code: -1, message: '请求体非 JSON' }));
      return;
    }

    const result = await handleRequest(method, body, req.headers);

    const httpStatus = result.httpStatus || 200;
    const respBody = {
      code: result.code ?? (result.ok ? 0 : -1),
      data: result.data || null,
      message: result.message || (result.ok ? 'ok' : 'error'),
    };

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(respBody));
  });
});

// ============================
// 启动
// ============================
seedData();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[培小e Mock] 后端服务已启动`);
  console.log(`  地址: http://127.0.0.1:${PORT}/api/HuangDao/training`);
  console.log(`  密钥: ${API_SECRET}`);
  console.log(`  管理员: admin / ${ADMIN_CRED}`);
  console.log(`  ---`);
  console.log(`  种子数据:`);
  console.log(`    人员: ${TABLES.pxe_leader_info.length} 人`);
  console.log(`    计划: ${TABLES.pxe_training_plan.length} 个 (2026年度: ${TABLES.pxe_training_plan.filter(p => p.plan_year === 2026).length} 个)`);
  console.log(`    名额: ${TABLES.pxe_quota_alloc.length} 条`);
  console.log(`    记录: ${TABLES.pxe_train_record.length} 条`);
  console.log(`  ---`);
  console.log(`  按 Ctrl+C 停止`);
});
