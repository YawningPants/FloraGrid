import { lunarDate, normalizeReminderStore, updateReminderRule } from '../../src/domain/reminders.mjs';

export const scenarioDate = '2026-10-26';
const colors = { work: '#8fb6d3', family: '#d09aac', life: '#99b888', study: '#aaa0c8' };
const labels = { work: '工作', family: '家庭', life: '生活', study: '学习' };
const tag = (type) => ({ id: `tag-${type}`, text: labels[type], color: colors[type], source: 'template' });
const task = (id, title, type, status = 'active', children = []) => ({
  id,
  title,
  status,
  color: colors[type],
  tags: [tag(type)],
  children,
  collapsed: false,
  ...(status === 'completed'
    ? {
        completedAt: 1792980000000 + id.length,
        flower: {
          variant: ['wild', 'cosmos', 'plum', 'lily'][id.length % 4],
          tone: ['cream', 'rose', 'blue', 'lilac'][id.length % 4],
        },
      }
    : {}),
});
export function engineerScenario() {
  const days = new Map();
  const add = (date, tasks, note = '') => days.set(date, { date, tasks, note });
  add(
    scenarioDate,
    [
      task('onboarding', '入职第 1 周 · 跑通订单服务', 'work', 'active', [
        task('dev-env', '配好环境，跑通本地测试', 'work', 'completed'),
        task('order-flow', '跟读一次创建订单链路', 'work'),
        task('mentor', '把不懂的地方整理给导师', 'work'),
      ]),
      task('family-dinner', '下班后，和家人好好吃顿饭', 'family'),
      task('walk', '散步 20 分钟，顺路买牛奶', 'life'),
      task('sql', '写一页 SQL 执行计划笔记', 'study', 'active', [
        task('explain', '对比一次有无索引的查询', 'study', 'completed'),
        task('notes', '记下慢查询排查的三个步骤', 'study'),
      ]),
    ],
    '今天先把环境跑起来，不急着一次弄懂所有代码。\n记下订单状态流转的问题，明天请教导师。',
  );
  const earlier = [
    [2, '收拾新住处，留一张干净的桌子', 'life'],
    [4, '和家人一起做顿晚饭', 'family'],
    [6, '复习事务的四种隔离级别', 'study'],
    [8, '踩点通勤路线', 'life'],
    [10, '给爸妈打个电话', 'family'],
    [12, '把 Docker 环境搭起来', 'study'],
    [14, '办好入职体检', 'work'],
    [16, '整理租房和生活账单', 'life'],
    [18, '读完 Redis 入门笔记', 'study'],
    [20, '周末安排一次家庭采购', 'family'],
    [22, '准备证件和入职资料', 'work'],
    [24, '散步，给自己放个小假', 'life'],
    [25, '把下周的晚餐食材备好', 'family'],
  ];
  earlier.forEach(([day, title, type]) =>
    add(`2026-10-${String(day).padStart(2, '0')}`, [task(`earlier-${day}`, title, type, 'completed')]),
  );
  add('2026-10-27', [
    task('pair', '和导师结对，走读登录鉴权', 'work'),
    task('laundry', '洗衣服，整理明天的衣物', 'life'),
    task('locks', '读一节数据库锁与并发控制', 'study'),
  ]);
  add('2026-10-28', [
    task('small-pr', '完成第一个小修复，提一份 PR', 'work'),
    task('meal', '和家人试做一道新菜', 'family'),
  ]);
  add('2026-10-29', [
    task('review-pr', '跟进代码评审，补齐边界测试', 'work'),
    task('read-plan', '整理本周学到的 SQL 知识', 'study'),
  ]);
  add('2026-10-30', [
    task('week-note', '写下入职第一周的收获与问题', 'work'),
    task('movie', '晚上一起看一部电影', 'family'),
  ]);
  add('2026-10-31', [
    task('weekend', '上午采购，下午留给自己', 'life'),
    task('reading', '读完一节后端系统设计', 'study'),
  ]);
  const longTasks = [
    task('template-work', '发布前检查清单', 'work', 'active', []),
    task('template-study', '慢慢读完一本系统设计书', 'study'),
    task('template-family', '每周留一晚家庭时间', 'family'),
    task('template-life', '建立自己的运动习惯', 'life'),
  ];
  let reminders = normalizeReminderStore(null);
  const lunar = lunarDate('2026-10-29');
  reminders = updateReminderRule(
    reminders,
    {
      id: 'mum-birthday',
      startDate: scenarioDate,
      spec: {
        title: '妈妈的生日 · 记得打电话',
        kind: 'birthday',
        frequency: 'yearly',
        calendar: 'lunar',
        month: lunar.month,
        day: lunar.day,
        leapMonth: lunar.leap,
        color: colors.family,
        pinned: true,
      },
    },
    scenarioDate,
  );
  reminders = updateReminderRule(
    reminders,
    {
      id: 'weekly-review',
      startDate: scenarioDate,
      spec: {
        title: '周五晚，给自己做一次复盘',
        kind: 'routine',
        frequency: 'weekly',
        calendar: 'solar',
        weekdays: [5],
        color: colors.study,
        pinned: false,
      },
    },
    scenarioDate,
  );
  return {
    days: [...days.values()],
    longTasks: { version: 1, tasks: longTasks },
    templates: { version: 1, groups: [{ id: 'daily', name: '日常', tags: Object.keys(labels).map(tag) }] },
    reminders,
  };
}
