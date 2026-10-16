#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
report_writer.py —— 培小e 报告生成（建议名单 Excel/HTML、统计看板 HTML）

用法：
  python report_writer.py --advice <建议数据json|-> <输出目录>
      生成 培小e建议名单.xlsx 与 培小e建议名单.html
  python report_writer.py --dashboard <看板数据json> <输出html路径>
      生成统计看板 HTML（占位符替换）
  python report_writer.py --review <审核数据json|-> <输出xlsx路径>
      生成规则审核表
  python report_writer.py --read-review <审核表xlsx>
      读回规则审核表，输出 {"ok":true,"rows":[...]}

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

# 本地 ECharts（离线可用）；不存在时回退 CDN
ECHARTS_LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "echarts.min.js")
ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"


def echarts_script_tag(out_dir):
    """生成图表库的 script 标签，优先引用同目录的本地副本"""
    try:
        if os.path.exists(ECHARTS_LOCAL):
            os.makedirs(out_dir, exist_ok=True)
            target = os.path.join(out_dir, "echarts.min.js")
            if not os.path.exists(target) or os.path.getsize(target) != os.path.getsize(ECHARTS_LOCAL):
                import shutil
                shutil.copy2(ECHARTS_LOCAL, target)
            return '<script src="./echarts.min.js"></script>'
    except OSError:
        pass
    return f'<script src="{ECHARTS_CDN}"></script>'


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
                        row.get("empName"), row.get("empId"), (row.get("ruleName") or row.get("rule")), row.get("reason")])

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
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>培小e·应训未训建议名单 __YEAR__</title>
__ECHARTS__
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#03121f;color:#cfe6f7;position:relative}
.bg{position:fixed;inset:0;z-index:0;background:
 radial-gradient(ellipse at 50% -10%,rgba(24,90,150,.35),transparent 55%),
 radial-gradient(ellipse at 15% 100%,rgba(16,70,120,.25),transparent 50%),
 radial-gradient(ellipse at 85% 100%,rgba(16,70,120,.25),transparent 50%)}
.bg::after{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(64,158,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(64,158,255,.05) 1px,transparent 1px);background-size:46px 46px}
.wrap{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;padding:0 1.1vw 1.1vh}
.hd{flex:0 0 auto;text-align:center;padding:1.3vh 0 0.5vh;position:relative}
.hd h1{font-size:clamp(20px,2.2vw,32px);letter-spacing:6px;font-weight:700;color:#fff;
 text-shadow:0 0 18px rgba(45,140,255,.8),0 0 40px rgba(45,140,255,.4)}
.hd .deco{height:12px;margin:6px auto 0;max-width:1400px;background:
 radial-gradient(ellipse at 50% 0,rgba(64,170,255,.55),transparent 70%);position:relative}
