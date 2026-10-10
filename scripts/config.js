// =====================================================
// 培小e 配置文件
// 对接培训数据接口（见 references/api_contract.md）
// =====================================================
const CFG = {
  // ---- 培训数据接口地址 ----
  api: {
    // 本地后端
    baseUrl: 'http://127.0.0.1:7529/api/HuangDao/training',
    // 生产后端（部署后替换）：
    // baseUrl: 'http://10.141.186.82:27529/api/HuangDao/training',
    apiSecret: 'Tcm@950t',
  },

  // ---- 管理员凭据（导入/导出/看板等管理操作用）----
  admin: {
    account: 'admin',
    credential: 'Tcm@950t',
  },

  // ---- 五张业务表（表名枚举）----
  tables: {
    leader: 'pxe_leader_info',      // 人员信息
    plan: 'pxe_training_plan',      // 培训计划
    quota: 'pxe_quota_alloc',       // 单位名额分配
    record: 'pxe_train_record',     // 培训记录
    rule: 'pxe_training_rule',      // 培训通用规则
  },

  // ---- 产物输出目录（Excel/大屏HTML/名单落盘位置）----
  outDir: 'D:/培小e输出',

  // ---- cron 自动入库时扫描的 Excel 目录 ----
  autoInbox: 'D:/培小e输入',

  // ---- 数据权限说明（不在本配置中控制，由后端按身份管理）----
  // 管理员(admin)：五张表全量
  // 普通用户(本人姓名+身份证后四位)：本人资料和记录、本人单位名额、本单位计划
  // 通用规则表：所有登录用户可读，仅管理员可写
  // 地区级开放（如"黄岛用户看黄岛全区"）：后端当前未实现该规则，待扩展
};

module.exports = CFG;
