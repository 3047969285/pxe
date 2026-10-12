-- 培小e 培训模块建表脚本
-- 以 com.xlsj.project.model.enums.huangdao.HuangDaoTrainingTableEnum 为唯一依据
-- 唯一索引严格对应代码业务唯一键，否则 ON DUPLICATE KEY UPDATE 无法触发更新
-- 主键为程序生成的 UUID，不使用数据库自增

CREATE DATABASE IF NOT EXISTS zuzhibu_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE zuzhibu_db;

-- 1. 领导人员基础信息表 业务唯一键 emp_id
CREATE TABLE IF NOT EXISTS pxe_leader_info (
    leader_id       VARCHAR(36)  NOT NULL COMMENT '主键 人员标识',
    seq_no          INT                   DEFAULT NULL COMMENT '序号',
    region_name     VARCHAR(50)           DEFAULT NULL COMMENT '地区',
    unit_name       VARCHAR(50)           DEFAULT NULL COMMENT '单位',
    emp_name        VARCHAR(50)           DEFAULT NULL COMMENT '姓名',
    emp_id          VARCHAR(20)  NOT NULL COMMENT '员工编号',
    id_card         VARCHAR(18)           DEFAULT NULL COMMENT '身份证号',
    gender          CHAR(2)               DEFAULT NULL COMMENT '性别',
    age             TINYINT               DEFAULT NULL COMMENT '年龄',
    assist_date     DATE                  DEFAULT NULL COMMENT '协理时间',
    b_role          VARCHAR(50)           DEFAULT NULL COMMENT 'B角',
    cadre_level     VARCHAR(20)           DEFAULT NULL COMMENT '干部级别',
    staff_grade     VARCHAR(20)           DEFAULT NULL COMMENT '职员职级',
    is_party_sec    CHAR(2)               DEFAULT NULL COMMENT '是否党支部书记',
    trained_records VARCHAR(500)          DEFAULT NULL COMMENT '培训记录 多值顿号分隔',
    total_hours     INT                   DEFAULT NULL COMMENT '累计培训学时',
    is_prod_head    CHAR(2)               DEFAULT NULL COMMENT '是否生产分管负责人',
    remark          VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag        CHAR(1)               DEFAULT '0' COMMENT '删除标志 0存在 2删除',
    create_time     DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (leader_id),
    UNIQUE KEY uk_emp (emp_id),
    KEY idx_unit (unit_name, del_flag),
    KEY idx_level (cadre_level, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='领导人员基础信息表';

-- 2. 培训计划表 业务唯一键 plan_year + class_name + session_no
CREATE TABLE IF NOT EXISTS pxe_training_plan (
    plan_id       VARCHAR(36)  NOT NULL COMMENT '主键 培训计划标识',
    batch_id      VARCHAR(36)           DEFAULT NULL COMMENT '批次标识',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '计划年度',
    seq_no        INT                   DEFAULT NULL COMMENT '序号',
    class_name    VARCHAR(100) NOT NULL COMMENT '班次名称',
    session_no    VARCHAR(20)  NOT NULL COMMENT '期次',
    train_period  VARCHAR(50)           DEFAULT NULL COMMENT '参培时间原文',
    start_date    DATE                  DEFAULT NULL COMMENT '开始日期',
    end_date      DATE                  DEFAULT NULL COMMENT '结束日期',
    train_place   VARCHAR(100)          DEFAULT NULL COMMENT '培训地点',
    plan_count    INT                   DEFAULT NULL COMMENT '计划人数',
    target_group  VARCHAR(200)          DEFAULT NULL COMMENT '参培对象',
    rule_desc     VARCHAR(500)          DEFAULT NULL COMMENT '调训规则',
    rule_key      VARCHAR(50)           DEFAULT NULL COMMENT '规则标识',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (plan_id),
    UNIQUE KEY uk_plan (plan_year, class_name, session_no),
    KEY idx_batch (batch_id),
    KEY idx_date (start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培训计划表';

-- 3. 各单位名额分配表 业务唯一键 plan_id + unit_name
CREATE TABLE IF NOT EXISTS pxe_quota_alloc (
    quota_id      VARCHAR(36)  NOT NULL COMMENT '主键 名额标识',
    plan_id       VARCHAR(36)  NOT NULL COMMENT '培训计划标识',
    unit_name     VARCHAR(50)  NOT NULL COMMENT '单位',
    quota_count   INT                   DEFAULT 0 COMMENT '名额数',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (quota_id),
    UNIQUE KEY uk_quota (plan_id, unit_name),
    KEY idx_unit (unit_name, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='各单位名额分配表';

-- 4. 人员培训记录表 业务唯一键 emp_id + plan_year + class_name + session_no
CREATE TABLE IF NOT EXISTS pxe_train_record (
    record_id     VARCHAR(36)  NOT NULL COMMENT '主键 记录标识',
    plan_id       VARCHAR(36)           DEFAULT NULL COMMENT '培训计划标识',
    emp_id        VARCHAR(20)  NOT NULL COMMENT '员工编号',
    emp_name      VARCHAR(50)           DEFAULT NULL COMMENT '姓名',
    plan_year     VARCHAR(4)   NOT NULL COMMENT '培训年度',
    class_name    VARCHAR(100) NOT NULL COMMENT '班次名称',
    class_type    VARCHAR(50)           DEFAULT NULL COMMENT '班次类别',
    session_no    VARCHAR(20)           DEFAULT NULL COMMENT '期次',
    start_date    DATE                  DEFAULT NULL COMMENT '开始日期',
    end_date      DATE                  DEFAULT NULL COMMENT '结束日期',
    hours         INT                   DEFAULT NULL COMMENT '本次学时',
    unit_at_time  VARCHAR(50)           DEFAULT NULL COMMENT '参培时所在单位',
    data_source   VARCHAR(20)           DEFAULT NULL COMMENT '数据来源',
    remark        VARCHAR(500)          DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)               DEFAULT '0' COMMENT '删除标志 0存在 2删除',
    create_time   DATETIME              DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME              DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (record_id),
    UNIQUE KEY uk_record (emp_id, plan_year, class_name, session_no),
    KEY idx_plan (plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='人员培训记录表';

-- 5. 培训通用规则表 业务唯一键 rule_code
CREATE TABLE IF NOT EXISTS pxe_training_rule (
    rule_id       VARCHAR(36)   NOT NULL COMMENT '主键 规则标识',
    rule_type     VARCHAR(10)   NOT NULL COMMENT '规则类型 硬规则 软规则',
    rule_code     VARCHAR(50)   NOT NULL COMMENT '规则编码',
    rule_name     VARCHAR(100)  NOT NULL COMMENT '规则名称',
    rule_content  VARCHAR(1000)          DEFAULT NULL COMMENT '规则内容',
    priority      INT                    DEFAULT NULL COMMENT '优先级',
    enabled       CHAR(1)       DEFAULT '1' COMMENT '是否启用 1启用 0停用',
    remark        VARCHAR(500)           DEFAULT NULL COMMENT '备注',
    del_flag      CHAR(1)                DEFAULT '0' COMMENT '删除标志 0存在 2删除',
    create_time   DATETIME               DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME               DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (rule_id),
    UNIQUE KEY uk_rule_code (rule_code),
    KEY idx_type (rule_type, del_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='培训通用规则表';
