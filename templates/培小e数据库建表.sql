-- ============================================================
-- 培小e 培训模块建表脚本
--
-- 权威依据：com.xlsj.project.model.enums.huangdao.HuangDaoTrainingTableEnum
-- 关键约束：
--   1. 唯一索引严格对应代码里的业务唯一键，否则 UPSERT 无法触发更新
--   2. 主键为程序生成的 UUID，不使用数据库自增
--   3. create_time / update_time / del_flag 由数据库与程序自动维护，不要手工赋值
-- 字段标记说明：
--   【必填】 业务上必须提供
--   【自动】 由数据库默认值或程序自动维护，不要手工填写
--   【汇总】 由培训记录自动汇总回写，手工填写会被覆盖
--   【关联】 指向其它表，导入模板可由业务键自动匹配，无需用户填写
-- ============================================================

CREATE DATABASE IF NOT EXISTS zuzhibu_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE zuzhibu_db;

-- ------------------------------------------------------------
-- 1. 领导人员基础信息表
--    业务唯一键：emp_id（员工编号）
--    数据来源：《领导人员信息表—山东17地市》
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pxe_leader_info (
    leader_id       VARCHAR(36)  NOT NULL COMMENT '【自动】主键 人员标识 程序生成UUID',
    seq_no          INT                   DEFAULT NULL COMMENT '序号 仅用于排序展示',
    region_name     VARCHAR(50)           DEFAULT NULL COMMENT '【必填】地区 如济南 只填单位时系统自动派生',
    unit_name       VARCHAR(50)           DEFAULT NULL COMMENT '【必填】单位 如济南公司',
    emp_name        VARCHAR(50)           DEFAULT NULL COMMENT '【必填】人员姓名 需与培训记录一致',
    emp_id          VARCHAR(20)  NOT NULL COMMENT '【必填】员工编号 唯一标识 文本存储保留前导零',
    id_card         VARCHAR(18)           DEFAULT NULL COMMENT '身份证号 18或15位 非管理员查询时脱敏 后四位用于个人登录',
    gender          CHAR(2)               DEFAULT NULL COMMENT '性别 男或女',
    age             TINYINT               DEFAULT NULL COMMENT '年龄 满55岁不安排进修班',
    assist_date     DATE                  DEFAULT NULL COMMENT '协理时间 退出实职转任协理的时间',
    hire_date       DATE                  DEFAULT NULL COMMENT '入职时间 可只填到年月 系统按当月1日存入',
    b_role          VARCHAR(50)           DEFAULT NULL COMMENT 'B角 互为AB角者培训时间重叠会冲突',
    cadre_level     VARCHAR(20)           DEFAULT NULL COMMENT '干部级别 如正科级 副科级',
    staff_grade     VARCHAR(20)           DEFAULT NULL COMMENT '职员职级 如四级职员',
    is_party_sec    CHAR(2)               DEFAULT NULL COMMENT '是否为党支部书记 是或否',
    trained_records VARCHAR(500)          DEFAULT NULL COMMENT '【汇总】培训记录 由培训记录表自动汇总 顿号分隔 勿手工填',
    total_hours     INT                   DEFAULT NULL COMMENT '【汇总】累计培训学时 由培训记录表自动汇总 勿手工填',
    is_prod_head    CHAR(2)               DEFAULT NULL COMMENT '是否为生产分管负责人 是或否 为是时培训须避开春秋检',
    remark          VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag        CHAR(1)               DEFAULT '0' COMMENT '【自动】删除标志 0存在 2删除',
    create_time     DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '【自动】创建时间',
    update_time     DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '【自动】更新时间',
    PRIMARY KEY (leader_id),
    UNIQUE KEY uk_emp (emp_id),
    KEY idx_unit (unit_name, del_flag),
    KEY idx_level (cadre_level, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='领导人员基础信息表';

-- ------------------------------------------------------------
-- 2. 培训计划表
--    业务唯一键：plan_year + class_name + session_no
--    数据来源：《2027年度四级领导人员培训计划表》培训计划表 sheet
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pxe_training_plan (
    plan_id       VARCHAR(36)  NOT NULL COMMENT '【自动】主键 培训计划标识 程序生成UUID',
    batch_id      VARCHAR(36)           DEFAULT NULL COMMENT '批次标识 同一批导入的计划共用 留空自动生成',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '【必填】计划年度 4位年份',
    seq_no        INT                   DEFAULT NULL COMMENT '序号 仅用于排序展示',
    class_name    VARCHAR(100) NOT NULL COMMENT '【必填】班次名称 如四级领导人员进修班',
    session_no    VARCHAR(20)  NOT NULL COMMENT '【必填】期次 第一期或1',
    train_period  VARCHAR(50)           DEFAULT NULL COMMENT '参培时间原文 如2027年3月16日至3月30日 可自动拆出起止日期',
    start_date    DATE                  DEFAULT NULL COMMENT '开始日期 推荐直接填写',
    end_date      DATE                  DEFAULT NULL COMMENT '结束日期 推荐直接填写',
    train_place   VARCHAR(100)          DEFAULT NULL COMMENT '培训地点',
    plan_count    INT                   DEFAULT NULL COMMENT '计划人数',
    target_group  VARCHAR(200)          DEFAULT NULL COMMENT '参培对象 如2026年新提任四级正职领导人员',
    rule_desc     VARCHAR(500)          DEFAULT NULL COMMENT '调训规则 本班次的规则说明',
    rule_key      VARCHAR(50)           DEFAULT NULL COMMENT '规则标识 关联通用规则 如jxb_normal',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '【自动】删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '【自动】创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '【自动】更新时间',
    PRIMARY KEY (plan_id),
    UNIQUE KEY uk_plan (plan_year, class_name, session_no),
    KEY idx_batch (batch_id),
    KEY idx_date (start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培训计划表';

-- ------------------------------------------------------------
-- 3. 各单位名额分配表
--    业务唯一键：plan_id + unit_name
--    数据来源：培训计划工作簿的「名额分配表」sheet（单位×班次期次交叉表，导入时拍平）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pxe_quota_alloc (
    quota_id      VARCHAR(36)  NOT NULL COMMENT '【自动】主键 名额标识 程序生成UUID',
    plan_id       VARCHAR(36)  NOT NULL COMMENT '【关联】培训计划标识 导入时按年度+班次+期次自动匹配 用户无需填写',
    unit_name     VARCHAR(50)  NOT NULL COMMENT '【必填】单位 如济南公司',
    quota_count   INT                   DEFAULT 0 COMMENT '【必填】名额数 该单位在该班次期次的名额 可为0',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '【自动】删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '【自动】创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '【自动】更新时间',
    PRIMARY KEY (quota_id),
    UNIQUE KEY uk_quota (plan_id, unit_name),
    KEY idx_unit (unit_name, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='各单位名额分配表';

-- ------------------------------------------------------------
-- 4. 人员培训记录表
--    业务唯一键：emp_id + plan_year + class_name + session_no
--    数据来源：《参培人员分配表》分配总表、国网学堂同步、人工登记
--    注意：本表是学时的唯一事实来源，增删改会触发领导人员表的汇总回写
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pxe_train_record (
    record_id     VARCHAR(36)  NOT NULL COMMENT '【自动】主键 记录标识 程序生成UUID',
    plan_id       VARCHAR(36)           DEFAULT NULL COMMENT '【关联】培训计划标识 导入时按年度+班次+期次自动匹配 用户无需填写',
    emp_id        VARCHAR(20)  NOT NULL COMMENT '【必填】员工编号 需与人员信息表一致',
    emp_name      VARCHAR(50)           DEFAULT NULL COMMENT '【必填】姓名 需与人员信息表一致',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '【必填】培训年度',
    class_name    VARCHAR(100) NOT NULL COMMENT '【必填】班次名称',
    class_type    VARCHAR(50)           DEFAULT NULL COMMENT '班次类别 如进修班 县班子班 新提任班',
    session_no    VARCHAR(20)           DEFAULT NULL COMMENT '期次 第一期或1',
    start_date    DATE                  DEFAULT NULL COMMENT '开始日期 推荐直接填写',
    end_date      DATE                  DEFAULT NULL COMMENT '结束日期 推荐直接填写',
    hours         INT                   DEFAULT NULL COMMENT '本次培训学时 汇总到人员累计学时 可留空',
    unit_at_time  VARCHAR(50)           DEFAULT NULL COMMENT '参培时所在单位 跨单位交流核对用',
    data_source   VARCHAR(20)           DEFAULT NULL COMMENT '数据来源 自办班 送培 国网学堂 跨单位交流 系统匹配确认',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '【自动】删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '【自动】创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '【自动】更新时间',
    PRIMARY KEY (record_id),
    UNIQUE KEY uk_record (emp_id, plan_year, class_name, session_no),
    KEY idx_plan (plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='人员培训记录表';

-- ------------------------------------------------------------
-- 5. 培训通用规则表
--    业务唯一键：rule_code
--    规则类型：硬规则用于剔除不符合条件的人，软规则用于优先排序
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pxe_training_rule (
    rule_id       VARCHAR(36)   NOT NULL COMMENT '【自动】主键 规则标识 程序生成UUID',
    rule_type     VARCHAR(10)   NOT NULL COMMENT '【必填】规则类型 硬规则或软规则',
    rule_code     VARCHAR(50)   NOT NULL COMMENT '【必填】规则编码 留空时按规则名称自动生成 同名复用已有编码',
    rule_name     VARCHAR(100)  NOT NULL COMMENT '【必填】规则名称 如硬规则一：AB角不得同出',
    rule_content  VARCHAR(1000)          DEFAULT NULL COMMENT '规则内容 系统按内容关键词识别执行逻辑',
    priority      INT                    DEFAULT NULL COMMENT '优先级 数字越小越先执行 留空按行序自动编排',
    enabled       CHAR(1)       DEFAULT '1' COMMENT '是否启用 1启用 0停用 留空视为启用',
    remark        VARCHAR(500)           DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)                DEFAULT '0' COMMENT '【自动】删除标志 0存在 2删除',
    create_time   DATETIME               DEFAULT CURRENT_TIMESTAMP COMMENT '【自动】创建时间',
    update_time   DATETIME               DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '【自动】更新时间',
    PRIMARY KEY (rule_id),
    UNIQUE KEY uk_rule_code (rule_code),
    KEY idx_type (rule_type, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培训通用规则表';
