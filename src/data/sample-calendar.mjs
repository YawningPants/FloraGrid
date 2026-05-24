export const tagPalette = {
  工作: '#8fb6d3',
  项目A: '#8fc2b9',
  学习: '#aaa0c8',
  健康: '#99b888',
  设计: '#d0aa7e',
  生日: '#d09aac',
  复盘: '#abb9c2',
};

export const sampleDay = {
  date: '2026-05-22',
  title: '2026年5月22日 周五',
  subtitle: '农历四月初六 · 小满后 · 休息日',
  note: '明日灵感\n\n日视图先稳定层级和状态排序。\n后续把拖拽与 JSON 存储接进同一套任务模型。',
  tasks: [
    {
      id: 'review',
      title: '准备产品需求评审材料',
      status: 'active',
      tags: ['工作', '项目A'],
      children: [
        {
          id: 'prototype',
          title: '重写交互原型',
          status: 'active',
          tags: ['工作', '项目A', '学习'],
        },
        {
          id: 'rules',
          title: '确认日视图状态排序',
          status: 'completed',
          tags: ['工作'],
        },
        {
          id: 'visual',
          title: '今晚完成视觉定稿',
          status: 'failed',
          tags: ['工作', '学习'],
        },
        {
          id: 'old-bloom',
          title: '旧版完成动效方案',
          status: 'deleted',
          tags: ['设计'],
        },
      ],
    },
    {
      id: 'boundaries',
      title: '整理桌面日历应用的交互边界，并确认拖拽、标签继承、软删除后的排序规则',
      status: 'active',
      tags: ['工作', '项目A', '学习', '复盘', '工作', '设计'],
      long: true,
    },
    {
      id: 'minutes',
      title: '完成会议纪要',
      status: 'completed',
      tags: ['工作'],
    },
    {
      id: 'vendor',
      title: '联系供应商确认报价',
      status: 'failed',
      tags: ['工作'],
    },
    {
      id: 'archived',
      title: '废弃的每日打卡模板',
      status: 'deleted',
      tags: ['复盘'],
    },
  ],
};
