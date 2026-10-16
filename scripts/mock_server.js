#!/usr/bin/env node
// =====================================================
// mock_server.js —— 培小e Mock 后端（内存虚拟数据）
// 复刻真实后端 4 个 API 的行为，用于全链路联调
// 用法: node mock_server.js [端口号]
// 默认端口 7529（与 config.js baseUrl 一致）
//
// 与 train_api.js 新协议对齐：
//   认证：Header Authorization = apiSecret；业务身份在 body.data.account/credential，
//         批量写在 body.rows[] 每行携带 account/credential
//   字段：五张表全部驼峰命名（planId/className/empId/unitName/delFlag...）
//   写操作响应：data 直接返回受影响行数（数字）
// =====================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const CFG = require('./config');

const PORT = parseInt(process.argv[2], 10) || 7529;
const API_SECRET = CFG.api.apiSecret || 'Tcm@950t';
const ADMIN_CRED = CFG.admin.credential || 'Tcm@950t';

// ---- 内存数据存储 ----
let pkSeq = { leaderId: 100, planId: 50, quotaId: 200, recordId: 500, ruleId: 10 };
const TABLES = {};

// 各表自增主键字段
const PK_FIELD = {
  pxe_leader_info: 'leaderId',
  pxe_training_plan: 'planId',
  pxe_quota_alloc: 'quotaId',
  pxe_train_record: 'recordId',
  pxe_training_rule: 'ruleId',
};

// 写入时不允许被业务覆盖的系统字段（主键不算，主键在 update/delete 里是指定位置的身份）
const SYSTEM_FIELDS = ['guid', 'delFlag', 'createTime', 'updateTime'];

