#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
report_writer.py —— 培小e 报告生成（建议名单 Excel/HTML、统计看板 HTML）

用法：
  python report_writer.py --advice <建议数据json> <输出目录>
      生成 培小e建议名单.xlsx 与 培小e建议名单.html
  python report_writer.py --dashboard <看板数据json> <输出html路径>
      生成统计看板 HTML（占位符替换）

输出 JSON：{"ok":true,"files":["...","..."]}
"""

import sys
import json
import os
import html as html_lib
from datetime import datetime

try:
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    openpyxl = None

HEAD_FONT = None
HEAD_FILL = None


def _ensure_styles():
    global HEAD_FONT, HEAD_FILL
    if HEAD_FONT is None and openpyxl is not None:
        HEAD_FONT = Font(bold=True, color="FFFFFF")
        HEAD_FILL = PatternFill("solid", fgColor="2D6A9F")


def esc(value):
    return html_lib.escape(str(value if value is not None else ""))


def style_header(ws, headers):
    _ensure_styles()
    ws.append(headers)
    for index in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=index)
        cell.font = HEAD_FONT
        cell.fill = HEAD_FILL
        cell.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(index)].width = 18
    ws.freeze_panes = "A2"


# =========================================
# 建议名单 Excel
# =========================================
def write_advice_excel(path, data):
    if openpyxl is None:
        return None
    wb = openpyxl.Workbook()

    ws = wb.active
    ws.title = "建议名单"
    style_header(ws, ["班次名称", "期次", "开始日期", "结束日期", "单位", "姓名", "员工编号",
                      "干部级别", "是否党支部书记", "是否生产分管", "累计学时", "评分", "优先级", "推荐理由"])
    for plan in data.get("plans", []):
        for row in plan.get("suggestions", []):
            ws.append([plan.get("className"), plan.get("sessionNo"), plan.get("startDate"),
                       plan.get("endDate"), row.get("unitName"), row.get("empName"), row.get("empId"),
                       row.get("cadreLevel"), row.get("isPartySec"), row.get("isProdHead"),
                       row.get("totalHours"), row.get("score"), row.get("priority"),
                       "、".join(row.get("reasons") or [])])

    ws2 = wb.create_sheet("剔除与顺延")
    style_header(ws2, ["班次名称", "期次", "单位", "姓名", "员工编号", "触发规则", "原因"])
    for plan in data.get("plans", []):
        for row in plan.get("excluded", []):
            ws2.append([plan.get("className"), plan.get("sessionNo"), row.get("unitName"),
                        row.get("empName"), row.get("empId"), row.get("rule"), row.get("reason")])

    ws3 = wb.create_sheet("按期次汇总")
    style_header(ws3, ["班次名称", "期次", "计划人数", "建议人数", "剔除人次", "名额覆盖单位数"])
    for plan in data.get("plans", []):
        ws3.append([plan.get("className"), plan.get("sessionNo"), plan.get("planCount"),
                    len(plan.get("suggestions", [])), len(plan.get("excluded", [])),
                    len(plan.get("quota") or {})])

    wb.save(path)
    return path


# =========================================
# 建议名单 HTML（占位符模板替换）
# =========================================
ADVICE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>培小e · 应训未训建议名单 __YEAR__</title>
<style>
  body{margin:0;background:#f0f4f8;color:#2c3e50;font-family:"Microsoft YaHei","PingFang SC",sans-serif}
  .hd{background:linear-gradient(135deg,#1a5276,#2980b9);color:#fff;padding:22px 28px}
  .hd h1{margin:0;font-size:22px}
  .hd p{margin:6px 0 0;font-size:13px;opacity:.9}
  .kpis{display:flex;gap:14px;flex-wrap:wrap;padding:18px 28px}
  .kpi{background:#fff;border-radius:10px;padding:14px 20px;min-width:140px;box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .kpi b{display:block;font-size:24px;color:#2980b9}
  .kpi span{font-size:12px;color:#7f8c8d}
  .sec{padding:0 28px 24px}
  .card{background:#fff;border-radius:10px;margin-bottom:16px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.06)}
  .card h2{margin:0;padding:12px 16px;font-size:15px;background:#eaf2f8;color:#1a5276}
  .card h2 small{color:#7f8c8d;font-weight:400;margin-left:8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 10px;border-bottom:1px solid #eef2f5;text-align:left}
  th{background:#f7fafc;color:#5d6d7e;font-weight:600}
  .tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px}
  .high{background:#ffe0e0;color:#c0392b}.mid{background:#fff3d6;color:#b9770e}.low{background:#e8f0fe;color:#2c6fa8}
  .ft{padding:14px 28px;color:#95a5a6;font-size:12px}
</style>
</head>
<body>
<div class="hd">
  <h1>培小e · 应训未训建议名单</h1>
  <p>年度 __YEAR__ · 生成时间 __GENERATED__ · 基于 __PLANS__ 个班次期次</p>
</div>
<div class="kpis">__KPI_BLOCKS__</div>
<div class="sec">__PLAN_BLOCKS__</div>
<div class="ft">本名单由规则引擎自动生成，须经人工二次确认后方可作为调训依据。</div>
</body>
</html>
"""


