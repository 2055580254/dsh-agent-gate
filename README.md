# dsh-agent-gate

[![CI](https://github.com/GH_USER/dsh-agent-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/GH_USER/dsh-agent-gate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DSH bundle](https://img.shields.io/badge/DSH-host--only%20bundle-blue.svg)](docs/install.md)
![version](https://img.shields.io/badge/version-2.0.0-informational)

装在你自己的 DeepSeek Harness 上的一道**任务闸门**。三句话说清它干什么：

1. **先给方案，得到准许才动手**。没走 `task_plan` 并拿到 `approved`，`write / edit / pwsh / job_kill / plugin_manager` 这类变更类工具一律被拒（只读工具不受影响）。
2. **动手前先划边界**。全局硬边界（受保护路径、危险命令、硬禁工具）+ 本次任务的允许 skill / 允许工具 / 禁路径 / 动作预算，四层叠加，方案只能收紧不能放宽；你的使用习惯会被记进习惯库，重复出现后自动并入边界。
3. **任务中来了新指令，先判定再动手**。是「终止」就当场收尾；是「追加」就接着原任务干，不必重新立项。判定之前变更类工具被拦住。

4. **子代理也走同一套闸门**。派活前把【禁止】段写进 `boundaries.forbiddenPaths / forbiddenTools / allowedTools`；worker 在自己的会话里跑，闸门按 `gateSubagents` 放行（默认 `inherit`：沿用父会话最近一次准许的边界）。

一句话工作流：**探查（只读自由）→ `task_plan` → 用户点准许 → 执行（一步一 `task_step`）→ 新消息先 `task_instruction`**；需要并行时派 worker，按验收表判 PASS / PARTIAL / FAIL。

**装它**（Host-only bundle，无第三方依赖、无需构建）：

```
plugin_manager install_bundle，target = https://codeload.github.com/GH_USER/dsh-agent-gate/tar.gz/refs/heads/main
```

装完看 `application=applied` 且 `warnings` 为空，重启 DSH。细节与另外两条安装通道见 [docs/install.md](docs/install.md)；开发与发布流程见 [docs/publish.md](docs/publish.md)。

## v2.0.0 改了什么（当前）

把两个插件合并成**一个**：原来的 `dsh-task-guard`（任务闸门）与 `@local/preset-supervisor`（编排者契约）现在是同一个包，profile 里只留 `dsh-agent-gate` 一个条目。

| 项 | 合并前 | 合并后 |
| --- | --- | --- |
| systemPrompt | 两段各自 `sp.section()`（order 10100 / 220），冲突时没人仲裁 | 一个 section `agent-gate:protocol`，编排契约与闸门协议拼成一段 |
| 工具 | 4 个闸门工具 + 1 个 `agent_registry`，两条注册链 | 5 个工具在同一个 `installModules` 里注册 |
| 配置 | profile 两处（`- id: task-guard` 与 insert `preset-supervisor`） | 一处 `- id: agent-gate`，编排键并入 `normalizeConfig` |
| 子代理判定 | supervisor 认 `session.header.origin === 'subagent'`，闸门只认 `state.isSubagent`（恒 false，worker 全被锁） | 合流：闸门也认 origin，worker 走 `gateSubagents` 三档 |
| 代码 | 两个包各一份 section / context / hook | `lib/policy.js`（策略）+ `lib/orchestrator.js`（编排）+ `index.js`（组装） |

行为变化：worker 由闸门按 `inherit` 档放行（沿用父会话最近一次准许的边界），不再因为「没立项」被拦；父会话收到 worker 回报会被识别成委派结果（`isDelegatedReport`），不再被当成新用户指令锁住。

## v1.4.0 改了什么

| 改动 | 说明 |
| --- | --- |
| **状态持久化** | 阶段、方案、计划表、边界、预算会写到 `$DSH_PROFILE_DIR/task-guard/state/*.json`（600ms 防抖）。重载插件或重启 DSH 后自动恢复，不用重新立项。`statePath` 可改目录。 |
| **maxSteps 真正生效** | 计划步数超过 `maxSteps` 时截断，并在 `notes` 里写明「其余请另行立项」（此前只是存着）。 |
| **导出状态** | `task_guard_status(action=export)` 或 `/taskguard export` 把当前状态写成 `export-<会话>-<时间>.json`。 |
| **习惯库封顶** | `trimHabits()` 在保存时按权重保留前 200 条，噪声条目自动淘汰（此前会无限增长）。 |
| **对齐 1.3.0** | 删净 `awaiting_step` / `askStep` / `requestStep` / `stepApproved` / `stepGating` / `stepApprovalMode` / `/taskguard next` 的全部残留（1.3.0 只改了策略层，组件层这次补齐）。 |

## v1.3.0 改了什么

删掉「每一步做完再授权下一步」（`awaiting_step` 阶段、`step-approval` 闸门、逐步授权卡、`/taskguard next`），
只保留计划表 + progress：`task_step(action=complete)` 记账后直接推进下一步。

## v1.1.0 改了什么

**最要紧的一条**：准许框以前把整份方案（目标＋全部步骤＋验收＋边界＋预算）塞进问句，卡片会撑满界面把按钮顶出可视区，点不到。现在问句只留一行 `方案#3｜目标…（3 步 · 预算 40）`，完整方案降到卡片的 `detail` 里，可用 `maxApprovalSummaryChars` 调摘要长度、`approvalDetail:false` 直接不显示细节。

其余修复：

| 项 | 1.0.0 | 1.1.0 |
| --- | --- | --- |
| `gateSubagents` | 死配置，子代理永远卡在 no-approval | 三档真生效：`inherit`（默认，沿用最近一次人类准许的边界）／`gate`／`allow` |
| `profile` | 死参数 | `lite` 不设预算、`strict` 收紧工具面并强制预算、`standard` 原样 |
| 内容型参数 | `write.content`、`edit.new_string` 里出现受保护路径字样就被拦 | 按 key 分类：正文豁免，只扫路径型（`file_path`…）与命令型（`command`…） |
| 路径匹配 | 前缀无边界，`D:\archive` 命中 `D:\archive2` | 边界感知，前后都要求分隔符 |
| 动作预算 | 工具失败也扣 | `tools/result` 里失败即回滚 |
| 终止态 | 只能重新立项 | `task_instruction(kind=resume)` 直接恢复原方案，预算重置 |
| 并发提交 | 两张准许卡叠在一起 | 同会话第二张返回 `status=busy` |
| 习惯库 | 只能删文件 | `/taskguard habits reset`（或 `task_guard_status(action=habits-reset)`） |
| 终止措辞 | 漏「算了/不做了/停一下」 | 已补 |
| 上下文工具 | `compress` 等被闸门拦 | 归入只读豁免 |

---

## 一、安装

三条通道任选，装完都要看到 `application=applied` 且 `warnings` 为空。完整步骤、升级与排错见 **[docs/install.md](docs/install.md)**。

**通道 1：把 GitHub 地址交给 DSH（最快）**

> 用 plugin_manager install_bundle，target = `https://codeload.github.com/GH_USER/dsh-agent-gate/tar.gz/refs/heads/main`

想锁定版本就把 `heads/main` 换成 `tags/v1.4.0`。

**通道 2：clone 后装本地目录（要改代码、要看源码选这个）**

```bash
git clone https://github.com/GH_USER/dsh-agent-gate.git
```

> 用 plugin_manager install_bundle，target = `<clone 出来的绝对路径>`

装的是 link 依赖：改仓库里的源码后重启 DSH 就生效，`git pull` 即升级。

**通道 3：手工落盘（不经过 plugin_manager）**

把整个目录复制成 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-agent-gate\`（macOS/Linux 是 `~/.dsh/profiles/<profile>/node_modules/dsh-agent-gate/`），再在同一个 profile 的 `package.json` 里 `dsh.profile.bundles` 数组末尾追加 `"dsh-agent-gate"`，然后在 profile 的 `cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: task-guard
      name: dsh-agent-gate
      config:
        enabled: true
        mode: enforce
```

**装载自检**（不用启动 DSH，纯策略层）：

```powershell
cd E:\deepseekharness\workplace\dsh-agent-gate
node scripts/selftest.mjs        # 期望：全部通过
node --check index.js            # 期望：无输出
```

---

## 二、怎么用（对话侧）

### 2.1 开一个新任务

你随便说要做的事，DSH 会先做只读探查，然后弹一张「方案准许」卡（问句只有一行，完整方案在卡片的详情折叠区里）：

```
方案准许
方案#3｜把 README 补成完整使用手册（3 步 · 预算 40）
  [准许执行]  [修改方案]  [取消任务]
```

三个选项：

| 你点 | 效果 |
| --- | --- |
| **准许执行** | 进入 `approved`，闸门放行变更类工具，按计划表一路推进（1.3.0 起不再逐步要授权） |
| **修改方案** | 保持等待，DSH 会改方案后重新提交（`planRev+1`） |
| **取消任务** | 进入 `terminated`，DSH 只做收尾说明 |

你还可以在选项里写自定义文字，比如「步骤 2 换成先备份」，同样算「修改方案」。

### 2.2 计划表与 progress 怎么走（1.4.0）

准许之后是**计划表驱动**：`steps` 就是进度表，一次做一步，做完自己记账，不再逐步向你要授权。

```
你：把这套文档补齐
DSH：task_plan(3 步) → 你点「准许执行」
DSH：task_step(progress)      → 进度 0/3 ░░░░░░░░░░
DSH：（做第 1 步：读现有文档）
DSH：task_step(complete, summary="读完 4 个文档，缺配置表和排错")
     → 进度 1/3 ███░░░░░░░、自动进入第 2 步（无弹卡）
DSH：（做第 2 步）→ complete → （做第 3 步）→ complete → all-done
```

- **进度随时可看**：`task_step(action=progress)` 或 `/taskguard step`，输出像
  `进度 2/3 ██████░░░░` ＋ `✅ 1. 读现有文档 — 读完 4 个文档` ＋ `▶ 3. 写故障排查`。
  系统提示里也会自动注入这一行，模型不会忘。
- **不再有等待授权态**：1.3.0 删掉了 `awaiting_step` 阶段与 `step-approval` 闸门，
  做完一步立刻推进，`complete` 返回 `step-done`，最后一步返回 `all-done`。
- **计划内仍然受边界与预算约束**：`allowedTools` / `forbiddenPaths` / `maxActions` 照旧生效；动作超出方案要重新 `task_plan`。
- **跳过 / 重置**：`task_step(action=skip)` 记 ⏭ 继续下一步；`action=reset` 把计划表退回第 1 步。

### 2.3 任务进行中又发了消息

这是需求 3 的落点。DSH 的下一个动作必须是 `task_instruction`，四选一：

- `terminate` —— 你说「停止 / 取消 / 不用了 / 算了」这类。任务立刻置 `terminated`，闸门从此不再放行变更类工具，DSH 只能写收尾说明（做到哪、留下什么、怎么接）。
- `append` —— 你说「再加一节 FAQ / 顺便把 zh.json 也改」这类。追加项记进 `additions`，**接着原任务干**，不重新立项、不重述整份方案。
- `new_task` —— 明显是另一件事。清空当前方案回到 `idle`，必须重新 `task_plan`。
- `question` —— 只是问「刚才那个参数是什么」。回答完继续原任务，阶段不变。

**硬保证**：短消息里的终止措辞（`停止` `取消` `取消任务` `别做了` `不用了` `stop` `abort`）会在插件内部直接落 `terminated`，不等模型判定——所以即便模型想赖着继续干，闸门也会拦住。长句不会被误伤（`不要停止，继续跑完再给结论` 不算终止）。

**判定之前不许动手**：只要检测到新指令而 `task_instruction` 还没调，变更类工具返回拒绝，理由里写着 `pending-instruction`。

### 2.4 要不要用斜杠命令

模型侧全自动，命令是给你手动兜底和查看用的：

```
/taskguard             # 等同 show：当前阶段、方案、边界、预算消耗
/taskguard step        # 计划表进度（进度条 + 每步状态与摘要）
/taskguard export      # 把本会话任务状态导出成 JSON 文件（排查/备份用）
/taskguard approve     # 手动准许整份方案（弹窗失败时的救命路径）
/taskguard deny        # 否决并终止
/taskguard reset       # 清空本会话状态，回到 idle
/taskguard habits      # 看习惯库
/taskguard habits reset # 清空习惯库（自动提升的边界一并撤销）
/taskguard boundaries  # 看这次生效的合并边界（JSON）
/taskguard mode advisory   # 临时切成只提示不拦（调插件用）
/taskguard mode enforce    # 切回真拦
/taskguard off / on    # 临时停用/启用闸门（重启复原）
```

`mode` / `off` / `on` 是运行时临时改动，重启后回到 `cordis.patch.yml` 里的值。

---

## 三、模型侧工具参考

### `task_plan` —— 立项并征求准许

```jsonc
{
  "goal": "一句话目标，写清交付物",           // 必填
  "steps": ["步骤一（动作+产出）", "步骤二"],  // 必填，至少一条
  "acceptance": ["怎样算做完"],
  "notes": ["风险/假设/回滚方式"],
  "profile": "standard",                      // lite | standard | strict
  "boundaries": {
    "allowedSkills": ["office"],   // 本次只允许这些 skill，空=沿用全局
    "allowedTools": ["write"],     // 工具白名单，空=不限
    "forbiddenTools": ["job_*"],   // 禁工具，支持前缀通配
    "forbiddenPaths": ["D:\\secret"],
    "maxActions": 20,              // 动作预算，0=不限
    "notes": ["为什么这么划"]
  }
}
```

返回 `status`：

| status | 含义 | 模型该干什么 |
| --- | --- | --- |
| `approved` | 获准 | 按 steps 执行 |
| `revise` | 你要改方案 | 改完重新调用 `task_plan`（会重新征求准许） |
| `rejected` | 你取消 | 停手，简短说明现状 |
| `manual` | 弹不出窗（子会话 / 超时 / 非交互） | 把方案要点写给你，等你回「准许」，或你敲 `/taskguard approve` |
| `invalid` | 方案本身不成立（缺 goal/steps，或想放宽硬边界） | 修好再提交 |

### `task_step` —— 计划表与进度（1.4.0）

| action | 作用 | 返回 |
| --- | --- | --- |
| `progress` | 看计划表 | `progress`（进度条文本）、`stats`（total/done/skipped/settled）、`current`、`steps[]` |
| `complete` | 当前步做完 | `status=approved`（下一步已获授权）／`awaiting_approval`（弹不出卡，等文字准许）／`all-done` |
| `start` | 请求或确认当前步授权 | `continuing`（已授权）／`approved`（刚弹卡点了继续）／`awaiting_approval` |
| `skip` | 跳过当前步 | `awaiting_approval` + 下一步提示 |
| `reset` | 计划表退回第 1 步 | `ok` |

`complete` 必须带 `summary`（本步实际做了什么、产出在哪），它会进 progress 面板和下一张授权卡的详情，也是你回看「这步到底做成了没有」的依据。

### `task_instruction` —— 判定新指令

```jsonc
{
  "kind": "append",                  // terminate | append | new_task | question
  "instruction": "用户原话要点（数字/路径/命令照抄）",
  "additions": ["追加项一"],          // kind=append 时填
  "reason": "为什么这么判"
}
```

返回 `status`：`terminated` / `continuing` / `needs_plan` / `answering` / `invalid`。

`kind` 多了一档 `resume`：任务已经终止（terminated）之后，用户说「继续刚才那个」时用它——恢复原方案、预算重置，**不重新弹准许卡**。没有可恢复的方案时返回 `needs_plan`。

`task_plan` 多了一个 `status=busy`：同一会话上一张准许卡还没点掉时，再提交会被挡回来（避免两张卡叠在一起看不清点的是哪份）。

### `task_guard_status` —— 查状态

`action=show`（默认）看当前阶段与方案；`reset` 清空；`habits` 看习惯库；`boundaries` 看合并后的边界；`help` 出用法。

---

## 四、边界体系（需求 2）

边界分四层叠加，**自上而下只能收紧**：

| 层 | 来源 | 能否被方案放宽 |
| --- | --- | --- |
| 1. 硬边界 | 配置里的 `protectedPaths` / `dangerousCommands` / `hardForbiddenTools` | 不能 |
| 2. 全局默认白名单 | `defaultAllowedSkills` / `defaultAllowedTools` | 方案可覆盖为更严 |
| 3. 本次方案边界 | `task_plan` 的 `boundaries` | —— |
| 4. 习惯提升 | 习惯库里权重达阈值的限制项 | 自动并入，不能撤销 |

判定顺序（命中的第一条生效）：

```
停用 → 只提示模式 → 协议工具 → 跳过清单 → 只读工具
→ 已终止 → 新指令未判定 → 未获准许
→ 禁工具 → 工具不在白名单 → skill 不在白名单
→ 受保护路径 → 危险命令 → 预算用尽 → 放行
```

详细参数见 [`docs/config.md`](docs/config.md)。

### 受保护路径（默认）

`C:\Windows`、`C:\Program Files`、`C:\Program Files (x86)`、`C:\ProgramData`、`C:\Users\All Users`、`/etc`、`/usr`、`/bin`、`/sbin`、`/boot`、`/dev`、`/proc`、`/sys`。

匹配方式是**参数值里出现该前缀就拒**（对所有工具参数递归取字符串），所以 `write` 的 `file_path`、`pwsh` 的 `command` 都算。

### 危险命令（默认片段）

`rm -rf /`、`rm -rf ~`、`mkfs`、`dd if=`、fork bomb、`shutdown /s`、`Stop-Computer`、`Remove-Item -Recurse -Force C:\`、`del /f /s /q C:\`、`format /fs`。

---

## 五、习惯库（需求 2 的「根据用户习惯补充」）

文件位置：

```
%DSH_PROFILE_DIR%\task-guard\habits.json          # 本机是 C:\Users\梁硕\.dsh\profiles\desktop\task-guard\habits.json
~/.dsh/task-guard/habits.json                     # 没有 DSH_PROFILE_DIR 时
```

行为：

- 你**准许**一个带边界的方案 → 其中的 `allowedSkills` / `forbiddenTools` / `forbiddenPaths` / `notes` 各记一条，权重 +1。
- 你**否决**或**取消** → `rejections +1`。
- 你用终止措辞停任务 → `terminations +1`。
- 权重 ≥ `habitSuggestMinWeight`（默认 2）→ 作为「习惯补充」写进系统提示，DSH 会主动沿用。
- 权重 ≥ `habitPromoteThreshold`（默认 3）→ `forbiddenTools` / `forbiddenPaths` 类**自动并入生效边界**，方案再也不会碰它们。
- **skill 类习惯只提示、绝不自动放宽**：skill 白名单永远是收紧方向。

`/taskguard habits` 或 `task_guard_status(action=habits)` 可以看当前权重，项目里给了样例文件 [`docs/habits.example.json`](docs/habits.example.json)。想重置就删掉这个 json（插件按空库继续跑）。

---

## 六、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 所有写操作都被拒，理由 `TASK_GUARD_NO_APPROVAL` | 还没 `task_plan`，或方案没获准 | 让 DSH 调 `task_plan`；或弹窗坏了就 `/taskguard approve` |
| 理由 `TASK_GUARD_PENDING_INSTRUCTION` | 有新消息没判定 | 必须先 `task_instruction` |
| 理由 `TASK_GUARD_SKILL_NOT_ALLOWED` | 加载了白名单外 skill | 换 skill，或重提 `task_plan` 放宽（global 默认白名单为严） |
| 理由 `TASK_GUARD_PROTECTED_PATH` | 参数命中受保护路径 | 换路径；这条不能被方案放宽，只能改配置 |
| 理由 `TASK_GUARD_BUDGET_EXHAUSTED` | 动作预算用满 | 收尾，或提高 `maxActions` 重提方案 |
| 弹窗从来不出现 | 子会话 / 非交互 / `userQuestions` 不可用 | 插件自动降级为 `manual`：你打字「准许」或在界面敲 `/taskguard approve` |
| 太烦，想先关掉 | —— | `/taskguard mode advisory`（只提醒不拦）或 `/taskguard off` |
| 装了没反应 | bundle 没生效 | 看 DSH 日志里有没有 `[task-guard] 已加载`；没有就重启 |
| 准许卡太大挡住界面、点不到按钮 | 1.0.0 把整份方案塞进问句 | 1.1.0 已压成单行摘要（细节进 `detail`）；应急可 `/taskguard approve` 绕过卡面 |
| `task_plan` 返回 `status=busy` | 上一张准许卡还没点掉 | 先处理那张卡，或 `/taskguard approve` / `/taskguard deny` |
| 子代理改不了文件 | 1.0.0 的 `gateSubagents` 未实现 | 1.1.0 默认 `inherit`：子代理沿用你最近一次准许的边界继续干 |

临时绕闸门：`/taskguard off`。**注意**：关掉后终止措辞的硬保证也一并失效，别再指望它兜底。

---

## 七、卸载

在 DSH 里说：

> 用 plugin_manager，action = remove_bundle，target = dsh-agent-gate

或删掉 profile `node_modules\dsh-agent-gate` 与 `cordis.patch.yml` 里那行 `task-guard`。习惯库 `task-guard\habits.json` 独立存在，删不删随意。

---

## 八、已知边界

- 闸门只管**工具调用**。纯文本回答、思考过程不拦——所以「先给方案」靠 `task_plan` 的弹窗做硬约束，不靠文字礼貌。
- `manual` 降级路径依赖你打字「准许」；如果你的措辞不在默认模式里（`准许/批准/同意/可以/行/执行/通过/ok/yes`），直接 `task_instruction` 或 `/taskguard approve` 更省事。
- 预算按「放行的变更类动作次数」计，只读工具不消耗。
- 习惯库是**按机器/配置档案**共享的，不按项目分。多项目混用时，把不想全局生效的边界写在方案里而不是让它升权。
- `mode` / `on` / `off` 是运行时状态，重启回落到配置文件。

---

## 九、文件清单

```
dsh-agent-gate/
├── index.js                 Host 半边：闸门、指令侦测、工具、prompt 段、斜杠命令
├── lib/policy.js            纯策略层：配置/方案/边界/判定/习惯/渲染（无 Host 依赖）
├── cordis.patch.yml         bundle 补丁：插入 task-guard 插件行与默认配置
├── package.json             包清单（exports / files / dsh.bundle.patch）
├── locale/en.json           英文展示名与描述
├── locale/zh.json           中文展示名与描述
├── icon.svg                 图标（盾牌 + 对勾 + 时限徽标）
├── README.md                本手册
├── CHANGELOG.md             版本变更记录
├── CONTRIBUTING.md          参与开发的三条铁律与目录约定
├── LICENSE                  MIT
├── .github/workflows/ci.yml CI：Ubuntu/Windows × Node 20/22，跑语法检查、自测、清单校验
├── docs/install.md          给使用者的安装 / 升级 / 卸载指南
├── docs/publish.md          给自己的 GitHub 发布指南（含三种推送通道与常见拦截）
├── docs/config.md           配置项逐条说明
├── docs/architecture.md     机制与判定顺序、时序图
├── docs/habits.example.json 习惯库样例（脱敏）
├── scripts/selftest.mjs     纯策略层自测（node scripts/selftest.mjs）
├── scripts/publish.ps1      Windows 一键发布（预检 → 提交 → 打标签 → 推送）
└── scripts/publish.sh       macOS / Linux / Git Bash 一键发布
```

---

## 十、文档索引

| 想知道什么 | 看哪 |
| --- | --- |
| 怎么装、怎么升级、怎么卸 | [docs/install.md](docs/install.md) |
| 怎么把改动发到 GitHub（三种通道 + 常见拦截） | [docs/publish.md](docs/publish.md) |
| 每个配置项什么意思、准许卡怎么调小 | [docs/config.md](docs/config.md) |
| 判定顺序、参数分类、子代理策略、设计约束 | [docs/architecture.md](docs/architecture.md) |
| 改代码要注意什么、怎么加断言 | [CONTRIBUTING.md](CONTRIBUTING.md) |
| 每个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |

## 十一、许可证

MIT，见 [LICENSE](LICENSE)。
