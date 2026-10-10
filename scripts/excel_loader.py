#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将培小e的三份源工作簿规范化为四张业务表，仅供本地 Mock/预览使用。

源工作簿中的人员、计划、名额和已分配记录按原值读取；不生成身份证号、名额、培训时长或业务记录。
Mock 所需的主键和 del_flag 是本地模拟字段，不会由数据维护接口提交。
"""
import argparse
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

from openpyxl import load_workbook


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_EXCEL_DIR = Path(os.environ.get("PEIXIAOE_EXCEL_DIR", SCRIPT_DIR.parents[1]))
FILES = {
    "leader": "领导人员信息表-山东17地市虚拟.xlsx",
    "plan": "2027年度四级领导人员培训计划表（虚拟）.xlsx",
    "assignment": "参培人员分配表（2027年度）.xlsx",
}
QUOTA_CLASS_ALIASES = {
    "新提任正职班": "新提任四级正职领导人员任职进修班",
    "县班子进修班": "县公司领导班子进修班",
    "四级进修班": "四级领导人员进修班",
    "新提任副职班": "新提任四级副职领导人员任职进修班",
}
CHINESE_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
                  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def as_number(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label}不是有效数字")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label}不是有效数字")
    if not number.is_integer():
        raise ValueError(f"{label}必须是整数")
    return int(number)


def parse_session(value):
    text = cell_text(value)
    match = re.search(r"第\s*([一二两三四五六七八九十\d]+)\s*期", text)
    if not match:
        raise ValueError(f"无法识别期次：{text}")
    token = match.group(1)
    if token.isdigit():
        return int(token)
    if token == "十":
        return 10
    if token.startswith("十") and len(token) == 2:
        return 10 + CHINESE_DIGITS[token[1]]
    if token.endswith("十") and len(token) == 2:
        return CHINESE_DIGITS[token[0]] * 10
    if "十" in token and len(token) == 3:
        return CHINESE_DIGITS[token[0]] * 10 + CHINESE_DIGITS[token[2]]
    if len(token) == 1:
        return CHINESE_DIGITS[token]
    raise ValueError(f"无法识别期次：{text}")


def parse_period(value):
    """解析如“2027年3月16日至3月30日”的原始培训时间。"""
    if isinstance(value, datetime):
        return value.date().isoformat(), value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat(), value.isoformat()
    text = cell_text(value)
    match = re.fullmatch(
        r"(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:至|到|—|-)\s*"
        r"(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日", text
    )
    if not match:
        raise ValueError(f"无法识别培训时间：{text}")
    start_year, start_month, start_day, end_year, end_month, end_day = match.groups()
    sy, sm, sd = int(start_year), int(start_month), int(start_day)
    ey = int(end_year) if end_year else sy
    em, ed = int(end_month), int(end_day)
    if not end_year and (em, ed) < (sm, sd):
        ey += 1
    start = date(sy, sm, sd).isoformat()
    end = date(ey, em, ed).isoformat()
    return start, end


def open_sheet(filepath, sheet_name):
    if not filepath.is_file():
        raise FileNotFoundError(f"找不到源工作簿：{filepath.name}")
    workbook = load_workbook(filepath, read_only=True, data_only=True)
    if sheet_name not in workbook.sheetnames:
        workbook.close()
        raise ValueError(f"工作簿缺少工作表：{sheet_name}")
    return workbook, workbook[sheet_name]


def header_map(ws, header_row=2):
    values = next(ws.iter_rows(min_row=header_row, max_row=header_row, values_only=True), ())
    return {cell_text(value): index for index, value in enumerate(values) if cell_text(value)}


def row_value(row, headers, *aliases, required=False):
    for alias in aliases:
        index = headers.get(alias)
        if index is not None and index < len(row):
            value = row[index]
            if value is not None and cell_text(value) != "":
                return value
    if required:
        raise ValueError(f"源工作表缺少必填列：{'/'.join(aliases)}")
    return None


def compact_row(row):
    """空单元格不提交，避免源表空白覆盖数据库已有值。"""
    return {key: value for key, value in row.items()
            if value is not None and not (isinstance(value, str) and value.strip() == "")}


def nonempty_rows(ws, start_row):
    for row in ws.iter_rows(min_row=start_row, values_only=True):
        if any(value is not None and cell_text(value) for value in row):
            yield row


def load_leaders(filepath):
    workbook, ws = open_sheet(filepath, "全省汇总")
    try:
        headers = header_map(ws)
        rows = []
        for source in nonempty_rows(ws, 3):
            employee_id = cell_text(row_value(source, headers, "员工ID", required=True))
            item = {
                "leader_id": len(rows) + 1,
                "seq_no": as_number(row_value(source, headers, "序号", required=True), "人员序号"),
                "region_name": "山东省",
                "unit_name": cell_text(row_value(source, headers, "单位", required=True)),
                "emp_name": cell_text(row_value(source, headers, "人员姓名", "姓名", required=True)),
                "emp_id": employee_id,
                "gender": cell_text(row_value(source, headers, "性别")),
                "age": row_value(source, headers, "年龄"),
                "assist_date": cell_text(row_value(source, headers, "协理时间", "辅助日期")),
                "b_role": cell_text(row_value(source, headers, "B角", "角色")),
                "cadre_level": cell_text(row_value(source, headers, "干部级别", "干部层级")),
                "staff_grade": cell_text(row_value(source, headers, "职员职级", "职级")),
                "is_party_sec": cell_text(row_value(source, headers, "是否为党支部书记", "是否党委")),
                "trained_2026": cell_text(row_value(source, headers, "2026年已参加培训班", "2026已训", "已训")),
                "total_hours": row_value(source, headers, "累计培训学时", "总学时"),
                "is_prod_head": cell_text(row_value(source, headers, "是否为生产分管负责人", "是否生产骨干", "生产骨干")),
                "del_flag": 0,
            }
            id_card = row_value(source, headers, "身份证号", "身份证")
            if id_card is not None and cell_text(id_card):
                item["id_card"] = cell_text(id_card)
            rows.append(compact_row(item))
        ids = [item["emp_id"] for item in rows]
        if not rows or len(ids) != len(set(ids)):
            raise ValueError("人员表为空或员工ID重复，已停止加载")
        return rows
    finally:
        workbook.close()


def load_plans(filepath):
    workbook, ws = open_sheet(filepath, "培训计划表")
    try:
        headers = header_map(ws)
        plans = []
        for source in nonempty_rows(ws, 3):
            class_name = cell_text(row_value(source, headers, "班次名称", "培训班名称", required=True))
            session = parse_session(row_value(source, headers, "期次", required=True))
            period = row_value(source, headers, "参培时间", "培训周期", required=True)
            start_date, end_date = parse_period(period)
            plan = {
                "plan_id": len(plans) + 1,
                "plan_year": int(start_date[:4]),
                "seq_no": as_number(row_value(source, headers, "序号", required=True), "计划序号"),
                "class_name": class_name,
                "session_no": session,
                "train_period": cell_text(period),
                "start_date": start_date,
                "end_date": end_date,
                "train_place": cell_text(row_value(source, headers, "培训地点", "地点")),
                "plan_count": as_number(row_value(source, headers, "计划人数", required=True), "计划人数"),
                "target_group": cell_text(row_value(source, headers, "参培对象", "培训对象", "对象")),
                "rule_desc": cell_text(row_value(source, headers, "调训规则", "规则说明")),
                "rule_key": cell_text(row_value(source, headers, "规则标识", "规则键")),
                "del_flag": 0,
            }
            plans.append(compact_row(plan))
        keys = [(p["plan_year"], p["class_name"], p["session_no"]) for p in plans]
        if not plans or len(keys) != len(set(keys)):
            raise ValueError("培训计划为空或班次+期次重复，已停止加载")
        return plans
    finally:
        workbook.close()


def load_quotas(filepath, plans, valid_units):
    workbook, ws = open_sheet(filepath, "名额分配表")
    try:
        top = list(next(ws.iter_rows(min_row=2, max_row=2, values_only=True)))
        second = list(next(ws.iter_rows(min_row=3, max_row=3, values_only=True)))
        plan_index = {(p["class_name"], p["session_no"]): p["plan_id"] for p in plans}
        columns = []
        current_class = ""
        for column in range(2, ws.max_column):
            label = cell_text(top[column]) if column < len(top) else ""
            if label:
                current_class = label
            session_text = second[column] if column < len(second) else None
            if not current_class or session_text is None:
                raise ValueError(f"名额表第{column + 1}列缺少班次或期次")
            full_class = QUOTA_CLASS_ALIASES.get(current_class)
            if not full_class:
                raise ValueError(f"名额表班次简称未配置：{current_class}")
            session = parse_session(session_text)
            key = (full_class, session)
            if key not in plan_index:
                raise ValueError(f"名额表班次/期次无法对应计划：{current_class} {cell_text(session_text)}")
            columns.append((column, plan_index[key]))

        quotas = []
        seen_units = set()
        for source in nonempty_rows(ws, 4):
            unit = cell_text(source[1] if len(source) > 1 else None)
            if not unit or unit in {"合计", "总计", "全省合计"}:
                continue
            if unit not in valid_units:
                raise ValueError(f"名额表出现人员表中不存在的单位：{unit}")
            if unit in seen_units:
                raise ValueError(f"名额表单位重复：{unit}")
            seen_units.add(unit)
            for column, plan_id in columns:
                value = source[column] if column < len(source) else None
                if value is None or cell_text(value) == "":
                    raise ValueError(f"名额表存在空值：{unit}，计划ID {plan_id}")
                quotas.append({
                    "quota_id": len(quotas) + 1,
                    "plan_id": plan_id,
                    "unit_name": unit,
                    "quota_count": as_number(value, f"{unit}名额"),
                    "del_flag": 0,
                })

        if seen_units != valid_units:
            raise ValueError("名额表单位与人员表单位不一致，已停止加载")
        sums = {}
        for quota in quotas:
            sums[quota["plan_id"]] = sums.get(quota["plan_id"], 0) + quota["quota_count"]
        for plan in plans:
            if sums.get(plan["plan_id"], 0) != plan["plan_count"]:
                raise ValueError(f"名额合计与计划人数不符：{plan['class_name']} 第{plan['session_no']}期")
        if len(quotas) != len(plans) * len(valid_units):
            raise ValueError("名额行数与计划/单位数量不符，已停止加载")
        return quotas
    finally:
        workbook.close()


def load_records(filepath, plans, valid_employee_ids):
    workbook, ws = open_sheet(filepath, "分配总表")
    try:
        headers = header_map(ws)
        plan_index = {(p["class_name"], p["session_no"]): p for p in plans}
        records = []
        seen = set()
        for source in nonempty_rows(ws, 3):
            class_name = cell_text(row_value(source, headers, "班次名称", required=True))
            session = parse_session(row_value(source, headers, "期次", required=True))
            plan = plan_index.get((class_name, session))
            if not plan:
                raise ValueError(f"分配记录无法对应计划：{class_name} 第{session}期")
            employee_id = cell_text(row_value(source, headers, "员工ID", "人员编号", required=True))
            if employee_id not in valid_employee_ids:
                raise ValueError("分配记录存在不在人员主表中的员工ID，已停止加载")
            unique_key = (employee_id, plan["plan_year"], class_name, session)
            if unique_key in seen:
                raise ValueError("分配记录存在重复的人员+计划组合，已停止加载")
            seen.add(unique_key)
            item = {
                "record_id": len(records) + 1,
                "plan_id": plan["plan_id"],
                "emp_id": employee_id,
                "emp_name": cell_text(row_value(source, headers, "人员姓名", "姓名", required=True)),
                "plan_year": plan["plan_year"],
                "class_name": class_name,
                "session_no": session,
                "start_date": plan["start_date"],
                "end_date": plan["end_date"],
                "unit_at_time": cell_text(row_value(source, headers, "单位")),
                "remark": cell_text(row_value(source, headers, "匹配说明", "备注")),
                "del_flag": 0,
            }
            records.append(compact_row(item))
        return records
    finally:
        workbook.close()


def load_bundle(excel_dir):
    excel_dir = Path(excel_dir)
    paths = {key: excel_dir / filename for key, filename in FILES.items()}
    leaders = load_leaders(paths["leader"])
    plans = load_plans(paths["plan"])
    units = {row["unit_name"] for row in leaders}
    employee_ids = {row["emp_id"] for row in leaders}
    quotas = load_quotas(paths["plan"], plans, units)
    records = load_records(paths["assignment"], plans, employee_ids)
    return {
        "ok": True,
        "tables": {
            "pxe_leader_info": leaders,
            "pxe_training_plan": plans,
            "pxe_quota_alloc": quotas,
            "pxe_train_record": records,
        },
        "counts": {
            "pxe_leader_info": len(leaders),
            "pxe_training_plan": len(plans),
            "pxe_quota_alloc": len(quotas),
            "pxe_train_record": len(records),
        },
    }


def main():
    parser = argparse.ArgumentParser(description="从三份源Excel读取培小e四张表数据")
    parser.add_argument("--data-dir", default=str(DEFAULT_EXCEL_DIR), help="三份源Excel所在目录")
    parser.add_argument("--full", action="store_true", help="输出完整JSON（供本地脚本读取，包含人员信息）")
    args = parser.parse_args()
    try:
        result = load_bundle(args.data_dir)
        if args.full:
            print(json.dumps(result, ensure_ascii=False, default=str))
        else:
            print(json.dumps({"ok": True, "counts": result["counts"]}, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
