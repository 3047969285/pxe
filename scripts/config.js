// =====================================================
// 培小e 配置文件 —— 内网部署时只需要改这里
//
// 技能包与后端不在同一台机器，二者只有 HTTP 接口这一条通道：
//   技能本身不连数据库、不执行 SQL、不读写后端文件。
//
// 账号、密码、接口密钥一律不写在本文件（本文件会上传到仓库），只从本机读取：
//   1. 环境变量 PXE_API_SECRET / PXE_ADMIN_ACCOUNT / PXE_ADMIN_CREDENTIAL / PXE_API_BASE_URL
//   2. scripts/config.local.json（已在 .gitignore 中，不会上传；格式见 config.local.example.json）
// 环境变量优先。没配置时命令会提示，不会带着空凭据去请求后端。
//
// 校验是否连通：
//   node index.js 查询 rule --每页 1
//   返回数据即为连通；报 "fetch failed" 说明后端地址不通或服务未启动。
// =====================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

// 本机凭据文件（不进仓库）
const LOCAL = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
  } catch (err) {
    return {};
  }
})();
const local = (envName, key) => String(process.env[envName] || LOCAL[key] || '').trim();

const CFG = {
  // ---- 培训数据接口地址（内网部署改这里）----
  api: {
    // 后端地址：本机配置优先，否则用下面的默认地址
    baseUrl: local('PXE_API_BASE_URL', 'baseUrl') || 'http://127.0.0.1:7529/api/HuangDao/training',
    // 其它环境示例（按需替换上面的值）：
    // baseUrl: 'http://10.141.186.82:27529/api/HuangDao/training',
    // baseUrl: 'http://127.0.0.1:27599/api/HuangDao/training',
    // 接口密钥：必须与后端 app.api-secret 一致；请求时放在 Header Authorization，不加 Bearer
    apiSecret: local('PXE_API_SECRET', 'apiSecret'),
    // 单次请求超时（毫秒），默认 30000
    timeoutMs: 30000,
  },

  // ---- 管理员凭据（导入/导出/看板等管理操作用），只从本机读取 ----
  admin: {
    account: local('PXE_ADMIN_ACCOUNT', 'adminAccount'),
    credential: local('PXE_ADMIN_CREDENTIAL', 'adminCredential'),
  },

  // ---- 五张业务表（表名枚举）----
  tables: {
    leader: 'pxe_leader_info',      // 人员信息
    plan: 'pxe_training_plan',      // 培训计划
    quota: 'pxe_quota_alloc',       // 单位名额分配
    record: 'pxe_train_record',     // 培训记录
    rule: 'pxe_training_rule',      // 培训通用规则
  },

  // ---- 结果文件目录 ----
  //   所有产出（导出 Excel、建议名单、统计看板）一律落在这个文件夹内，
  //   不散落到桌面、临时目录或其它位置；同一批产物成组存放，便于整体归档。
  //   默认取技能包同级的「输出」文件夹，换机器无需修改。
  outDir: path.join(__dirname, '..', '输出'),

  // ---- 结果按日期归档 ----
  //   true：结果落在「输出/2026-10-12/」这样的日期子目录，多次运行互不覆盖；
  //   false：结果直接落「输出/」根目录。
  outputByDate: true,

  // ---- 操作日志 ----
  //   每次执行命令追加一行到「输出/操作日志.txt」，记录时间、命令、结果，
  //   便于事后追溯谁在什么时候导入了什么。设为 false 可关闭。
  operationLog: true,

  // ---- 过程文件目录 ----
  //   解析、导出的中间文件只允许落在这里（系统临时目录），用完立即删除；
  //   禁止把过程文件写进 outDir，保证结果文件夹里只有最终产物。
  processDir: os.tmpdir(),

  // ---- cron 自动入库时扫描的 Excel 目录 ----
  autoInbox: path.join(__dirname, '..', '输入'),

  // ---- 规则人工审核（防止模型代替用户审核）----
  //   reviewers        允许的审核人姓名；留空表示不限，但审核人仍必填
  //   requireTerminal  true 时「规则 确认」必须由用户本人在终端里执行并输入审核人姓名，
  //                    模型在后台调用会被拒绝（最严格）
  //   blockSuspicious  true 时审核表存在疑点（非 Excel/WPS 保存、用时过短等）直接拒绝；
  //                    false 时照常保存，但疑点写入审核日志并在每次出名单时提示
  //   minReviewSeconds 出审核表到确认的最短合理用时（秒），低于此值记为疑点
  review: {
    reviewers: [],
    requireTerminal: false,
    blockSuspicious: false,
    minReviewSeconds: 120,
  },

  // ---- 数据权限说明（不在本配置中控制，由后端按身份管理）----
  // 管理员(admin)：五张表全量
  // 普通用户(本人姓名+身份证后四位)：本人资料和记录、本人单位名额、本单位计划
  // 通用规则表：所有登录用户可读，仅管理员可写
  // 地区级开放（如"黄岛用户看黄岛全区"）：后端当前未实现该规则，待扩展
};

module.exports = CFG;
