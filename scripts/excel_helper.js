// =====================================================
// excel_helper.js —— Excel 解析/导出/模板 工具
// 字段映射基于培训数据接口四张表白名单（见 api_contract.md）
// 底层读写由 Python openpyxl 桥接（excel_parser.py）完成
// =====================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('./config');

// Python 桥接脚本路径（excel_parser.py 兼读、写）
const PARSER = path.join(__dirname, 'excel_parser.py');

// =========================================
// 四张表的字段映射：Excel 表头中文 → 后端字段名
// 注：excel_parser.py 中 FIELD_MAPS 才是权威映射，这里仅供模板生成
// 保持两处一致（publish 前 diff 检查）
// =========================================
const FIELD_MAP_LEADER = {
  '序号': 'seq_no', '地区': 'region_name', '单位': 'unit_name', '姓名': 'emp_name',
  '编号': 'emp_id', '身份证号': 'id_card', '性别': 'gender', '年龄': 'age',
  '辅助日期': 'assist_date', '角色': 'b_role', '干部层级': 'cadre_level',
  '职级': 'staff_grade', '是否党委': 'is_party_sec', '2026已训': 'trained_2026',
  '总学时': 'total_hours', '是否生产骨干': 'is_prod_head', '备注': 'remark',
};

const FIELD_MAP_PLAN = {
  '批次': 'batch_id', '计划年份': 'plan_year', '序号': 'seq_no',
  '培训班名称': 'class_name', '期次': 'session_no', '培训周期': 'train_period',
  '开始日期': 'start_date', '结束日期': 'end_date', '培训地点': 'train_place',
  '计划人数': 'plan_count', '培训对象': 'target_group', '规则说明': 'rule_desc',
  '规则键': 'rule_key', '匹配规则': 'matching_rules', '备注': 'remark',
};

const FIELD_MAP_QUOTA = {
  '计划ID': 'plan_id', '单位名称': 'unit_name', '名额数量': 'quota_count', '备注': 'remark',
};

const FIELD_MAP_RECORD = {
  '计划ID': 'plan_id', '人员编号': 'emp_id', '姓名': 'emp_name', '计划年份': 'plan_year',
  '培训班名称': 'class_name', '培训类别': 'class_type', '期次': 'session_no',
  '开始日期': 'start_date', '结束日期': 'end_date', '学时': 'hours',
  '参训时单位': 'unit_at_time', '数据来源': 'data_source', '备注': 'remark',
};

// 表名枚举 → 映射表
const FIELD_MAPS = {
  [CFG.tables.leader]: FIELD_MAP_LEADER,
  [CFG.tables.plan]: FIELD_MAP_PLAN,
  [CFG.tables.quota]: FIELD_MAP_QUOTA,
  [CFG.tables.record]: FIELD_MAP_RECORD,
};

// 导出时必须剔除的敏感字段（全局规范：严禁导出身份证号等）
const SENSITIVE_FIELDS = new Set(['id_card', 'credential']);

// 扫描一个目录下的 Excel 文件
function listInbox(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(xlsx|xls|csv)$/i.test(f))
    .map((f) => path.join(dir, f));
}

// 解析 Excel → 行对象数组（委托 Python）
function parse(filePath, tableName) {
  if (!fs.existsSync(filePath)) return { ok: false, error: `文件不存在: ${filePath}` };
  try {
    const stdout = execFileSync('python', [PARSER, filePath, tableName || 'pxe_train_record'], {
      encoding: 'utf-8',
      maxBuffer: 100 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (e) {
    try {
      const parsed = JSON.parse(e.stdout || e.message || '{}');
      return parsed;
    } catch {
      return { ok: false, error: `Python 解析失败: ${e.message}`, stderr: e.stderr || '' };
    }
  }
}

// 调用 Python 生成 xlsx（--export / --template），返回完整路径
function pyWrite(args) {
  try {
    const stdout = execFileSync('python', [PARSER, ...args], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    try {
      return JSON.parse(e.stdout || e.message || '{}');
    } catch {
      return { ok: false, error: `Python 生成失败: ${e.message}`, stderr: e.stderr || '' };
    }
  }
}

// 数据 → Excel（导出结果）
//   rows: 查询结果行；tableName: 表全名（决定列顺序与字段映射）；filename: 可省略
function exportToExcel(rows, tableName, filename) {
  const safeRows = (rows || []).map(r => {
    const clean = {};
    for (const [k, v] of Object.entries(r || {})) {
      if (!SENSITIVE_FIELDS.has(k)) clean[k] = v;
    }
    return clean;
  });

  // 数据经临时 JSON 传给 Python（避免命令行过长）
  const tmpName = `peixiaoe_export_${Date.now()}.json`;
  const tmpJson = path.join(os.tmpdir(), tmpName);
  fs.writeFileSync(tmpJson, JSON.stringify(safeRows), 'utf-8');

  const name = filename || `培小e导出_${today()}.xlsx`;
  // 绝对路径直接使用；相对路径拼接到输出目录
  const full = path.isAbsolute(name) ? name : path.join(CFG.outDir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  try {
    const res = pyWrite(['--export', tmpJson, full, tableName || 'pxe_train_record']);
    if (!res.ok) throw new Error(res.error);
    console.log(`[培小e] 导出完成: ${full}（${res.totalRows} 行）`);
    return full;
  } finally {
    try { fs.unlinkSync(tmpJson); } catch { /* 清理临时文件 */ }
  }
}

// 生成某表的空录入模板
//   tableName: 表全名；filename: 可省略
function makeTemplate(tableName, filename) {
  const name = filename || `培小e录入模板_${(tableName || 'pxe_train_record').replace(/^pxe_/, '')}.xlsx`;
  const full = path.isAbsolute(name) ? name : path.join(CFG.outDir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  const res = pyWrite(['--template', full, tableName || 'pxe_train_record']);
  if (!res.ok) throw new Error(res.error);
  console.log(`[培小e] 录入模板已生成: ${full}`);
  return full;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

module.exports = {
  listInbox, parse, exportToExcel, makeTemplate,
  FIELD_MAPS,
  FIELD_MAP_LEADER, FIELD_MAP_PLAN, FIELD_MAP_QUOTA, FIELD_MAP_RECORD,
};
