// =====================================================
// train_api.js —— 培小e 培训数据接口客户端
// 对接 4 个真实 JSON 接口（统一 POST）：
//   query  → /api/HuangDao/training/query   分页查询
//   create → /api/HuangDao/training/create  新增或更新 UPSERT
//   update → /api/HuangDao/training/update  按主键修改
//   delete → /api/HuangDao/training/delete  软删除
// 认证：Header Authorization = apiSecret（不加 Bearer）
//       业务身份放在 body.data.account / body.data.credential
// 请求体：{ table, data, rows, filters, columns, pageNum, pageSize, orderBy, orderDirection }
// =====================================================
const CFG = require('./config');
const { resolveField } = require('./field_map');

// 短表名（含中文名）转数据库表名
const TABLE_ALIAS = {
  leader: 'pxe_leader_info', '人员': 'pxe_leader_info', '人员信息': 'pxe_leader_info',
  '领导人员信息': 'pxe_leader_info',
  plan: 'pxe_training_plan', '计划': 'pxe_training_plan', '培训计划': 'pxe_training_plan',
  quota: 'pxe_quota_alloc', '名额': 'pxe_quota_alloc', '名额分配': 'pxe_quota_alloc',
  record: 'pxe_train_record', '记录': 'pxe_train_record', '培训记录': 'pxe_train_record',
  rule: 'pxe_training_rule', '规则': 'pxe_training_rule', '通用规则': 'pxe_training_rule',
};

function normalizeTable(table) {
  const key = table ? String(table).trim() : '';
  if (CFG.tables[key]) {
    return CFG.tables[key];
  }
  if (TABLE_ALIAS[key]) {
    return TABLE_ALIAS[key];
  }
  return key || CFG.tables.record;
}

// 构建身份字段（并入 data）
function buildAuth(account, credential) {
  return {
    account: account || CFG.admin.account || 'admin',
    credential: credential || CFG.admin.credential || '',
  };
}

// 统一请求封装
async function request(action, body) {
  const baseUrl = CFG.api.baseUrl;
  const apiSecret = CFG.api.apiSecret;

  if (!baseUrl) {
    console.error('[培小e] 接口地址未配置：请到 scripts/config.js 设置 api.baseUrl');
    return { ok: false, error: 'API_NOT_CONFIGURED' };
  }
  if (!apiSecret) {
    console.error('[培小e] apiSecret 未配置：请到 scripts/config.js 设置 api.apiSecret');
    console.error(`[培小e] 未发送请求（操作=${action}，表=${body.table || '-'}）`);
    return { ok: false, error: 'API_SECRET_NOT_CONFIGURED' };
  }

  const url = `${baseUrl}/${action}`;
  const timeoutMs = CFG.api.timeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiSecret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: resp.status, code: -1, message: `响应非 JSON: ${text.slice(0, 200)}`, raw: text };
    }
    // 业务失败判定：HTTP 非 2xx 或业务 code 非 0
    const success = resp.ok && (json.code === 0 || json.code === '0' || json.code === undefined || json.code === null);
    if (!success) {
      return { ok: false, httpStatus: resp.status, code: json.code, message: json.message, raw: json };
    }
    return { ok: true, code: json.code, data: json.data, message: json.message, raw: json };
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) {
      return { ok: false, error: `请求超时(${timeoutMs}ms): ${url}`, timedOut: true };
    }
    return { ok: false, error: e.message, cause: e.cause?.message || '' };
  } finally {
    clearTimeout(timer);
  }
}

// 组装请求体（字段名统一归一化为后端字段）
function buildBody(action, options) {
  const table = normalizeTable(options.table);
  const body = {
    table,
    data: Object.assign({}, options.data || {}, buildAuth(options.account, options.credential)),
  };
  if (options.filters) {
    body.filters = options.filters.map(item => Object.assign({}, item, { field: resolveField(table, item.field) }));
  }
  if (options.columns) {
    body.columns = options.columns.map(column => resolveField(table, column));
  }
  if (action === 'query') {
    body.pageNum = options.pageNum || 1;
    body.pageSize = options.pageSize || 20;
    if (options.orderBy) body.orderBy = resolveField(table, options.orderBy);
    if (options.orderDirection) body.orderDirection = options.orderDirection;
  }
  if (action !== 'query' && action !== 'delete') {
    const auth = buildAuth(options.account, options.credential);
    if (options.rows && options.rows.length) {
      // 批量写入：数据放 rows 并逐行携带身份，移除 data 避免被判成“单条 + 批量”同时提交
      delete body.data;
      body.rows = options.rows.map(row => Object.assign({}, row, auth));
    } else if (options.single) {
      body.data = Object.assign({}, options.single, auth);
    }
  }
  return body;
}

// 分页查询
//   options: { table, data（实体字段条件）, filters, columns, pageNum, pageSize, orderBy, orderDirection, account, credential }
async function query(options = {}) {
  const body = buildBody('query', options);
  const result = await request('query', body);
  if (result.ok && result.data) {
    result.rows = result.data.rows || [];
    result.total = result.data.total || 0;
    result.pageNum = result.data.pageNum || body.pageNum;
    result.pageSize = result.data.pageSize || body.pageSize;
  }
  return result;
}

// 新增或更新（UPSERT）
//   options: { table, single（单条实体）| rows（批量实体数组，最多500条）, account, credential }
async function create(options = {}) {
  return await request('create', buildBody('create', options));
}

// 修改（按主键 EQ 定位，只更新提交的字段）
//   options: { table, single（含主键的实体）, account, credential }
async function update(options = {}) {
  return await request('update', buildBody('update', options));
}

// 软删除（del_flag=2）
//   options: { table, single（含主键的实体）, account, credential }
async function del(options = {}) {
  return await request('delete', buildBody('delete', options));
}

// 快捷工具：获取某表全部数据（自动翻页）
//   先取第 1 页拿到总数，其余页并发拉取（最多 4 路），结果按页序拼接，顺序与逐页拉取一致；
//   后端没回总数时退回逐页拉取。
const PAGE_SIZE = 500;
const PAGE_CONCURRENCY = 4;

async function queryAll(table, data = {}, account, credential) {
  const fetchPage = pageNum => query({ table, data, pageNum, pageSize: PAGE_SIZE, account, credential });
  const first = await fetchPage(1);
  if (!first.ok) return first;
  const allRows = [...(first.rows || [])];
  if (allRows.length < PAGE_SIZE) {
    return { ok: true, rows: allRows, total: allRows.length };
  }

  const total = Number(first.total) || 0;
  if (total > allRows.length) {
    const pages = [];
    for (let page = 2; page <= Math.ceil(total / PAGE_SIZE); page++) pages.push(page);
    const results = new Array(pages.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < pages.length) {
        const index = cursor++;
        results[index] = await fetchPage(pages[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pages.length) }, worker));
    for (const r of results) {
      if (!r.ok) return r;
      allRows.push(...(r.rows || []));
    }
    // 拉取期间若有新增数据，补拉尾页
    let page = pages.length + 2;
    let last = results[results.length - 1];
    while (last && (last.rows || []).length === PAGE_SIZE) {
      last = await fetchPage(page++);
      if (!last.ok) return last;
      allRows.push(...(last.rows || []));
    }
    return { ok: true, rows: allRows, total: allRows.length };
  }

  let page = 2;
  while (true) {
    const r = await fetchPage(page++);
    if (!r.ok) return r;
    const rows = r.rows || [];
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return { ok: true, rows: allRows, total: allRows.length };
}

module.exports = { query, create, update, del, queryAll, buildAuth, normalizeTable };