.hd .deco::before{content:"";position:absolute;left:0;right:0;top:5px;height:2px;background:linear-gradient(90deg,transparent,#2f9bff 30%,#7fd4ff 50%,#2f9bff 70%,transparent);box-shadow:0 0 12px #2f9bff}
.hd .sub{font-size:12px;color:#6f9cc0;letter-spacing:2px;margin-top:2px}
.hd .clock{position:absolute;right:8px;top:22px;text-align:right;font-size:12px;color:#7fb6dd;line-height:1.7}
.hd .clock b{font-size:18px;color:#eaf6ff;font-family:Consolas,monospace;letter-spacing:1px}
.hd .logo{position:absolute;left:14px;top:20px;display:flex;align-items:center;gap:8px}
.hd .logo .mark{width:34px;height:34px;border-radius:50%;border:2px solid #2f9bff;display:flex;align-items:center;justify-content:center;color:#7fd4ff;font-size:11px;font-weight:700;box-shadow:0 0 12px rgba(47,155,255,.6)}
.hd .logo span{font-size:12px;color:#8db8dc;letter-spacing:2px;line-height:1.5;text-align:left}
.kpis{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:10px 0}
.kpi{position:relative;background:linear-gradient(180deg,rgba(14,44,76,.85),rgba(8,26,46,.85));border:1px solid rgba(64,158,255,.28);padding:1.1vh 4px 0.9vh;text-align:center;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
.kpi::before{content:"";position:absolute;top:0;left:12%;right:12%;height:2px;background:linear-gradient(90deg,transparent,var(--kc,#2f9bff),transparent)}
.kv{font-size:clamp(14px,1.5vw,26px);font-weight:700;color:var(--kc,#2f9bff);text-shadow:0 0 14px var(--kg,rgba(47,155,255,.5));font-family:"DIN Alternate",Consolas,"Microsoft YaHei",monospace;line-height:1.2}
.kl{font-size:clamp(10px,0.78vw,12px);color:#7ea6c8;margin-top:0.5vh;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{flex:1;min-height:0;display:grid;grid-template-columns:26% 1fr 38%;gap:12px;overflow:hidden}
.col{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0}
.panel{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(10,34,58,.9),rgba(6,20,38,.92));border:1px solid rgba(64,158,255,.22);position:relative;overflow:hidden}
.panel::before,.panel::after{content:"";position:absolute;width:14px;height:14px;border-color:#3fa2ff;border-style:solid;z-index:2}
.panel::before{top:-1px;left:-1px;border-width:2px 0 0 2px}
.panel::after{bottom:-1px;right:-1px;border-width:0 2px 2px 0}
.pt{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(64,158,255,.18);background:linear-gradient(90deg,rgba(47,155,255,.16),transparent 65%)}
.pt i{width:4px;height:14px;background:linear-gradient(#7fd4ff,#2f9bff);box-shadow:0 0 8px #2f9bff}
.pt b{font-size:13.5px;color:#dff0ff;letter-spacing:2px;font-weight:600}
.pt em{margin-left:auto;font-style:normal;font-size:10.5px;color:#5d89ad;letter-spacing:1px}
.pc{flex:1;min-height:0;position:relative}
.chart{position:absolute;inset:0}
.tbl{position:absolute;inset:0;overflow:auto;padding:0 8px 8px}
.tbl::-webkit-scrollbar{width:4px}.tbl::-webkit-scrollbar-thumb{background:rgba(64,158,255,.35)}
table{width:100%;border-collapse:collapse;font-size:clamp(10px,0.78vw,12px)}
th{position:sticky;top:0;background:#0d2c4a;color:#7fc3ff;padding:0.7vh 4px;font-weight:600;letter-spacing:1px;border-bottom:1px solid rgba(64,158,255,.35);z-index:1}
td{padding:0.55vh 4px;text-align:center;color:#a9cbe4;border-bottom:1px dashed rgba(64,158,255,.12);white-space:nowrap}
tr:nth-child(even) td{background:rgba(20,60,100,.15)}
td.nm{color:#eaf6ff;font-weight:600}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:2px;border:1px solid}
.t1{color:#67e0a3;border-color:rgba(103,224,163,.5);background:rgba(103,224,163,.08)}
.t2{color:#7fc3ff;border-color:rgba(127,195,255,.5);background:rgba(127,195,255,.08)}
.t3{color:#ffd36e;border-color:rgba(255,211,110,.5);background:rgba(255,211,110,.08)}
.t4{color:#b9c9d9;border-color:rgba(185,201,217,.4);background:rgba(185,201,217,.06)}
.ft{flex:0 0 auto;margin-top:10px;border:1px solid rgba(64,158,255,.22);background:rgba(8,26,46,.9);padding:8px 14px;color:#5d89ad;font-size:12px;letter-spacing:1px}
@media (max-aspect-ratio:13/10){html,body{overflow:auto}.main{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,1fr)}.wrap{height:auto}body{padding-bottom:20px}}
</style></head><body>
<div class="bg"></div>
<div class="wrap">
<div class="hd">
 <div class="logo"><div class="mark">培</div><span>培小e<br>智能培训管理</span></div>
 <h1>培小e · 应训未训建议名单</h1>
 <div class="deco"></div>
 <div class="sub">年度 __YEAR__ · 基于 __PLANS__ 个班次期次 · 生成于 __GENERATED__</div>
 <div class="clock"><b id="clk">--:--:--</b><br><span id="dt">--</span></div>
</div>
<div class="kpis" id="kpis"></div>
<div class="main">
 <div class="col">
  <div class="panel"><div class="pt"><i></i><b>剔除与顺延原因分布</b><em>规则审计</em></div><div class="pc"><div class="chart" id="cReason"></div></div></div>
 </div>
 <div class="col">
  <div class="panel" style="flex:1.25"><div class="pt"><i></i><b>各期次建议人数与计划人数对比</b><em>__PLANS__ 个期次</em></div><div class="pc"><div class="chart" id="cSession"></div></div></div>
  <div class="panel" style="flex:1.35"><div class="pt"><i></i><b>各单位建议人次分布</b><em>山东17地市</em></div><div class="pc"><div class="chart" id="cUnit"></div></div></div>
 </div>
 <div class="col">
  <div class="panel"><div class="pt"><i></i><b>建议名单明细</b><em>共 __TOTAL__ 人次 · 自动滚动</em></div><div class="pc"><div class="tbl" id="detail"><table><thead><tr><th>班次</th><th>期次</th><th>单位</th><th>姓名</th><th>级别</th><th>评分</th><th>优先级</th><th>推荐理由</th></tr></thead><tbody id="dbody"></tbody></table></div></div></div>
 </div>
</div>
<div class="ft">本名单由规则引擎自动生成（硬规则过滤 + 软规则排序 + 单位名额约束），须经人工二次确认后方可作为调训依据。</div>
</div>
<script>
const KPIS=__KPIS__;
const REASONS=__REASONS__;
const SESSIONS=__SESSIONS__;
const UNITS=__UNITS__;
const DETAIL=__DETAIL__;
document.getElementById("kpis").innerHTML=KPIS.map(k=>
 `<div class="kpi" style="--kc:${k.c};--kg:${k.c}55"><div class="kv">${k.v}</div><div class="kl">${k.l}</div></div>`).join("");
function tagCls(p){if(p==="高")return"t1";if(p==="中")return"t3";return"t2";}
document.getElementById("dbody").innerHTML=DETAIL.map(d=>
 `<tr><td>${d[0]}</td><td>${d[1]}</td><td>${d[2]}</td><td class="nm">${d[3]}</td><td>${d[4]}</td><td>${d[5]}</td><td><span class="tag ${tagCls(d[6])}">${d[6]}</span></td><td><span class="tag ${tagCls(d[6])}">${d[7]}</span></td></tr>`).join("");
function tick(){const n=new Date(),p=s=>String(s).padStart(2,"0");
 document.getElementById("clk").textContent=`${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
 document.getElementById("dt").textContent=`${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} 星期${"日一二三四五六"[n.getDay()]}`;}
tick();setInterval(tick,1000);
const hasEC=typeof echarts!=="undefined";
const AX={axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#7ea6c8",fontSize:10},axisTick:{show:false},splitLine:{lineStyle:{color:"rgba(64,158,255,.1)"}}};
const TIP={backgroundColor:"rgba(6,22,40,.95)",borderColor:"rgba(64,158,255,.5)",textStyle:{color:"#cfe6f7",fontSize:12}};
function mk(id,opt){if(!hasEC){document.getElementById(id).innerHTML='<div style="padding:20px;color:#5d89ad;font-size:12px">图表组件加载失败（需联网加载 ECharts），数据详见右侧明细。</div>';return;}
 const c=echarts.init(document.getElementById(id));c.setOption(opt);setTimeout(()=>c.resize(),80);addEventListener("resize",()=>c.resize());}
mk("cReason",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},
 grid:{left:4,right:36,top:8,bottom:2,containLabel:true},
 xAxis:{type:"value",show:false},
 yAxis:{type:"category",inverse:true,data:REASONS.map(r=>r[0].length>10?r[0].slice(0,10)+"…":r[0]),axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#a9cbe4",fontSize:10},axisTick:{show:false}},
 series:[{type:"bar",data:REASONS.map(r=>r[1]),barWidth:9,
  label:{show:true,position:"right",color:"#7fd4ff",fontSize:10},
  itemStyle:{borderRadius:5,color:(p)=>{const cs=["#ff6b6b","#ff9f43","#f7c948","#37c8e8","#2f9bff","#a96bf2","#67e0a3","#8fa8bd","#ff8fab","#5ee7a0","#c084fc"];return cs[p.dataIndex%cs.length];}}}]});
mk("cSession",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},legend:{data:["计划人数","建议人数"],textStyle:{color:"#7ea6c8",fontSize:11},top:6,itemWidth:12,itemHeight:8},
 grid:{left:8,right:14,top:34,bottom:4,containLabel:true},
 xAxis:{type:"value",...AX},yAxis:{type:"category",inverse:true,data:SESSIONS.map(s=>s.n),axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#a9cbe4",fontSize:10.5},axisTick:{show:false}},
 series:[
  {name:"计划人数",type:"bar",data:SESSIONS.map(s=>s.p),barWidth:7,itemStyle:{color:"rgba(120,160,200,.35)",borderRadius:4}},
  {name:"建议人数",type:"bar",data:SESSIONS.map(s=>s.m),barWidth:7,barGap:"-100%",
   itemStyle:{borderRadius:4,color:new echarts.graphic.LinearGradient(0,0,1,0,[{offset:0,color:"#1565c0"},{offset:1,color:"#4fc3f7"}]),shadowColor:"rgba(79,195,247,.6)",shadowBlur:8},
   label:{show:true,position:"right",color:"#7fd4ff",fontSize:10,formatter:p=>`${p.value}/${SESSIONS[p.dataIndex].p}`}}]});
mk("cUnit",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"},formatter:p=>`${p[0].name}公司<br/>建议人次：<b style="color:#7fd4ff">${p[0].value}</b>`},
 grid:{left:8,right:8,top:26,bottom:2,containLabel:true},
 xAxis:{type:"category",data:UNITS.map(u=>u[0]),...AX,axisLabel:{color:"#a9cbe4",fontSize:10.5,interval:0}},
 yAxis:{type:"value",...AX},
 series:[{type:"bar",data:UNITS.map(u=>u[1]),barWidth:"52%",
  itemStyle:{borderRadius:[4,4,0,0],color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:"#5ee7a0"},{offset:1,color:"rgba(30,140,90,.15)"}]),shadowColor:"rgba(94,231,160,.5)",shadowBlur:8},
  label:{show:true,position:"top",color:"#8fe8b8",fontSize:10}}]});
(function(){const el=document.getElementById("detail");let d=0;setInterval(()=>{if(!el)return;d+=1;
 if(d>=el.scrollHeight-el.clientHeight){d=0;}el.scrollTop=d;},60);})();
</script>
</body></html>
"""


def write_advice_html(path, data):
    summary = data.get("summary", {})
    rules = summary.get("rules", {})
    kpis = [
        {"v": summary.get("plans"), "l": "计划期次", "c": "#2f9bff"},
        {"v": summary.get("total"), "l": "建议人次", "c": "#33d17a"},
        {"v": summary.get("excluded"), "l": "剔除人次", "c": "#ff6b6b"},
        {"v": len(rules.get("hard") or []) + len(rules.get("soft") or []), "l": "启用规则", "c": "#37c8e8"},
        {"v": summary.get("plansWithoutQuota"), "l": "无名额期次", "c": "#f7c948"},
    ]

    # 剔除原因按规则聚合
    reason_counter = {}
    unit_counter = {}
    detail = []
    sessions = []
    for plan in data.get("plans", []):
        for row in plan.get("excluded", []):
            key = row.get("ruleName") or row.get("rule") or "其它"
            reason_counter[key] = reason_counter.get(key, 0) + 1
        for row in plan.get("suggestions", []):
            unit = row.get("unitName") or "未填"
            unit_counter[unit] = unit_counter.get(unit, 0) + 1
            detail.append([plan.get("className"), plan.get("sessionNo"), unit, row.get("empName"),
                           row.get("cadreLevel"), row.get("score"), row.get("priority"),
                           "、".join(row.get("reasons") or []) or "常规匹配"])
        sessions.append({"n": f"{plan.get('className')} {plan.get('sessionNo')}",
                         "p": plan.get("planCount") or 0,
                         "m": len(plan.get("suggestions", []))})
    reasons = sorted(reason_counter.items(), key=lambda item: -item[1])
    units = sorted(unit_counter.items(), key=lambda item: -item[1])

    def strip_unit(name):
        return str(name or "").replace("公司", "")

    output = (ADVICE_TEMPLATE
              .replace("__ECHARTS__", echarts_script_tag(os.path.dirname(path)))
              .replace("__YEAR__", esc(data.get("year")))
              .replace("__PLANS__", esc(summary.get("plans")))
              .replace("__TOTAL__", esc(summary.get("total")))
              .replace("__GENERATED__", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
              .replace("__KPIS__", json.dumps(kpis, ensure_ascii=False))
              .replace("__REASONS__", json.dumps(reasons, ensure_ascii=False))
              .replace("__SESSIONS__", json.dumps(sessions, ensure_ascii=False))
              .replace("__UNITS__", json.dumps([[strip_unit(n), c] for n, c in units], ensure_ascii=False))
              .replace("__DETAIL__", json.dumps(detail[:400], ensure_ascii=False)))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(output)
    return path


# =========================================
# 统计看板 HTML
# =========================================
DASH_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>培小e·培训数据统计大屏 __YEAR__</title>
__ECHARTS__
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;background:#03121f;color:#cfe6f7;position:relative}
.bg{position:fixed;inset:0;z-index:0;background:
 radial-gradient(ellipse at 50% -10%,rgba(24,90,150,.35),transparent 55%),
 radial-gradient(ellipse at 15% 100%,rgba(16,70,120,.25),transparent 50%),
 radial-gradient(ellipse at 85% 100%,rgba(16,70,120,.25),transparent 50%)}
.bg::after{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(64,158,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(64,158,255,.05) 1px,transparent 1px);background-size:46px 46px}
.wrap{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;padding:0 1.1vw 1.1vh}
.hd{flex:0 0 auto;text-align:center;padding:1.3vh 0 0.5vh;position:relative}
.hd h1{font-size:clamp(20px,2.2vw,32px);letter-spacing:6px;font-weight:700;color:#fff;
 text-shadow:0 0 18px rgba(45,140,255,.8),0 0 40px rgba(45,140,255,.4)}
.hd .deco{height:12px;margin:6px auto 0;max-width:1400px;background:
 radial-gradient(ellipse at 50% 0,rgba(64,170,255,.55),transparent 70%);position:relative}
.hd .deco::before{content:"";position:absolute;left:0;right:0;top:5px;height:2px;background:linear-gradient(90deg,transparent,#2f9bff 30%,#7fd4ff 50%,#2f9bff 70%,transparent);box-shadow:0 0 12px #2f9bff}
.hd .sub{font-size:12px;color:#6f9cc0;letter-spacing:2px;margin-top:2px}
.hd .clock{position:absolute;right:8px;top:22px;text-align:right;font-size:12px;color:#7fb6dd;line-height:1.7}
.hd .clock b{font-size:18px;color:#eaf6ff;font-family:Consolas,monospace;letter-spacing:1px}
.hd .logo{position:absolute;left:14px;top:20px;display:flex;align-items:center;gap:8px}
.hd .logo .mark{width:34px;height:34px;border-radius:50%;border:2px solid #2f9bff;display:flex;align-items:center;justify-content:center;color:#7fd4ff;font-size:11px;font-weight:700;box-shadow:0 0 12px rgba(47,155,255,.6)}
.hd .logo span{font-size:12px;color:#8db8dc;letter-spacing:2px;line-height:1.5;text-align:left}
.kpis{flex:0 0 auto;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:10px 0}
.kpi{position:relative;background:linear-gradient(180deg,rgba(14,44,76,.85),rgba(8,26,46,.85));border:1px solid rgba(64,158,255,.28);padding:1.1vh 4px 0.9vh;text-align:center;clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px)}
.kpi::before{content:"";position:absolute;top:0;left:12%;right:12%;height:2px;background:linear-gradient(90deg,transparent,var(--kc,#2f9bff),transparent)}
.kv{font-size:clamp(14px,1.5vw,26px);font-weight:700;color:var(--kc,#2f9bff);text-shadow:0 0 14px var(--kg,rgba(47,155,255,.5));font-family:"DIN Alternate",Consolas,"Microsoft YaHei",monospace;line-height:1.2}
.kl{font-size:clamp(10px,0.78vw,12px);color:#7ea6c8;margin-top:0.5vh;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{flex:1;min-height:0;display:grid;grid-template-columns:30% 1fr 34%;gap:12px;overflow:hidden}
.col{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0}
.panel{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(10,34,58,.9),rgba(6,20,38,.92));border:1px solid rgba(64,158,255,.22);position:relative;overflow:hidden}
.panel::before,.panel::after{content:"";position:absolute;width:14px;height:14px;border-color:#3fa2ff;border-style:solid;z-index:2}
.panel::before{top:-1px;left:-1px;border-width:2px 0 0 2px}
.panel::after{bottom:-1px;right:-1px;border-width:0 2px 2px 0}
.pt{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(64,158,255,.18);background:linear-gradient(90deg,rgba(47,155,255,.16),transparent 65%)}
.pt i{width:4px;height:14px;background:linear-gradient(#7fd4ff,#2f9bff);box-shadow:0 0 8px #2f9bff}
.pt b{font-size:13.5px;color:#dff0ff;letter-spacing:2px;font-weight:600}
.pt em{margin-left:auto;font-style:normal;font-size:10.5px;color:#5d89ad;letter-spacing:1px}
.pc{flex:1;min-height:0;position:relative}
.chart{position:absolute;inset:0}
.tbl{position:absolute;inset:0;overflow:auto;padding:0 8px 8px}
.tbl::-webkit-scrollbar{width:4px}.tbl::-webkit-scrollbar-thumb{background:rgba(64,158,255,.35)}
table{width:100%;border-collapse:collapse;font-size:clamp(10px,0.78vw,12px)}
th{position:sticky;top:0;background:#0d2c4a;color:#7fc3ff;padding:0.7vh 4px;font-weight:600;letter-spacing:1px;border-bottom:1px solid rgba(64,158,255,.35);z-index:1}
td{padding:0.55vh 4px;text-align:center;color:#a9cbe4;border-bottom:1px dashed rgba(64,158,255,.12);white-space:nowrap}
tr:nth-child(even) td{background:rgba(20,60,100,.15)}
td.nm{color:#eaf6ff;font-weight:600}
.ft{flex:0 0 auto;margin-top:10px;border:1px solid rgba(64,158,255,.22);background:rgba(8,26,46,.9);padding:8px 14px;color:#5d89ad;font-size:12px;letter-spacing:1px}
@media (max-aspect-ratio:13/10){html,body{overflow:auto}.main{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(3,1fr)}.wrap{height:auto}body{padding-bottom:20px}}
</style></head><body>
<div class="bg"></div>
<div class="wrap">
<div class="hd">
 <div class="logo"><div class="mark">培</div><span>培小e<br>智能培训管理</span></div>
 <h1>培小e · 培训数据统计大屏</h1>
 <div class="deco"></div>
 <div class="sub">年度 __YEAR__ · 数据来源 培训数据库 · 生成于 __GENERATED__</div>
 <div class="clock"><b id="clk">--:--:--</b><br><span id="dt">--</span></div>
</div>
<div class="kpis" id="kpis"></div>
<div class="main">
 <div class="col">
  <div class="panel"><div class="pt"><i></i><b>干部级别分布</b><em>人员结构</em></div><div class="pc"><div class="chart" id="cLevel"></div></div></div>
 </div>
 <div class="col">
  <div class="panel" style="flex:1.25"><div class="pt"><i></i><b>各期次计划人数</b><em>__PLAN_TIP__</em></div><div class="pc"><div class="chart" id="cSession"></div></div></div>
  <div class="panel" style="flex:1.35"><div class="pt"><i></i><b>各单位领导人员分布</b><em>山东17地市</em></div><div class="pc"><div class="chart" id="cUnit"></div></div></div>
 </div>
 <div class="col">
  <div class="panel"><div class="pt"><i></i><b>各单位培训记录数</b><em>已入库记录</em></div><div class="pc"><div class="chart" id="cRec"></div></div></div>
 </div>
</div>
<div class="ft">数据来源：培训数据库（人员 / 计划 / 名额 / 记录 / 规则） · 本页由培小e自动生成</div>
</div>
<script>
const KPIS=__KPIS__;
const LEVELS=__LEVELS__;
const SESSIONS=__SESSIONS__;
const UNITS=__UNITS__;
const UNITREC=__UNITREC__;
document.getElementById("kpis").innerHTML=KPIS.map(k=>
 `<div class="kpi" style="--kc:${k.c};--kg:${k.c}55"><div class="kv">${k.v}</div><div class="kl">${k.l}</div></div>`).join("");
function tick(){const n=new Date(),p=s=>String(s).padStart(2,"0");
 document.getElementById("clk").textContent=`${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
 document.getElementById("dt").textContent=`${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} 星期${"日一二三四五六"[n.getDay()]}`;}
tick();setInterval(tick,1000);
const hasEC=typeof echarts!=="undefined";
const AX={axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#7ea6c8",fontSize:10},axisTick:{show:false},splitLine:{lineStyle:{color:"rgba(64,158,255,.1)"}}};
const TIP={backgroundColor:"rgba(6,22,40,.95)",borderColor:"rgba(64,158,255,.5)",textStyle:{color:"#cfe6f7",fontSize:12}};
function mk(id,opt){if(!hasEC){document.getElementById(id).innerHTML='<div style="padding:20px;color:#5d89ad;font-size:12px">图表组件加载失败（需联网加载 ECharts）</div>';return;}
 const c=echarts.init(document.getElementById(id));c.setOption(opt);setTimeout(()=>c.resize(),80);addEventListener("resize",()=>c.resize());}
mk("cLevel",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},
 grid:{left:8,right:26,top:10,bottom:4,containLabel:true},
 xAxis:{type:"value",...AX},
 yAxis:{type:"category",inverse:true,data:LEVELS.map(x=>x[0]),axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#a9cbe4",fontSize:10.5},axisTick:{show:false}},
 series:[{type:"bar",data:LEVELS.map(x=>x[1]),barWidth:11,
  label:{show:true,position:"right",color:"#7fd4ff",fontSize:10},
  itemStyle:{borderRadius:5,color:new echarts.graphic.LinearGradient(0,0,1,0,[{offset:0,color:"#1565c0"},{offset:1,color:"#4fc3f7"}]),shadowColor:"rgba(79,195,247,.5)",shadowBlur:8}}]});
mk("cSession",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},
 grid:{left:8,right:40,top:10,bottom:4,containLabel:true},
 xAxis:{type:"value",...AX},
 yAxis:{type:"category",inverse:true,data:SESSIONS.map(s=>s.n),axisLine:{lineStyle:{color:"rgba(64,158,255,.35)"}},axisLabel:{color:"#a9cbe4",fontSize:10.5},axisTick:{show:false}},
 series:[{type:"bar",data:SESSIONS.map(s=>s.p),barWidth:9,
  label:{show:true,position:"right",color:"#8fe8b8",fontSize:10},
  itemStyle:{borderRadius:4,color:new echarts.graphic.LinearGradient(0,0,1,0,[{offset:0,color:"#1e8c5a"},{offset:1,color:"#5ee7a0"}]),shadowColor:"rgba(94,231,160,.45)",shadowBlur:8}}]});
mk("cUnit",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},
 grid:{left:8,right:8,top:22,bottom:2,containLabel:true},
 xAxis:{type:"category",data:UNITS.map(u=>u[0]),...AX,axisLabel:{color:"#a9cbe4",fontSize:10.5,interval:0}},
 yAxis:{type:"value",...AX},
 series:[{type:"bar",data:UNITS.map(u=>u[1]),barWidth:"52%",
  itemStyle:{borderRadius:[4,4,0,0],color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:"#5ee7a0"},{offset:1,color:"rgba(30,140,90,.15)"}]),shadowColor:"rgba(94,231,160,.5)",shadowBlur:8},
  label:{show:true,position:"top",color:"#8fe8b8",fontSize:10}}]});
mk("cRec",{tooltip:{...TIP,trigger:"axis",axisPointer:{type:"shadow"}},
 grid:{left:8,right:8,top:22,bottom:2,containLabel:true},
 xAxis:{type:"category",data:UNITREC.map(u=>u[0]),...AX,axisLabel:{color:"#a9cbe4",fontSize:10,interval:0,rotate:38}},
 yAxis:{type:"value",...AX},
 series:[{type:"bar",data:UNITREC.map(u=>u[1]),barWidth:"52%",
  itemStyle:{borderRadius:[4,4,0,0],color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:"#4fc3f7"},{offset:1,color:"rgba(21,101,192,.15)"}]),shadowColor:"rgba(79,195,247,.5)",shadowBlur:8},
  label:{show:true,position:"top",color:"#7fd4ff",fontSize:10}}]});
</script>
</body></html>
"""


def write_dashboard_html(path, data):
    summary = data.get("summary", {})
    kpis = [
        {"v": summary.get("leaders"), "l": "领导人员总数", "c": "#2f9bff"},
        {"v": summary.get("plans"), "l": "培训计划期次", "c": "#37c8e8"},
        {"v": summary.get("planCount"), "l": "计划调训人次", "c": "#33d17a"},
        {"v": summary.get("records"), "l": "培训记录数", "c": "#a96bf2"},
        {"v": summary.get("quotas"), "l": "名额分配行数", "c": "#ff9f43"},
        {"v": summary.get("rules"), "l": "通用规则数", "c": "#f7c948"},
    ]
    plans = data.get("planCounts") or []
    sessions = [{"n": name, "p": count} for name, count in plans]
    output = (DASH_TEMPLATE
              .replace("__ECHARTS__", echarts_script_tag(os.path.dirname(path)))
              .replace("__YEAR__", esc(data.get("year")))
              .replace("__GENERATED__", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
              .replace("__PLAN_TIP__", esc(f"{len(plans)} 个期次"))
              .replace("__KPIS__", json.dumps(kpis, ensure_ascii=False))
              .replace("__LEVELS__", json.dumps(data.get("levels") or [], ensure_ascii=False))
              .replace("__SESSIONS__", json.dumps(sessions, ensure_ascii=False))
              .replace("__UNITS__", json.dumps(data.get("units") or [], ensure_ascii=False))
              .replace("__UNITREC__", json.dumps(data.get("unitRecords") or [], ensure_ascii=False)))
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(output)
    return path


# =========================================
# 规则审核表（写出 / 读回）
# =========================================
REVIEW_GUIDE = [
    "怎么审核",
    "1. 在「审核」表逐条核对：原文 → 中文复述 → 试算影响（剔除/加分了多少人、样例是谁）。",
    "2. 每个条款在任意一行的「审核结果」选：确认 / 修改 / 驳回，并在同一行「审核人」填写本人姓名（同一条款填一行即可）。",
    "   确认：照表格当前内容生效；修改：直接改条件行后选修改，以改后的为准；驳回：写清意见，退回重新识别。",
    "3. 改条件：同一「分支」里同一「或组」的行是“且”，不同或组是“或”；字段/指标、运算从下拉框选。",
    "   加条件：复制该条款的一行，改分支/或组/条件；删条件：整行删除。",
    "4. 动作：准入 = 必须满足否则剔除；剔除 = 满足就剔除；加分 = 满足就加「分值」（同一条款取第一个命中的加分分支）。",
    "5. 标记为「未识别」的行表示这句话没有变成筛选条件；确认即表示同意不执行，要执行请改成条件行。",
    "6. 「⚠」提示试算结果异常（无人受影响或全部剔除），请重点核对。",
    "7. 请用 Excel 或 WPS 打开、修改并保存本文件；程序改写的文件会被记为疑点。",
    "8. 审核完保存，执行：node index.js 规则 确认 \"<本文件路径>\"。已确认的条款下次不用再审，只有原文变化的才会重新出现。",
]

STATUS_FILL = {"待审核": "FFF4CC", "驳回": "FDE2E1", "已确认": "E8F5E9"}
# 审核表签发者：Excel/WPS 保存后「最后保存人」会变成用户名，仍是它说明文件未经 Excel/WPS 保存
ISSUER = "培小e"


def write_review_excel(path, data):
    if openpyxl is None:
        raise RuntimeError("未安装 openpyxl，无法生成审核表")
    from openpyxl.worksheet.datavalidation import DataValidation
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "审核"
    columns = data["columns"]
    style_header(ws, columns)
    widths = {"条款编号": 14, "来源": 13, "名称": 26, "适用期次": 22, "原文": 40, "状态": 8, "分支": 6,
              "动作": 7, "分值": 6, "理由": 22, "或组": 6, "字段/指标": 20, "参数": 26, "运算": 8,
              "值": 16, "中文复述": 44, "试算影响": 40, "标记": 24, "审核结果": 10, "审核人": 10, "意见": 26}
    for index, name in enumerate(columns, start=1):
        ws.column_dimensions[get_column_letter(index)].width = widths.get(name, 14)
    for row in data["rows"]:
        ws.append([row.get(name, "") for name in columns])
        fill = STATUS_FILL.get(row.get("状态"))
        line = ws.max_row
        for index in range(1, len(columns) + 1):
            c = ws.cell(row=line, column=index)
            c.alignment = Alignment(vertical="top", wrap_text=True)
            if fill:
                c.fill = PatternFill("solid", fgColor=fill)
        mark = ws.cell(row=line, column=columns.index("标记") + 1)
        if mark.value:
            mark.font = Font(color="C0392B", bold=True)

    # 字段字典 + 下拉框来源
    dic = wb.create_sheet("字段字典")
    style_header(dic, ["名称", "种类", "类型", "说明"])
    for item in data["dictionary"]["items"]:
        dic.append(item)
    dic.column_dimensions["A"].width = 22
    dic.column_dimensions["D"].width = 80
    dic.append([])
    dic.append(["类型", "可用运算"])
    for item in data["dictionary"]["ops"]:
        dic.append(item)
    lists = wb.create_sheet("下拉选项")
    for col, values in enumerate([data["dictionary"]["allOps"], data["dictionary"]["actions"],
                                  data["dictionary"]["decisions"]], start=1):
        for r, value in enumerate(values, start=1):
            lists.cell(row=r, column=col, value=value)
    lists.cell(row=1, column=5, value="审核单号")
    lists.cell(row=2, column=5, value=data.get("sheetId", ""))
    lists.sheet_state = "hidden"
    wb.properties.creator = ISSUER
    wb.properties.lastModifiedBy = ISSUER

    last = max(ws.max_row + 200, 500)
    item_count = len(data["dictionary"]["items"]) + 1

    def add_list(column_name, formula):
        dv = DataValidation(type="list", formula1=formula, allow_blank=True)
        letter = get_column_letter(columns.index(column_name) + 1)
        dv.add(f"{letter}2:{letter}{last}")
        ws.add_data_validation(dv)

    add_list("字段/指标", f"=字段字典!$A$2:$A${item_count}")
    add_list("运算", f"=下拉选项!$A$1:$A${len(data['dictionary']['allOps'])}")
    add_list("动作", f"=下拉选项!$B$1:$B${len(data['dictionary']['actions'])}")
    add_list("审核结果", f"=下拉选项!$C$1:$C${len(data['dictionary']['decisions'])}")
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{ws.max_row}"

    guide = wb.create_sheet("说明", 0)
    for line in REVIEW_GUIDE + ["", f"审核单号：{data.get('sheetId', '')}    年度：{data.get('year', '')}    "
                                    f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"] \
            + [f"{k}：{v}" for k, v in (data.get("overview") or {}).items()]:
        guide.append([line])
    guide.column_dimensions["A"].width = 120
    guide["A1"].font = Font(bold=True, size=14)
    wb.active = 1
    wb.save(path)
    return path


def read_file_meta(path):
    """审核表文件属性：保存程序、最后保存人、修改时间、文件哈希，用于判断是否经 Excel/WPS 由人保存"""
    import hashlib
    import re
    import zipfile
    meta = {"application": "", "lastModifiedBy": "", "modified": ""}
    with open(path, "rb") as handle:
        meta["sha256"] = hashlib.sha256(handle.read()).hexdigest()[:16]
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        app = z.read("docProps/app.xml").decode("utf-8", "ignore") if "docProps/app.xml" in names else ""
        core = z.read("docProps/core.xml").decode("utf-8", "ignore") if "docProps/core.xml" in names else ""
    for key, text, tag in [("application", app, "Application"), ("lastModifiedBy", core, "cp:lastModifiedBy"),
                           ("modified", core, "dcterms:modified")]:
        m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", text, re.S)
        if m:
            meta[key] = html_lib.unescape(m.group(1).strip())
    return meta


def read_review_excel(path):
    if openpyxl is None:
        raise RuntimeError("未安装 openpyxl，无法读取审核表")
    wb = openpyxl.load_workbook(path, data_only=True)
    sheet_id = ""
    if "下拉选项" in wb.sheetnames:
        sheet_id = str(wb["下拉选项"].cell(row=2, column=5).value or "")
    if "审核" not in wb.sheetnames:
        raise RuntimeError("找不到「审核」工作表，请使用 规则 审核表 生成的文件")
    ws = wb["审核"]
    header = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
    rows = []
    for index, values in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        if not any(v not in (None, "") for v in values):
            continue
        item = {"_row": index}
        for name, value in zip(header, values):
            if not name:
                continue
            if isinstance(value, datetime):
                value = value.strftime("%Y-%m-%d")
            elif isinstance(value, float) and value.is_integer():
                value = int(value)
            item[name] = value
        rows.append(item)
    meta = read_file_meta(path)
    meta["sheetId"] = sheet_id
    return rows, meta


def load_json(source):
    """读取数据 JSON；source 为 - 时从标准输入读取（不落过程文件）"""
    if source == "-":
        return json.loads(sys.stdin.buffer.read().decode("utf-8"))
    with open(source, "r", encoding="utf-8") as handle:
        return json.load(handle)


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
        data = load_json(args[1])
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
        data = load_json(args[1])
        path = write_dashboard_html(args[2], data)
        print(json.dumps({"ok": True, "files": [path]}, ensure_ascii=False))
        return
    if mode == "--review":
        data = load_json(args[1])
        print(json.dumps({"ok": True, "files": [write_review_excel(args[2], data)]}, ensure_ascii=False))
        return
    if mode == "--read-review":
        rows, meta = read_review_excel(args[1])
        print(json.dumps({"ok": True, "rows": rows, "meta": meta}, ensure_ascii=False, default=str))
        return
    print(json.dumps({"ok": False, "error": f"未知模式 {mode}"}, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
