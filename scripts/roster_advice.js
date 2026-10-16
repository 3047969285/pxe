// =====================================================
// roster_advice.js —— 建议名单（应训未训比对）
// 框架占位：两库数据到位后填充实现
// =====================================================

// 比对逻辑示意：
//   1) 从库B取通知要求（培训班次、对象层级、人数要求）
//   2) 从库A取各单位已参训人员（同班次/层级）
//   3) 计算缺口：应训对象中未参训/未达标的人 → 建议名单
//   4) 输出 名单Excel + 说明HTML，按单位/层级分组
function compare(actualRows, noticeRows, rangeText) {
  console.log(`[培小e] 建议名单比对(框架占位, 范围: ${rangeText || '全部'})`);
  // const gap = noticeRows.map(n => ({
  //   ...n,
  //   缺口人数: n.人数要求 - countActual(n, actualRows),
  //   建议名单: findMissing(n, actualRows),
  // }));
  return [];
}

module.exports = { compare };
