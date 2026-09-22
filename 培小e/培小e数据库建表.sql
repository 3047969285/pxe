


-- ------------------------------------------------------------
-- 1. 领导人员基础信息表
--    对应《领导人员信息表—山东17地市》
-- ------------------------------------------------------------
CREATE TABLE pxe_leader_info (
    leader_id     BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    guid          VARCHAR(36)  NOT NULL COMMENT '全局唯一标识',
    seq_no        INT                   DEFAULT NULL COMMENT '序号',
    unit_name     VARCHAR(50)           DEFAULT '' COMMENT '单位',
    emp_name      VARCHAR(50)           DEFAULT '' COMMENT '姓名',
    emp_id        VARCHAR(20)  NOT NULL COMMENT '员工ID(文本存储,保留前导零)',
    gender        CHAR(2)               DEFAULT NULL COMMENT '性别',
    age           TINYINT               DEFAULT NULL COMMENT '年龄',
    assist_date   DATE                  DEFAULT NULL COMMENT '协理时间',
    b_role        VARCHAR(50)           DEFAULT NULL COMMENT 'B角',
    cadre_level   VARCHAR(20)           DEFAULT NULL COMMENT '干部级别',
    staff_grade   VARCHAR(20)           DEFAULT NULL COMMENT '职员职级',
    is_party_sec  CHAR(2)               DEFAULT NULL COMMENT '是否党支部书记',
    trained_2026  VARCHAR(255)          DEFAULT NULL COMMENT '2026年已参加培训班',
    total_hours   INT                   DEFAULT NULL COMMENT '累计培训学时',
    is_prod_head  CHAR(2)               DEFAULT NULL COMMENT '是否生产分管负责人',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志（0代表存在 2代表删除）',
    create_time   DATETIME              DEFAULT NULL COMMENT '创建时间',
    update_time   DATETIME              DEFAULT NULL COMMENT '更新时间',
    PRIMARY KEY (leader_id),
    UNIQUE KEY uk_guid (guid),
    UNIQUE KEY uk_emp (emp_id),
    KEY idx_name (emp_name),
    KEY idx_unit (unit_name, del_flag),
    KEY idx_level (cadre_level, del_flag),
    KEY idx_brole (b_role),
    KEY idx_update (update_time)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='领导人员基础信息表';


-- ------------------------------------------------------------
-- 2. 培训计划表
--    对应《2027年度四级领导人员培训计划表》"培训计划表"sheet
-- ------------------------------------------------------------
CREATE TABLE pxe_training_plan (
    plan_id       BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    guid          VARCHAR(36)  NOT NULL COMMENT '全局唯一标识',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '计划年度',
    seq_no        INT                   DEFAULT NULL COMMENT '序号',
    class_name    VARCHAR(100) NOT NULL COMMENT '班次名称',
    session_no    VARCHAR(20)  NOT NULL COMMENT '期次',
    train_period  VARCHAR(50)           DEFAULT NULL COMMENT '参培时间(原文)',
    start_date    DATE                  DEFAULT NULL COMMENT '开始日期',
    end_date      DATE                  DEFAULT NULL COMMENT '结束日期',
    train_place   VARCHAR(100)          DEFAULT NULL COMMENT '培训地点',
    plan_count    INT                   DEFAULT NULL COMMENT '计划人数',
    target_group  VARCHAR(200)          DEFAULT NULL COMMENT '参培对象',
    rule_desc     VARCHAR(500)          DEFAULT NULL COMMENT '调训规则',
    rule_key      VARCHAR(50)           DEFAULT NULL COMMENT '规则标识',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志（0代表存在 2代表删除）',
    create_time   DATETIME              DEFAULT NULL COMMENT '创建时间',
    update_time   DATETIME              DEFAULT NULL COMMENT '更新时间',
    PRIMARY KEY (plan_id),
    UNIQUE KEY uk_guid (guid),
    UNIQUE KEY uk_plan (plan_year, class_name, session_no),
    KEY idx_date (start_date, end_date),
    KEY idx_rule (rule_key),
    KEY idx_update (update_time)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培训计划表';


-- ------------------------------------------------------------
-- 3. 各单位名额分配表
--    对应"名额分配表"sheet（17家地市 × 班次期次，宽表拍平为行式）
-- ------------------------------------------------------------
CREATE TABLE pxe_quota_alloc (
    quota_id      BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    guid          VARCHAR(36)  NOT NULL COMMENT '全局唯一标识',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '计划年度',
    unit_name     VARCHAR(50)  NOT NULL COMMENT '单位简称',
    class_name    VARCHAR(100) NOT NULL COMMENT '班次名称',
    session_no    VARCHAR(20)  NOT NULL COMMENT '期次',
    quota_count   INT          NOT NULL DEFAULT 0 COMMENT '名额数',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志（0代表存在 2代表删除）',
    create_time   DATETIME              DEFAULT NULL COMMENT '创建时间',
    update_time   DATETIME              DEFAULT NULL COMMENT '更新时间',
    PRIMARY KEY (quota_id),
    UNIQUE KEY uk_guid (guid),
    UNIQUE KEY uk_quota (plan_year, unit_name, class_name, session_no),
    KEY idx_unit (plan_year, unit_name),
    KEY idx_class_session (class_name, session_no)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='各单位名额分配表';


-- ------------------------------------------------------------
-- 4. 人员培训记录表
--    仅存业务确认后/已发生的培训事实；匹配过程结果不落库（可复现）
--    覆盖近5年历史记录 + 当期确认名单 + 国网学堂同步记录
-- ------------------------------------------------------------
CREATE TABLE pxe_train_record (
    record_id      BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    guid           VARCHAR(36)  NOT NULL COMMENT '全局唯一标识',
    emp_id         VARCHAR(20)  NOT NULL COMMENT '员工ID',
    emp_name       VARCHAR(50)           DEFAULT '' COMMENT '姓名',
    plan_year      VARCHAR(4)   NOT NULL COMMENT '培训年度',
    class_name     VARCHAR(100) NOT NULL COMMENT '班次名称',
    class_type     VARCHAR(50)           DEFAULT NULL COMMENT '班次类别(进修班/县班子班/新提任班等)',
    session_no     VARCHAR(20)           DEFAULT NULL COMMENT '期次',
    start_date     DATE                  DEFAULT NULL COMMENT '开始日期',
    end_date       DATE                  DEFAULT NULL COMMENT '结束日期',
    hours          INT                   DEFAULT NULL COMMENT '本次学时(源数据仅有年度合计时留空)',
    unit_at_time   VARCHAR(50)           DEFAULT NULL COMMENT '参培时所在单位(跨单位交流核对用)',
    data_source    VARCHAR(20)           DEFAULT NULL COMMENT '来源(自办班/送培/国网学堂/跨单位交流/系统匹配确认)',
    confirm_status VARCHAR(10)  NOT NULL DEFAULT '已确认' COMMENT '状态(已确认/已参训/已完成)',
    confirm_by     VARCHAR(64)           DEFAULT NULL COMMENT '确认人',
    confirm_time   DATETIME              DEFAULT NULL COMMENT '确认时间',
    remark         VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag       CHAR(1)               DEFAULT '0' COMMENT '删除标志（0代表存在 2代表删除）',
    create_time    DATETIME              DEFAULT NULL COMMENT '创建时间',
    update_time    DATETIME              DEFAULT NULL COMMENT '更新时间',
    PRIMARY KEY (record_id),
    UNIQUE KEY uk_guid (guid),
    -- 同人同班次只存一条：拦重复上报；允许同人同年参加多个不同班次
    UNIQUE KEY uk_emp_class (emp_id, class_name, session_no),
    -- 个人档案、近N年是否参培、学时合计：等值命中且免回表
    KEY idx_emp_year (emp_id, plan_year, class_type, hours),
    KEY idx_year_class (plan_year, class_name, session_no),
    KEY idx_unit (unit_at_time, del_flag),
    KEY idx_source (data_source),
    KEY idx_update (update_time)
) ENGINE=InnoDB AUTO_INCREMENT=100 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='人员培训记录表';


-- ============================================================
-- 配套约定（不属于 DDL，落地时照做）
-- 1. guid 由程序生成：Java UUID.randomUUID().toString() / Python str(uuid.uuid4())
-- 2. create_time、update_time 新增时都赋当前时间，更新时刷 update_time，不留 NULL
-- 3. 导入统一 INSERT ... ON DUPLICATE KEY UPDATE，每 500~1000 行一批提交
-- 4. 写走 20.40.199.18，查询统计与大屏读取走 20.40.199.20 只读库
-- 5. 上线后执行 ANALYZE TABLE 收集统计信息，高频 SQL 用 EXPLAIN 复核索引命中
-- ============================================================