// ============================
// 虚拟种子数据（由 excel_loader.py 直接从桌面 Excel 读取，5 张表）
// ============================
function seedData() {
  const loaderScript = path.join(__dirname, 'excel_loader.py');
  if (!fs.existsSync(loaderScript)) {
    console.error(`[培小e Mock] 找不到 excel_loader.py: ${loaderScript}`);
    process.exit(1);
  }

  try {
    const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    const stdout = execFileSync('python', [loaderScript], {
      encoding: 'utf-8',
      maxBuffer: 500 * 1024 * 1024,
      env,
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
    TABLES.pxe_training_rule = tables.pxe_training_rule || [];

    const counts = result.counts || {};
    console.log(`[培小e Mock] Excel数据已加载:`);
    console.log(`    人员: ${counts.pxe_leader_info || 0} 人`);
    console.log(`    计划: ${counts.pxe_training_plan || 0} 个 (2027年度)`);
    console.log(`    名额: ${counts.pxe_quota_alloc || 0} 条`);
    console.log(`    记录: ${counts.pxe_train_record || 0} 条`);
    console.log(`    规则: ${counts.pxe_training_rule || 0} 条`);

    // 主键自增起点
    const maxId = (rows, key) => rows.reduce((m, r) => Math.max(m, Number(r[key]) || 0), 0);
    pkSeq.leaderId = maxId(TABLES.pxe_leader_info, 'leaderId');
    pkSeq.planId = maxId(TABLES.pxe_training_plan, 'planId');
    pkSeq.quotaId = maxId(TABLES.pxe_quota_alloc, 'quotaId');
    pkSeq.recordId = maxId(TABLES.pxe_train_record, 'recordId');
    pkSeq.ruleId = maxId(TABLES.pxe_training_rule, 'ruleId');
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
    case 'pxe_leader_info': return ['empId'];
    case 'pxe_training_plan': return ['planYear', 'className', 'sessionNo'];
    case 'pxe_quota_alloc': return ['planId', 'unitName'];
    case 'pxe_train_record': return ['empId', 'planYear', 'className', 'sessionNo'];
    case 'pxe_training_rule': return ['ruleName'];
    default: return [];
  }
}

function matchBusinessKey(row, existing, keys) {
  return keys.every(k => String(row[k] ?? '') === String(existing[k] ?? ''));
}

// 从对象里剔除 account/credential 两个身份字段
function stripAuth(obj) {
  const result = Object.assign({}, obj);
  delete result.account;
  delete result.credential;
  return result;
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
// 认证检查（支持 data / rows / 顶层三种携带方式）
// ============================
function authenticate(body, headers) {
  const authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (!authHeader || authHeader !== API_SECRET) {
    return { ok: false, code: 'INVALID_REQUEST', httpStatus: 401, message: 'Authorization 无效' };
  }
  const firstRow = Array.isArray(body.rows) && body.rows.length ? body.rows[0] : null;
  const account = String((body.data && body.data.account) || (firstRow && firstRow.account) || body.account || '').trim();
  const credential = String((body.data && body.data.credential) || (firstRow && firstRow.credential) || body.credential || '').trim();
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
      if (String(p.empName) !== account) return false;
      if (p.idCard && p.idCard.endsWith(credential)) return true;
      return false;
    });
    if (!found) {
      // 宽松模式：如果config有管理员凭证，允许模拟
      if (credential !== ADMIN_CRED) {
        return { ok: false, code: '40101', httpStatus: 200, message: '普通用户身份校验失败' };
      }
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

  // 默认只返回 delFlag=0 的有效记录
  let filtered = rows.filter(r => r.delFlag === 0 || r.delFlag === undefined);

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

  let inputRows;
  if (Array.isArray(body.rows)) {
    inputRows = body.rows;                       // 批量：每行自带身份
  } else if (body.data && typeof body.data === 'object') {
    inputRows = [body.data];                     // 单条：身份与实体同在 data
  } else if (body.values && typeof body.values === 'object') {
    inputRows = [body.values];                   // 兼容旧格式
  } else {
    inputRows = [];
  }
  if (inputRows.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '无数据行', data: null };
  }
  if (inputRows.length > 500) {
    return { ok: false, code: '40000', httpStatus: 200, message: '批量最多 500 行', data: null };
  }

  let affectedRows = 0;

  for (const rawRow of inputRows) {
    const row = stripAuth(rawRow);
    // 查找已有记录（按业务键）
    let foundIdx = -1;
    if (bizKeys.length > 0) {
      foundIdx = rows.findIndex(r =>
        (r.delFlag === 0 || r.delFlag === undefined) &&
        matchBusinessKey(row, r, bizKeys)
      );
    }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    if (foundIdx >= 0) {
      // 更新已有记录（保留主键和系统字段）
      const existing = rows[foundIdx];
      for (const [k, v] of Object.entries(row)) {
        if (!SYSTEM_FIELDS.includes(k)) {
          existing[k] = v;
        }
      }
      existing.updateTime = now;
      affectedRows++;
    } else {
      // 新增
      const pk = PK_FIELD[table] || 'id';
      pkSeq[pk] = (pkSeq[pk] || 100) + 1;
      const newRow = {
        [pk]: pkSeq[pk],
        guid: genGuid(),
        delFlag: 0,
        createTime: now,
        updateTime: now,
        ...row,
      };
      rows.push(newRow);
      affectedRows++;
    }
  }

  return {
    ok: true,
    code: 0,
    data: affectedRows,
    message: 'ok',
  };
}

// ---- 修改（按主键 EQ 定位，只更新提交的字段）----
function handleUpdate(body, table) {
  const rows = TABLES[table];
  const data = stripAuth(body.data || {});
  const fields = Object.keys(data).filter(k => !SYSTEM_FIELDS.includes(k));
  if (fields.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '修改必须提供待更新字段', data: null };
  }

  // 主键值（如 recordId=100）作为定位条件
  const pk = PK_FIELD[table];
  const pkValue = data[pk];
  const matchPredicate = pkValue != null
    ? (r => String(r[pk]) === String(pkValue))
    : (r => fields.every(f => String(r[f] ?? '') === String(data[f] ?? '')));

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let affectedRows = 0;

  for (const row of rows) {
    if (!(row.delFlag === 0 || row.delFlag === undefined)) continue;
    if (!matchPredicate(row)) continue;
    for (const f of fields) {
      row[f] = data[f];
    }
    row.updateTime = now;
    affectedRows++;
  }

  return {
    ok: true,
    code: 0,
    data: affectedRows,
    message: 'ok',
  };
}

// ---- 软删除（delFlag=2）----
function handleDelete(body, table) {
  const rows = TABLES[table];
  const data = stripAuth(body.data || {});
  const fields = Object.keys(data).filter(k => !SYSTEM_FIELDS.includes(k));
  if (fields.length === 0) {
    return { ok: false, code: '40000', httpStatus: 200, message: '删除必须提供主键', data: null };
  }

  const pk = PK_FIELD[table];
  const pkValue = data[pk];
  const matchPredicate = pkValue != null
    ? (r => String(r[pk]) === String(pkValue))
    : (r => fields.every(f => String(r[f] ?? '') === String(data[f] ?? '')));

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let affectedRows = 0;

  for (const row of rows) {
    if (!(row.delFlag === 0 || row.delFlag === undefined)) continue;
    if (!matchPredicate(row)) continue;
    row.delFlag = 2;
    row.updateTime = now;
    affectedRows++;
  }

  return {
    ok: true,
    code: 0,
    data: affectedRows,
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
      data: result.data ?? null,
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
  console.log(`    计划: ${TABLES.pxe_training_plan.length} 个 (2027年度)`);
  console.log(`    名额: ${TABLES.pxe_quota_alloc.length} 条`);
  console.log(`    记录: ${TABLES.pxe_train_record.length} 条`);
  console.log(`    规则: ${TABLES.pxe_training_rule.length} 条`);
  console.log(`  ---`);
  console.log(`  按 Ctrl+C 停止`);
});