def write_advice_html(path, data):
    kpis = [
        ("计划期次", data.get("summary", {}).get("plans")),
        ("建议人次", data.get("summary", {}).get("total")),
        ("剔除人次", data.get("summary", {}).get("excluded")),
        ("启用规则", len((data.get("summary", {}).get("rules", {}).get("hard") or []))
         + len((data.get("summary", {}).get("rules", {}).get("soft") or []))),
    ]
    kpi_blocks = "".join(
        f'<div class="kpi"><b>{esc(value)}</b><span>{esc(label)}</span></div>' for label, value in kpis)

    blocks = []
    for plan in data.get("plans", []):
        rows = []
        for row in plan.get("suggestions", []):
            tag = "high" if row.get("priority") == "高" else ("mid" if row.get("priority") == "中" else "low")
            rows.append(
                f"<tr><td>{esc(row.get('unitName'))}</td><td>{esc(row.get('empName'))}</td>"
                f"<td>{esc(row.get('empId'))}</td><td>{esc(row.get('cadreLevel'))}</td>"
                f"<td>{esc(row.get('totalHours'))}</td><td>{esc(row.get('score'))}</td>"
                f"<td><span class='tag {tag}'>{esc(row.get('priority'))}</span></td>"
                f"<td>{esc('、'.join(row.get('reasons') or []))}</td></tr>")
        excluded = len(plan.get("excluded", []))
        blocks.append(
            f"<div class='card'><h2>{esc(plan.get('className'))} · {esc(plan.get('sessionNo'))}"
            f"<small>计划 {esc(plan.get('planCount'))} 人 · 建议 {len(plan.get('suggestions', []))} 人"
            f" · 剔除 {excluded} 人次 · {esc(plan.get('timeText'))}</small></h2>"
            f"<table><tr><th>单位</th><th>姓名</th><th>员工编号</th><th>干部级别</th><th>累计学时</th>"
            f"<th>评分</th><th>优先级</th><th>推荐理由</th></tr>{''.join(rows)}</table></div>")

    output = (ADVICE_TEMPLATE
              .replace("__YEAR__", esc(data.get("year")))
              .replace("__GENERATED__", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
              .replace("__PLANS__", esc(data.get("summary", {}).get("plans")))
              .replace("__KPI_BLOCKS__", kpi_blocks)
              .replace("__PLAN_BLOCKS__", "".join(blocks)))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(output)
    return path


# =========================================
# 统计看板 HTML
# =========================================
DASH_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>培小e · 培训统计看板 __YEAR__</title>
<style>
  body{margin:0;background:#03121f;color:#c9e3f7;font-family:"Microsoft YaHei",sans-serif}
  .hd{padding:20px 28px;background:linear-gradient(90deg,#0a2a45,#12456e);border-bottom:2px solid #2f9bff}
  .hd h1{margin:0;font-size:22px;color:#eaf6ff}
  .hd p{margin:6px 0 0;font-size:13px;color:#7fb6e0}
  .kpis{display:flex;gap:14px;flex-wrap:wrap;padding:18px 28px}
  .kpi{background:rgba(10,34,58,.9);border:1px solid #1b4a74;border-radius:8px;padding:14px 20px;min-width:140px}
  .kpi b{display:block;font-size:26px;color:#37c8e8}
  .kpi span{font-size:12px;color:#7fb6e0}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:0 28px 24px}
  .card{background:rgba(10,34,58,.9);border:1px solid #1b4a74;border-radius:8px;padding:14px 16px}
  .card h2{margin:0 0 12px;font-size:15px;color:#9fd0f5}
  .bar{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:13px}
  .bar .n{width:110px;color:#9fd0f5;text-align:right}
  .bar .t{flex:1;background:#0d2d49;border-radius:4px;height:16px;overflow:hidden}
  .bar .t i{display:block;height:100%;background:linear-gradient(90deg,#1565c0,#4fc3f7)}
  .bar .v{width:52px;color:#5ee7a0}
  .ft{padding:14px 28px;color:#4a7ba6;font-size:12px}
  @media (max-aspect-ratio:13/10){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="hd">
  <h1>培小e · 培训统计看板</h1>
  <p>年度 __YEAR__ · 生成时间 __GENERATED__</p>
</div>
<div class="kpis">__KPI_BLOCKS__</div>
<div class="grid">
  <div class="card"><h2>各单位领导人员分布</h2>__UNIT_BARS__</div>
  <div class="card"><h2>各单位培训记录数</h2>__RECORD_BARS__</div>
  <div class="card"><h2>班次期次计划人数</h2>__PLAN_BARS__</div>
  <div class="card"><h2>干部级别分布</h2>__LEVEL_BARS__</div>
</div>
<div class="ft">数据来源：zuzhibu_db 培训模块（人员 / 计划 / 名额 / 记录 / 规则）。</div>
</body>
</html>
"""


def bars(pairs, percent_base=None):
    if not pairs:
        return "<p style='color:#4a7ba6'>暂无数据</p>"
    top = percent_base or max((count for _, count in pairs), default=1)
    rows = []
    for name, count in pairs:
        width = 0 if not top else max(2, int(count * 100 / top))
        rows.append(f"<div class='bar'><span class='n'>{esc(name)}</span>"
                    f"<span class='t'><i style='width:{width}%'></i></span>"
                    f"<span class='v'>{esc(count)}</span></div>")
    return "".join(rows)


def write_dashboard_html(path, data):
    summary = data.get("summary", {})
    kpis = [
        ("领导人员总数", summary.get("leaders")),
        ("培训计划期次", summary.get("plans")),
        ("计划调训人次", summary.get("planCount")),
        ("培训记录数", summary.get("records")),
        ("名额分配行数", summary.get("quotas")),
        ("通用规则数", summary.get("rules")),
    ]
    kpi_blocks = "".join(
        f'<div class="kpi"><b>{esc(value)}</b><span>{esc(label)}</span></div>' for label, value in kpis)

    output = (DASH_TEMPLATE
              .replace("__YEAR__", esc(data.get("year")))
              .replace("__GENERATED__", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
              .replace("__KPI_BLOCKS__", kpi_blocks)
              .replace("__UNIT_BARS__", bars(data.get("units") or []))
              .replace("__RECORD_BARS__", bars(data.get("unitRecords") or []))
              .replace("__PLAN_BARS__", bars(data.get("planCounts") or []))
              .replace("__LEVEL_BARS__", bars(data.get("levels") or [])))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(output)
    return path


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "error": "用法见文件头注释"}, ensure_ascii=False))
        sys.exit(1)
    mode = args[0]
    if mode == "--advice":
        if len(args) < 3:
            print(json.dumps({"ok": False, "error": "用法: --advice <json> <输出目录>"}, ensure_ascii=False))
            sys.exit(1)
        with open(args[1], "r", encoding="utf-8") as handle:
            data = json.load(handle)
        out_dir = args[2]
        os.makedirs(out_dir, exist_ok=True)
        year = data.get("year", "")
        excel_path = os.path.join(out_dir, f"培小e建议名单_{year}.xlsx")
        html_path = os.path.join(out_dir, f"培小e建议名单_{year}.html")
        files = []
        if write_advice_excel(excel_path, data):
            files.append(excel_path)
        files.append(write_advice_html(html_path, data))
        print(json.dumps({"ok": True, "files": files}, ensure_ascii=False))
        return
    if mode == "--dashboard":
        if len(args) < 3:
            print(json.dumps({"ok": False, "error": "用法: --dashboard <json> <输出html>"}, ensure_ascii=False))
            sys.exit(1)
        with open(args[1], "r", encoding="utf-8") as handle:
            data = json.load(handle)
        path = write_dashboard_html(args[2], data)
        print(json.dumps({"ok": True, "files": [path]}, ensure_ascii=False))
        return
    print(json.dumps({"ok": False, "error": f"未知模式 {mode}"}, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
