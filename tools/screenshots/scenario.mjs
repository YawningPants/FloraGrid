import { lunarDate, normalizeReminderStore, updateReminderRule } from '../../src/domain/reminders.mjs';
import { getTaskFlower } from '../../src/domain/flowers.mjs';

export const scenarioDate = '2026-10-26';
export const featuredTaskId = 'refund-design';
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
        completedAt: Date.parse(`${scenarioDate}T10:10:00+08:00`) + id.length * 1000,
        flower: getTaskFlower({ id }),
      }
    : {}),
});

// Fictional release-week data for the isolated screenshot/QA browser only.
// Narrative source: docs/截图示例计划.md. Never seed a native user profile.
export function engineerScenario() {
  const days = new Map();
  const add = (date, tasks, note = '') => days.set(date, { date, tasks, note });
  const agentStudy = task('agent-study', 'Claude Code：试用子代理', 'study', 'active', [
    task('agent-docs', '阅读子代理配置与权限说明', 'study', 'completed'),
    task('agent-review', '跑通只读代码审查示例', 'study', 'completed'),
    task('agent-tools', '整理 Agent 的工具使用边界', 'study', 'completed'),
    task('agent-auth', '让只读子代理梳理鉴权链路', 'study'),
  ]);
  agentStudy.collapsed = true;
  const resolvedBug = task('refund-bug', '修复退款列表重复记录', 'work', 'completed', [
    task('bug-reproduce', '复现翻页后重复展示的问题', 'work', 'completed'),
    task('bug-regression', '补充分页去重的回归用例', 'work', 'completed'),
  ]);
  resolvedBug.collapsed = true;
  add(
    scenarioDate,
    [
      task(featuredTaskId, '退款重试需求设计', 'work', 'active', [
        task('refund-state', '梳理退款状态与补偿流程', 'work', 'completed'),
        task('refund-boundary', '补齐幂等、重试次数与告警规则', 'work', 'completed'),
        task('refund-errors', '和产品确认异常退款的处理口径', 'work'),
      ]),
      resolvedBug,
      agentStudy,
      task('groceries', '下班买水果、酸奶和面包', 'life'),
      task('refund-meeting', '10:00 退款需求串讲会', 'work', 'completed'),
    ],
    '超时不一定等于退款失败，补偿前先确认支付侧的状态。\n下班买好明天的早餐，晚上只试一个 Agent 功能。',
  );

  const history = [
    [1, [['给家里打个电话', 'family']]],
    [2, [['买一双通勤袜和一件衬衫', 'life']]],
    [4, [['公园慢跑 3 公里', 'life']]],
    [5, [['阅读 Agent Skills 入门文档', 'study']]],
    [6, [['学习 OAuth 2.0 授权码', 'study']]],
    [8, [['整理十月需求池', 'work']]],
    [9, [['版本例会：十月排期', 'work']]],
    [10, [['周末买水果和早餐', 'life']]],
    [11, [['OpenCode：配置项目规范', 'study']]],
    [
      12,
      [
        ['订单导出需求串讲会', 'work'],
        ['读懂 OAuth 2.0 授权码流程', 'study'],
      ],
    ],
    [
      13,
      [
        ['订单导出需求设计', 'work'],
        ['修复订单筛选异常', 'work'],
      ],
    ],
    [
      14,
      [
        ['编写异步导出接口', 'work'],
        ['学习 PKCE 的授权码保护机制', 'study'],
      ],
    ],
    [
      15,
      [
        ['版本例会：订单导出', 'work'],
        ['下班买牛奶、鸡蛋和咖啡', 'life'],
      ],
    ],
    [
      16,
      [
        ['变更：订单导出上线', 'work'],
        ['观察导出耗时与告警', 'work'],
      ],
    ],
    [17, [['买一件换季长袖', 'life']]],
    [
      18,
      [
        ['轻松跑 3 公里', 'life'],
        ['和家里打个电话', 'family'],
      ],
    ],
    [19, [['售后工单需求串讲会', 'work']]],
    [
      20,
      [
        ['工单流转需求设计', 'work'],
        ['阅读 MCP 的工具调用示例', 'study'],
      ],
    ],
    [21, [['编写工单流转代码', 'work']]],
    [
      22,
      [
        ['版本例会：梳理遗留 bug', 'work'],
        ['OpenCode：跑通一个小任务', 'study'],
      ],
    ],
    [
      23,
      [
        ['变更：工单灰度发布', 'work'],
        ['修复 Token 过期提示', 'work'],
      ],
    ],
    [24, [['去挑一双通勤鞋', 'life']]],
    [
      25,
      [
        ['采购水果、蔬菜和早餐', 'life'],
        ['慢跑 4 公里，拉伸放松', 'life'],
      ],
    ],
  ];
  for (const [day, entries] of history) {
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    add(
      date,
      entries.map(([title, type], index) => ({
        ...task(`history-${day}-${index}`, title, type, 'completed'),
        completedAt: Date.parse(`${date}T18:00:00+08:00`) + index * 60000,
      })),
    );
  }
  add('2026-10-27', [
    task('refund-code', '编写退款重试与补偿接口', 'work'),
    task('pagination-bug', '修复空结果分页异常', 'work'),
    task('pkce-study', 'OAuth 2.0：梳理 PKCE 流程', 'study'),
  ]);
  add('2026-10-28', [
    task('refund-integration', '退款重试联调验证', 'work'),
    task('mcp-study', '阅读 MCP 的权限边界', 'study'),
    task('autumn-basics', '买换季长袖和袜子', 'life'),
  ]);
  add('2026-10-29', [
    task('release-meeting', '版本例会：退款重试', 'work'),
    task('callback-bug', '修复重复回调通知', 'work'),
  ]);
  add('2026-10-30', [
    task('refund-release', '变更：退款重试上线', 'work'),
    task('release-watch', '观察告警与回滚指标', 'work'),
  ]);
  add('2026-10-31', [
    task('autumn-coat', '去买一件秋季外套', 'life'),
    task('park-run', '公园慢跑 5 公里', 'life'),
  ]);
  const longTasks = [
    task('template-work', '订单中心拆分与历史数据迁移', 'work'),
    task('template-study', '学完 OAuth 2.0 与 OIDC 实战课', 'study'),
    task('template-strength', '每周做两次力量训练', 'life'),
    task('template-run', '从轻松跑 3 公里练到 5 公里', 'life'),
  ];
  let reminders = normalizeReminderStore(null);
  const lunar = lunarDate('2026-10-29');
  reminders = updateReminderRule(
    reminders,
    {
      id: 'mum-birthday',
      startDate: scenarioDate,
      spec: {
        title: '妈妈生日 · 打个电话',
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
        title: '周五复盘：记下本周的坑',
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
    templates: {
      version: 1,
      groups: [
        { id: 'work-study', name: '工作与学习', tags: ['work', 'study'].map(tag) },
        { id: 'daily', name: '日常生活', tags: ['life', 'family'].map(tag) },
      ],
    },
    reminders,
  };
}
