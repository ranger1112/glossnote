# GlossNote 文档

这个目录只放项目级文档，不重复代码里已经写清楚的东西。

| 文档 | 回答的问题 | 什么时候看 |
| --- | --- | --- |
| [product-design.md](product-design.md) | 为谁做、做什么、不做什么 | 讨论需求与范围时 |
| [architecture.md](architecture.md) | 系统怎么搭、数据怎么存、锚定怎么保证 | 动手前、改结构前 |
| [implementation-plan.md](implementation-plan.md) | 先做什么、验收标准、现在到哪 | 每次开工前 |
| [decisions.md](decisions.md) | 为什么这样选、放弃了什么 | 想推翻某个决定时 |

维护约定：

- 一个事实只写在一处：范围看产品设计，结构看架构，进度看计划，理由看决策。
- 推翻决定时先改 `decisions.md`，再同步架构或计划。
- 当前状态以 `implementation-plan.md` 为准；根目录 README 只做入口，不复述细节。
- 文档里的日期一律写绝对日期，不写“上周”“最近”。
