# 验收记录

本文件记录**实际跑过**的东西与读数，不是计划。命令、读数、结论一一对应。

## 1. 规则引擎

```
pnpm test
```

`test/rules.test.ts` 31 条 + `test/ai.test.ts` 9 条 = **40 条，全绿**。

> 加入开始界面与定先后的那一轮（见 §7）之后：`rules` 32 + `ai` 9 + `tray` 5 + `spin` 10 = **56 条，全绿**。
>
> 加入霞鹜文楷、加载页与终局揭示的那一轮（见 §8）之后：`rules` 32 + `ai` 9 + `tray` 6 + `spin` 10 = **57 条，全绿**。

其中最有分量的一条是 **走法/攻击检测的正交校验**：`isSquareAttacked()` 是一个为了速度写的手工扫描
（四条射线 + 马腿 + 兵的三个来源 + 斜行子），而 `generateMoves()` 是直白的走法生成。测试用前者
无法作弊的口径做 oracle：**在待测格子上放一个敌方棋子，再问"有谁吃得掉它"** ——
这正好给出"能否被吃"的语义（炮需要炮架，车不需要）。两者在 **6 局随机对局的 50 步里、每个格
子、每一方**逐一比对，实测比对次数 **> 5000**，全部一致。

这条校验在本轮开发中抓出了一个真 bug：象的"象眼"在攻击检测里算错了位置（算成 `3×偏移`
而不是中点），导致飞象的攻击范围整体错位。修好后 oracle 立刻转绿。

其他关键用例：

| 规则 | 用例 |
| ---- | ---- |
| R2/R3 摆子 | 32 子、30 暗、将帅明子落在原点、身份多重集守恒 |
| R4 暗子按格位走 | 车位的暗子整条线可走；兵位的暗子只能前进一步（**且用镜像局面做阳性对照**：兵身份的暗子在车位能像车一样滑） |
| R4 不变式 | 每个暗子的 `homeKind` 恒等于它所在格的种类（这正是 Zobrist 不需要哈希 `homeKind` 的原因） |
| R5 走子即翻开 | 翻开后 `hidden=false`，且**该身份从信息池里消失**（池 15 → 14） |
| R7 吃暗子不公开 | `captured.kind === null`，身份仍留在对方池里，永远无法定位 |
| R8 明仕/明相过河 | 明仕出九宫、明相跳河都成立 |
| R9 暗仕/暗相受限 | 暗仕不能出九宫；暗相不能过河 |
| R10 困毙判负 | 手工构造的困毙局面（两个过河兵封住九宫、一个兵挡住将帅照面）判红胜 |
| 白脸将 | 同列无阻挡即非法；被挡住即合法 |
| 牵制 | 被车牵住的马一步都不能走，而**抽掉车后同一个马立刻恢复自由**（阳性对照） |
| 信息池守恒 | 三局随机对局每一步断言 `|池| = 盘上暗子 + 被吃的暗子` |
| 悔棋 | 悔完棋盘、Zobrist 键、信息池、回合、结果全部回滚 |

### 1.1 与 Pikafish 揭棋分支的交叉印证

规则解释最容易出错的地方是"暗子按格位走"这条。本仓库另外对照了**生产级引擎**凤凰（Pikafish）
的 `jieqi` 分支（开源客户端 JieqiBox 用的引擎），四处关键代码与本实现逐条吻合：

| Pikafish | 本仓库 |
| -------- | ------ |
| `DarkPieces("RNBAKABNR"…)`：暗子类型 = 所在格位的类型 | `Piece.homeKind`，由 `START_SQUARES` 在发牌时定下 |
| `type_of(piece_on(from)) == ADVISOR && move_dark(m) && !(Palace & to)`：**暗**仕受九宫限制 | `MovementMode = 'classic'` for hidden advisors |
| `st->captureDark = is_dark(to)`：被吃的暗子只清 DARK 位、不翻面 | `MoveEvent.captured.kind = null` |
| `Zobrist::psq[DARK_PIECE][from]`：暗子按格位哈希 | `homeKind` 恒等于格位类型 → 不进 Zobrist 键 |

这是"规则解释没错"这件事最有力的一条外部证据：一个被广泛使用的引擎独立地做了同样的建模。

## 2. AI

```
pnpm test -- test/ai.test.ts
```

| 判据 | 读数 |
| ---- | ---- |
| 一步杀找得到 | 构造局面下选出唯一杀着，评分 `> MATE - 50`，`apply` 后 `result.kind === 'checkmate'` |
| 白吃车 | 构造局面下吃掉无保护的车 |
| 永不走非法着 | 三局随机游走中每 3 步插入一次 AI 决策，逐个与 `legalMoves()` 对照 |
| 可复现 | 同 seed 的两次决策着法与评分完全一致 |
| 随机性存在但很小 | 12 个 seed 下选出至少 2 种不同着法；且每次选择距离最优不超过 200 厘兵 |
| 自对弈 | 6 局 `easy` 全部跑到终局，无一非法着、无异常 |
| **有智商** | `normal` 对随机走子 **6 胜 0 负 0 和** |

延迟（桌面 Chrome，`vitest` 计时）：

| 难度 | 每步耗时（中位 / 最大） | 节点数 | 世界数 × 深度 |
| ---- | ---------------------- | ------ | ------------- |
| 简单 | 26 ms / 67 ms | 7 k | 6 × 2 |
| 普通 | 341 ms / 762 ms | 92 k | 10 × 3 |
| 困难 | 1622 ms / 1803 ms | 397 k | 12 × 4 |

困难档一秒多不能冻住画面，所以 `chooseMoveAsync()` 在**每个采样世界之间**让出一帧
（PIMC 天然是"若干独立样本求平均"，让出点就在这里）。世界之间互不影响，让出改变了卡顿的粒度，
不改变答案。

## 3. 浏览器验收（Playwright）

两轮：开发服务器（`pnpm dev` → `:5180`）一轮，**构建产物**（`vite preview` → `:4174`）一轮。
第二轮更重要 —— 它跑的就是打进 APK 的那份 bundle。竖屏视口 640×960，画布 480×960。

### 3.1 真实指针走一步

不做任何"绕过 UI"的调用，直接用 `page.mouse` 点画布坐标（坐标由后门 `__JIEQI__.point()` 给出）：

| 步骤 | 读数 |
| ---- | ---- |
| `mouse.move/down/up` 点 `(4,6)` | `state().selection === "4,6"` |
| 再点 `(4,5)` | 着法成立 |
| 等动画结束 | `ply = 2`，`history = ["暗兵五进一", "暗炮二进七"]`，`turn = "red"` |
| 运行时错误 | **0** |

`暗兵五进一` 与 QQ 官方《揭棋开局攻略》推荐的首着写法逐字一致 —— 记谱、暗子按格位命名、
以及"走完才翻开"这条链是通的。

### 3.2 整局

```
await __JIEQI__.autoPlay(25, 'easy')   // 逐段推进，直到终局
```

| 服务 | 难度 | 总步数 | 结果 | 运行时错误 | 耗时 |
| ---- | ---- | ------ | ---- | ---------- | ---- |
| `pnpm dev`（:5180） | 简单 | **58** | `红方被将死` | **0** | 33.7 s |
| `vite preview`（:4174，即 APK 里的那份） | 简单 | **74** | `红方被将死` | **0** | 40.7 s |
| `pnpm dev`（:5180），竖屏 420×880 | **普通** | **96** | `红方被将死` | **0**（控制台 188 条消息、**错误 0**、警告 0） | 49.5 s |

三局都在两个不同的竖屏尺寸（640×960 与 420×880）下跑通：**棋盘、HUD、棋谱在两种尺寸下都没有
重叠或越界**，按钮与文字都完整可读。

开发档终局局面用后门逐子核对过：黑车在 `(8,9)` 沿底线将军，红帅在 `(4,9)` 被自己的相 `(4,8)`
堵住退路，`(3,9)` 也是自己的暗子，`(5,9)` 仍在车的射程内，红方 23 个合法着法全部消失 ——
确实是将死，不是误判。

### 3.3 按钮链路（构建产物上实测）

| 动作 | 读数 |
| ---- | ---- |
| `hint()` | 返回排名着法（`暗车一平二` 43 分 / `暗炮八进七` 3 分），棋盘上高亮最佳着法 |
| `undo()` | `ply` 2 → **0**，棋盘、信息池、棋谱、被吃子托盘一起回滚 |
| 真实点击走子 | `selection === "4,6"` → 落子 → `history[0] === "暗兵五进一"`（与点击前算出的记谱逐字一致） |
| 浏览器控制台 | 198 条消息，**错误 0**（构建产物下框架的开发期日志已静默） |

### 3.4 本轮的缺陷与修复

| # | 现象 | 根因 | 修法 |
| - | ---- | ---- | ---- |
| V1 | `settle()` 报 "timed out" | `settled` 用"零 tween"作判据，而**合法落点的脉动光圈与将军红光本身是无限循环 tween**，粒子也要多活几百毫秒 | `BoardView` 自己数"在飞的棋子动画"（`pending`），`settled = 流程空闲 && 棋子静止`；装饰性 tween 不再参与判定 |
| V2 | 象的攻击范围整体错位 | `isSquareAttacked` 里象眼算成 `攻击者 + 偏移` 而不是中点 | 由 §1 的 oracle 抓出并修好 |
| V3 | 飞将规则污染了"能否被吃"的语义 | 把白脸将当作"将沿列攻击"，于是任意两将之间的空格都被判为"被攻击" | 拆成 `kingsFaceEachOther()` 与 `isSquareAttacked()` 两个独立概念，由 `isKingSafe()` 组合 |
| V4 | 长对局里棋谱列表无限增长 | `List` 未开虚拟化 | `virtualize: true` + `itemExtent` |
| V5 | 「新局」和「认输」看起来一模一样 | 主题里 `primary` 与 `danger` 都是红 | `primary` 改成青玉 |

## 4. 音乐与音效

`scripts/build-audio.sh` 生成 `public/audio/`：背景音乐（m4a → mp3，3:03，44.1 kHz 立体声 128 kbps）
与十一段音效（GameBurp WAV 母版 → mp3）。实测 12 个文件全部落在 `dist/audio/`，共 3.2 MB。

### 4.1 播放链路（Chrome，Playwright）

| 判据 | 读数 |
| ---- | ---- |
| 音频文件解码 | `cache.audio` 里 **12** 个 key |
| 自动播放策略 | 首次真实点击前 `sound.locked = true`；点击后 **`false`**，`AudioContext.state = "running"` |
| 背景音乐 | `bgm` 存在、`isPlaying = true`、`loop = true`、音量跟随设置 |
| 音效触发 | 用真实点击走一步棋，`sound.play` 收到 `["sfx-pick", "sfx-reveal", "sfx-place", "sfx-reveal", "sfx-place"]`（选子 → 红方翻开落子 → 黑方翻开落子） |
| 按钮点击音 | 新局开局后逐个真实点击 HUD 按钮，`hintButton`/`volumeButton`/`difficultyButton`/`resignButton` **各收到 `sfx-click`** |
| 终局音 | 整局 96 步里共出现 `sfx-capture`、`sfx-place`、`sfx-reveal`、`sfx-check`×9、`sfx-lose` —— 玩家被将死，响的是 `lose` 而不是 `win` |
| 控制台 | 37 条消息，**错误 0**（V11 修掉 favicon 404 之后，首次做到零错误） |
| 音效与画面对齐 | `reveal` 在翻转那一帧、`place` 在棋子落地（扬尘）那一帧、`capture` 在冲击波那一帧 —— 由 `BoardView` 的 cue 回调给出，不是在补间排队时 |

### 4.2 音量对话框

顶栏「音量」按钮 → 模态（真实鼠标点击按钮打开）。控件齐全：`volume`、
`volume.scrim`、`volumeTitle`、`musicVolumeSlider`、`sfxVolumeSlider`、`muteToggle`、`volumeClose`。

| 动作 | 音乐增益 | 持久化的值 |
| ---- | -------- | ---------- |
| 刚打开（默认） | 1.000 | `{"music":1,"sfx":1,"muted":false}` |
| 点轨道 25% 处 | **0.250** | `{"music":0.25,…}` |
| 点「静音」 | **0.000** | `{"music":0.25,…,"muted":true}` |
| 再点一次 | **0.250** | `{"muted":false}` |
| 点「关闭」 | 0.250（继续播放） | 不变 |

滑杆映射（修好下面的 V8 之后，逐个位置点轨道）：

| 点击轨道位置 | 0% | 25% | 50% | 75% | 100% |
| ------------ | -- | --- | --- | --- | ---- |
| 读到的值 | **0** | **0.25** | **0.5** | **0.75** | **1** |

### 4.3 本轮修掉的缺陷

| # | 现象 | 根因 | 修法 |
| - | ---- | ---- | ---- |
| **V8** | 音量滑杆点**正中间**读出 **0.75**，点左边缘读出 0.20 | **上游 phaser-mvvm 的缺陷**：`Slider#localXOf` 累加所有**祖先**容器的 `x`，却漏掉控件**自己**的 `x`，所以任何不在父容器 x=0 的滑杆整体偏移。用框架自己的公式复算 190px 宽、x=44 的滑杆：点 128 → 0.20、点 222 → 0.75、点 316 → 1.00，与实测**逐位吻合** | 把 `this.x` 计入偏移。因为是 vendor 源码，修复写进 `scripts/vendor-phaser-mvvm.sh` 的**显式补丁步骤**，上游若改动这段脚本会报错而不是悄悄丢掉修复 |
| V9 | 验收脚本在启动瞬间轮询 `state()` 抛 `Cannot read properties of undefined` | 后门在 `create()` 到发牌之间读 `scene.engine`，那个窗口里 `jieqi` 还没建 | `state()` 先做空值守卫，返回一个"启动中"的骨架（`busy: true`），轮询循环可以继续等 |
| V10 | 音效文件名带尾随空格（`capture .mp3`） | 转换脚本的对齐表格把 `name` 字段也补齐了，`${entry%%\|*}` 取出来带空格 | 每个字段 `xargs` 去空白后再用 |
| V11 | 控制台永久有 1 条 404 | 从来没有 favicon | `index.html` 里加一个内联 SVG data-URI 图标（朱砂圆牌 + 棋字），现在是**0 条错误** |

### 4.4 一次假警报（记下来，免得下次又追一遍）

第一轮按钮音效探测里 `hintButton` 与 `volumeButton` 都是**空的**，看着像"某些按钮不出声"。
实际原因是探测脚本自己的状态没摆对：那一局的棋已经下完，`hintButton`/`undoButton` 被
`canAct`/`canUndo` 关掉了（禁用按钮在 phaser-mvvm 里根本不激活，自然没有声音）；
而 `volumeButton` 前面刚点过「新局」，确认框还在淡出，`ModalLayer` 的 `blockPointer` 把这一击
吞掉了。重开一局、每个按钮之间等出退出转场之后，四个按钮**全部**收到 `sfx-click`。

结论：**不是缺陷**，是探测脚本没有先建立前置状态 —— 与 `AGENTS.md` 里那条
"比较计数前先 `refreshInteraction()`"是同一类错误。

## 5. 被吃子托盘改成棋子形态

### 5.1 规则口径的修正

原来实现的是「被吃的暗子**谁都不知道**」。重读 QQ 原文：

> 暗子被吃后，吃子方需要将该暗子**背面朝上放置**，**被吃子的一方**不能翻看。

被禁止翻看的是**被吃的一方**，不是吃子方 —— 吃子方是把子拿在手里翻过来的那个人。所以正确的模型是
**按观察者区分**，而不是「双方都瞎」：

```
pool(观察者, 某方) = 该方 15 个身份
                     − 被走子翻开过的（公开：双方都看着它翻）
                     − 这个观察者靠吃暗子学到的
```

第二项只可能落在**对方**的池子上（你吃不到自己的子），这正是规则描述的那种不对称。

不变式（`test/rules.test.ts` 断言）：对任意观察者，
`|pool(观察者, 某方)| = 该方盘上暗子数 + 该方被「观察者以外的人」吃掉的暗子数`。

### 5.2 三种显示

| 棋子怎么离场 | 托盘显示 |
| ------------ | -------- |
| 明着被吃（双方都看着） | **实心正面** |
| 暗着被吃，**且托盘主人吃的** | **半透明正面** —— 吃子方翻看过，所以给真面目；半透明表示「吃的时候它还是扣着的」 |
| 暗着被吃，**且对方吃的** | **背面朝上** —— 托盘主人是被吃方，规则不许翻看，身份根本不进视图 |

顺带把托盘从**一行文字**（`已吃 炮车马暗×2`）换成了**一排小棋子**：26px 的圆牌，正面牌带大字与
朱砂边，背面牌是紫檀底加云纹，与棋盘上的棋子同一套画风。

### 5.3 读数

三种形态在一次真实对局里都跑出来了（8 步之内）：

```
{ dimmedFace: true, back: true, solidFace: true, errors: [] }
```

`test/tray.test.ts` 5 条把三条分支逐条钉住，其中最后一条是**全盘不变式**：跑完一局后，
对每一个托盘 chip 反查它对应的 `MoveEvent`，断言
`chip.kind === (captured.hidden && 观察者不是吃子方 ? null : captured.kind)` 且
`chip.dimmed === (captured.hidden && 观察者是吃子方)` ——
「不许看的身份绝不出现在视图里」这条缝因此有测试兜着，而不是只靠截图看。

同一个规则还带来一个**不对**称：同一个被吃的暗子，吃子方的托盘显示半透明正面、被吃方的托盘显示背面。
测试里对同一步棋分别用两个观察者取托盘，断言一边 `kind` 有值、另一边为 `null`。

## 6. Android

```
./build-android-release.sh
```

全流程跑通：Vite 构建 → 建 Cordova 工程 → 加 android 平台 → 生成密钥库 →
`cordova build android --release` 签名 → `apksigner verify` → 拷进 `release/`。

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.0.0-release.apk` |
| 大小 | **6.0 MB**（3.0 MB 本体 + 3.0 MB 背景音乐；APK 内 `assets/www/audio/` 下 12 个 mp3 齐全） |
| 签名 | **V2 校验通过**，`CN=JieQi, OU=Games, O=JieQi, L=Guangzhou, ST=Guangdong, C=CN` |
| 证书 SHA-256 | `b0ec2bcd45f35795709a390e248c2931a40304552a654c4b91cb3a89ba1089c9` |
| 密钥 | RSA 2048，有效期 10000 天 |
| 包名 / 版本 | `com.jieqi.game` / 1.0.0（versionCode 1） |
| SDK | min 24 / target 35 / compile 35 |
| 应用名 | **揭棋** |
| 工具链 | JDK 21.0.11（Homebrew）+ Android SDK 35/36 + cordova-android 14.0.1 + Gradle 8.13 + AGP 8.7.3 |

### 6.1 本轮踩到的构建缺陷

| # | 现象 | 根因 | 修法 |
| - | ---- | ---- | ---- |
| V6 | Gradle `mergeReleaseResources` 失败：`Invalid <color> for given resource value`，报错文件却指向 `appcompat-1.7.0/res/values/values.xml:27` | `config.xml` 里写了 `BackgroundColor=0xff1b1210`。cordova-android 14 **原样**把它写进 `res/values/colors.xml`（`<color name="cdv_splashscreen_background">0xff1b1210</color>`），而 AAPT2 不认 Java 风格的 `0x` 字面量 | 改成 Android 自己的 `#ff1b1210`。报错文件指向 appcompat 是误导 —— 真正出错的是合并后的资源表 |
| V7 | APK 5.1 MB，其中 12 MB（压缩后约 2 MB）是 sourcemap | Vite `build.sourcemap: true`，而 Cordova 把 `dist/` 原样复制进 www | 默认关掉，需要时用 `JIEQI_SOURCEMAP=1`。APK 5.1 MB → **3.0 MB** |

### 6.2 未验证

**没有在真机或模拟器上安装试玩过。** 上面这些是构建期与产物级的证据
（签名校验、badging、包内容），不是"在手机上跑起来没问题"的证据。
README §7 也把这一条列在已知边界里。

---

## 7. 开始界面与「定先后」（本轮）

本轮加了三块内容：**开始界面**（开始游戏 / 难度设置 / 音量设置）、**定先后抽子动画**（棋子正反面
决定玩家执红还是执黑）、以及由此带来的**玩家颜色可变化**（此前 `GameScene` 里 `PLAYER` 是常量）。
命令、读数如下。

### 7.1 单测

```
pnpm test
```

```
✓ test/spin.test.ts (10 tests)
✓ test/tray.test.ts (5 tests)
✓ test/rules.test.ts (32 tests)
✓ test/ai.test.ts (9 tests)
Test Files  4 passed (4)      Tests  56 passed (56)
```

`test/spin.test.ts` 钉住的是**动画和判定必须说同一件事**，这是抽子唯一能悄悄坏掉的地方（棋子停在帅面、
程序却发黑方）：

| 判据 | 说明 |
| ---- | ---- |
| `faceAt` 与 `faceScale` | 0 与每个半圈处 `|cos|=1`，每个四分之一圈处被夹到下限 0.07；3000 个采样点里宽度恒在 `[0.07, 1]` —— **棋子永远不会消失** |
| 落定面 = 计划面 | 400 组随机数 × 两种奇偶，全部 `faceAt(plan.radians) === plan.face` |
| 转速不泄漏结果 | 每个可达圈数（6…13）都能通向两个面，两两配对后两个面都出现过 |
| 公平 | 20000 次抽样，红面占比与 0.5 的偏差 < 3%（能抓住奇偶写错一位这类真偏置） |
| 交接不跳速 | 对每个圈数断言 `π(n−1)/glide === 3π/settle`（容差 1e-9）—— 匀速段与减速段在交接处角速度相等 |

### 7.2 开始界面（开发服务器 `:5180`，竖屏 640×960）

用 `__JIEQI__.widgetPoint(name)` 取控件中心，再用**真实 `page.mouse.click`** 点击：

| 动作 | 读数 |
| ---- | ---- |
| 载入 | `screen() === "start"`；具名控件 `menuTitle / emblemSlot / startButton / menuDifficultyButton / menuVolumeButton` |
| 点「难度设置」 | 模态起来：`difficulty / difficulty.scrim / difficultyTitle / difficulty_easy|normal|hard / difficultyClose` |
| 点「困难」 | `difficulty() === "hard"`，`localStorage` = `{"difficulty":"hard"}`；按钮变 primary 并带 ✓ |
| 点「音量设置」 | `volume / volume.scrim / volumeTitle / musicVolumeSlider / sfxVolumeSlider / muteToggle / volumeClose` |
| 真实拖动音乐滑杆到轨道 75% | `localStorage` = `{"music":0.75,"sfx":1,"muted":false}` |
| 点「静音」→ 再点 | `muted:true` → `muted:false` |
| 关闭后 | 菜单按钮文案跟着变：`难度设置 · 困难`（音量入口**不再**带百分比 —— 见 §8.3） |

### 7.3 定先后（同一个 640×960 竖屏，每 120 ms 采样一次）

| 时刻 | `screen` | `shownFace` | `radians` | `settled` |
| ---- | -------- | ----------- | --------- | --------- |
| 0–250 ms | start | – | – | – |
| 375–751 ms | draw | red | 0.000 | false |
| 922 ms | draw | red | 0.834 | false |
| 1045 ms | draw | **black** | 1.702 | false |
| 1168–1289 ms | draw | red | 5.088 → 7.096 | false |
| … 每 200 ms 换一次面 … | | red/black 交替 | | |
| 3035–3164 ms | draw | black | 34.312 → 34.537 | false |
| 3288 ms | draw | black | **34.558 = 11π** | **true** |

- 转动全程 **2.4 s**（871 ms 起转到 3288 ms 停），`radians` 单调增到 **11π** —— **奇数**半圈 ⇒ 停在
  反面 **黑将**，与 `draw().outcome` 一致；
- 落定瞬间的动画读数与抽签结果一致：`shownFace === outcome === "black"`，判定文案
  `黑 将 你执黑方 · 电脑先行`；
- 若为偶数半圈（构建产物那轮）：`radians = 37.699 = 12π`，`outcome = shownFace = "red"`，
  判定 `红 帅 你执红方 · 先行`。

### 7.4 红先黑后（两个方向都跑到了）

| 抽到 | 棋盘读数 | 结论 |
| ---- | -------- | ---- |
| 黑将 | `player="black"`，`ply=1`，`turn="black"`，`history=["暗炮二平六"]` | 电脑**执红开局**，玩家后行 |
| 帅 | `player="red"`，`ply=0`，`turn="red"`，`history=[]` | 玩家先行，电脑**一手未走** |

HUD 跟着颜色走：抽到黑时上栏是 `电脑 · 红方`（头像为朱砂圆牌）、下栏 `你 · 黑方 后行`；抽到红时相反。
两个方向都是**连续抽子抽出来的**（第一次黑、退回菜单再抽得红），不是构造的。

### 7.5 真实指针 + 整局

| 项 | 读数 |
| -- | ---- |
| 点 `point(from)` | `state().selection === "0,0"` |
| 点 `point(to)` | 着法成立：`ply 1 → 3`，`history=["暗兵三进一","暗车一进一","炮三进五"]`（与点击前算出的记谱逐字一致，随后电脑应答） |
| 「提示」按钮 | 真实点击后棋盘高亮建议着法（`selection="4,0"`） |
| 「悔棋」按钮（玩家执黑） | `ply 3 → 1`，`history` 回滚到只有电脑的开局着 —— 玩家执黑时"悔一步"同样是退回到**自己**的回合 |
| 整局（开发服务器，`easy`） | `autoPlay` **41 步**走到 `黑方被将死`，**0 运行时错误** |
| 构建产物（`vite preview` `:4174`，即 APK 里那份） | 菜单 → 难度 → 抽子 → 棋盘 → 真实点一步 → 自对弈 12 步，控制台**错误 0**、`errors()` 为空 |
| 布局 | 640×960 / 420×880 / 390×844：控件**无越界**（`widgets()` 的矩形全部落在画布内） |

### 7.6 音效

```
game.sound.play 被包一层记录
```

15 个音频 key 全部解码：`bgm` + 14 个音效（新增 `sfx-spin` / `sfx-land` / `sfx-omen`，
出自 GameBurp：`SLIDER Swipe Drag Movement Heavy Long Rattle 02`（2.38 s，正好覆盖 2.4 s 的转动）、
`BONG Clunk Hit 02`、`SUCCESS CHIME Mystery Magic Spell Sparkle 04`）。

一次「菜单 → 抽子 → 棋盘」的完整链路，`sound.play` 依次收到：

```
sfx-click, sfx-spin, sfx-land, sfx-omen, sfx-deal, sfx-reveal, sfx-place
```

首次真实点击前 `sound.locked = true`，点击后 `false`；背景音乐 `isPlaying=true, loop=true`，
音量跟随设置（0.75）。

### 7.7 本轮修掉的缺陷

| # | 现象 | 根因 | 修法 |
| - | ---- | ---- | ---- |
| **V12** | 每次打包都打印 `res/values/colors.xml: No such file or directory`、`src: command not found`，且生成的 `cordova/config.xml` 注释里**少词**（"copies this preference straight into , and AAPT2 rejects"） | `cat > config.xml <<XML` 的 heredoc **没加引号**（`$VERSION_NAME` 之类必须展开），于是注释里被反引号包起来的文字被 shell 当成**命令替换**执行了 | 三处反引号转义为 `` \` ``；脚本里加了一段说明，讲清"为什么不能简单地把 heredoc 引起来"。构建日志因此回到干净 |
| **V13** | 从棋盘点「菜单」回到开始界面后，再点「开始游戏」**毫无反应** | Phaser **复用同一个 Scene 实例**，类字段只在构造时初始化一次：第一次离开时置的 `leaving = true` 一直留着，`beginGame()` 直接 return。同类问题还有抽子场景的 `handedOver` / 判定文案 ref，以及棋盘场景的 `busyDepth`（若在动画中途离开，回来时棋盘会**永久锁死**） | 三个场景在 `create()` / `init()` 里显式复位本次访问的状态；这条通过"连抽两次"的用例暴露出来（第一次黑、第二次红） |
| **V15** | harness 在「新局」之后紧接着的一次调用报 `the board is not on screen (screen = "draw")` | 后门的 `screen()` 用 `game.scene.isActive(key)` 推断，而**淡入淡出期间两个场景都是 active**：出场的棋盘还在，进场的抽子已经开始，于是"棋盘还在"的一帧里 harness 以为自己在棋盘上 | 三个场景在 `create()` 第一行 `announceScreen(...)`，后门改读 `src/scenes/screen.ts` 里的登记值。顺带把 `gameScene()` 与 `match()` 拆开："这个界面在不在"和"棋盘建好了没有"从此是两个独立的问题 |
| **V14** | 后门的 `point(square)` 喂给 `page.mouse.click` 点不中棋子 | 它返回的是**设计坐标**（450×900 空间里 `squareToScene()` 的结果），而页面里画布是 `Scale.FIT` 缩放 + 居中过的（640×960 视口下画布是 480×960、x 偏移 120），注释却写着"screen coordinates … feed these to a real mouse click" | `point()` 统一经过 `toPage()`（画布矩形 + 缩放）后再返回；新增 `widgetPoint(name)` 用同一套换算给控件坐标。修正后 `selection` 一次点中 |

一条**设计上**的坑，值得记下来（没有真的踩到，但在写之前就想清楚了）：`scene.sound` 与 `scene.cache`
是**游戏级**的，每个场景各建一个 `AudioDirector` 会让同一首背景音乐叠着播两份。所以
`AudioDirector` 改成模块级单例 `audioDirector(scene)`，场景相关的两件事（排队加载、等首次手势解锁）
改成**接收 scene 参数**，音乐于是能跨 菜单 → 抽子 → 棋盘 一路不断。

### 7.8 Android

```
JIEQI_VERSION_CODE=2 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.1.0-release.apk` |
| 大小 | **6.2 MB**（含 15 个 mp3：背景音乐 2.9 MB + 音效约 0.3 MB） |
| 签名 | **V2 校验通过**，证书 SHA-256 `b0ec2bcd…89c9`（与上一版同一把密钥） |
| 包名 / 版本 | `com.jieqi.game` / 1.1.0（versionCode **2**） |
| SDK | min 24 / target 35 / compile 35 |
| 包内容 | `assets/www/` 下 18 项：`index.html` + 打包后的 js + **15 个音频文件**（`spin.mp3`/`land.mp3`/`omen.mp3` 都在） |

**仍未在真机或模拟器上安装试玩过** —— 与 §6.2 同一条边界，本轮没有变化。

### 7.9 「新局」重新定先后（本轮追加）

「新局」原先的语义是"重新摆子，仍执原方"，现在改成**重新抽子**：它把画面交还给同一个
`DrawScene`（和菜单「开始游戏」走的是同一个场景、同一段动画），抽到哪面就执哪方。

真实点击「新局」→「确定」（确认框标题 `重新定先后`）后连续 5 轮的读数：

| 轮次 | 确认框 | 点确定后 | 抽到 | 半圈数 | 落定后棋盘 |
| ---- | ------ | -------- | ---- | ------ | ---------- |
| 1 | `confirm/confirmCancel/confirmOk` | `draw` | 黑 | 7 | `player=black, ply=1`（AI 执红开局） |
| 2 | 同上 | `draw` | 黑 | 13 | `player=black, ply=1` |
| 3 | 同上 | `draw` | 红 | 10 | `player=red, ply=0, history=[]` |
| 4 | 同上 | `draw` | 黑 | – | `player=black` |
| 5 | 同上 | `draw` | 黑 | – | `player=black` |

每轮都满足 `draw.shownFace === draw.outcome === state().player`，运行时错误 **0**。

### 7.10 执黑时棋盘镜像

`BoardView` 新增 `flipped` 选项：抽到黑将时按 180° 视角画（`显示位置 = squareToLocal(89 - square)`）。
**引擎坐标不动** —— 记谱、AI、棋谱仍说那一套；翻的只是"这个格子画在哪"。

| 判据 | 读数 |
| ---- | ---- |
| 落点 | 执黑：`point("4,0")`（将）y=**610**（画布中线 480 之下）、`point("4,9")`（帅）y=**188**（之上）；执红时相反（188 / 610） |
| 点击往返 | 镜像棋盘上取三个格子（`0,0` / `1,2` / `8,3`）的 `point()` 用真实鼠标点击，`selection` **三次全部命中** |
| 真实走子 | 点 `from` → 点 `to`，`history` 里出现点击前算好的记谱（`暗车一进一`） |
| 悔棋 | 悔后回到 `ply=1, turn=black`（AI 的开局着之后） |
| 自对弈 | 镜像棋盘上再走 8 步，`flipped` 恒为 true，**0 错误** |
| 板面 | 截图核对：所有棋子字正着（没有倒过来的"帅"）、楚河汉界左右对调、被吃子托盘与棋谱正常 |

一条**顺带修掉**的探针缺陷（V15）：`screen()` 原先靠 `scene.isActive()` 推断，而一次淡入淡出期间
**两个场景都是 active 的** —— 点「新局」后的一帧里它仍报 `game`，harness 的下一句就会打到一个正在
退场的棋盘上（实测报 `the board is not on screen (screen = "draw")`）。现在三个场景在 `create()`
的第一行向 `src/scenes/screen.ts` **声明自己**，`screen()` 读的是一份被写下来的事实，而不是推断。

---

## 8. 霞鹜文楷、加载页与终局揭示（本轮）

三件事一起改的：游戏内字体换成霞鹜文楷、主菜单音量入口只留文案、对局结束时暗子全部翻开并压半透明。
前一件带来的连锁反应最大 —— 7.9 MB 的字库必须在**任何 canvas 烘焙之前**就位，于是多了一个加载页。

验证环境：`pnpm build` 产物（即 APK 里那一份）用 `pnpm preview` 起在 `:4174`，Chromium 通过
Playwright 驱动。字体与音乐走的是**真实网络请求**，没有 mock。

### 8.1 字体与加载页

`scripts/build-font.sh` 把 `LXGWWenKai-Regular.ttf`（25 MB）转成
`public/fonts/LXGWWenKai-Regular.woff2`（**7,925,896 字节**）。不做子集：任何新文案都不会掉字形。

用 CDP 把网络限到 **90 KB/s**（模拟慢速冷启动），从 0 秒起每秒采一次加载页读数：

| 秒 | `#boot-note` | 进度条 `style.width` | `aria-valuenow` | `screen()` |
| -- | ------------ | -------------------- | --------------- | ---------- |
| 1 | 正在载入字体 · 1% | 1% | 1 | boot |
| 2 | 正在载入字体 · 7% | 7% | 7 | boot |
| 3 | 正在载入字体 · 13% | 13% | 13 | boot |
| 4 | 正在载入字体 · 19% | 19% | 19 | boot |
| 5 | 正在载入字体 · 25% | 25% | 25 | boot |
| 6 | 正在载入字体 · 31% | 31% | 31 | boot |
| 7 | 正在载入字体 · 37% | 37% | 37 | boot |

进度是**按字节**的（`fetch` 流式读 + `Content-Length`），不是定时器估算。这一段时间里游戏**没有**开始
（`screen()` 恒为 `boot`，`__JIEQI__` 存在但棋盘查询会明确报"不在棋盘上"）。

不限速时同一页走到 `正在载入音乐 · 100%` → `#boot-veil.gone` → `screen() === "start"`，
`document.fonts.check('20px "LXGW WenKai"')` 为真，控制台**错误 0 警告 0**。

截图核对：菜单的「揭 棋」「开始游戏」、棋盘上的棋子与「楚河 / 汉界」、HUD 与棋谱全部是霞鹜文楷
（楷体的笔锋一眼可辨，不是原来的宋体回退）。

### 8.2 单测

```
pnpm test
```

**57 / 57 通过**（新增一条：`turns every face-down chip up once the match is over`）。

### 8.3 主菜单音量入口

| 动作 | 读数 |
| ---- | ---- |
| 菜单按钮文案 | `音量设置` —— **恒为这四个字**，不带音效/音乐百分比 |
| 难度入口 | 仍然带读数（`难度设置 · 简单`）：它是一个**选项值**，不是一个改不动的数 |
| 对话框内 | 两条滑杆的百分比仍在（`60%` / `40%`），值仍然写回 `AudioDirector` 与 `localStorage` |

菜单里的读数去掉了，`openVolumeDialog()` 也就没有了 `onChange` 这个唯一的用途 —— 一并删掉了，
免得留下一个"文档说它存在、其实没人调"的参数。

### 8.4 对局结束揭示暗子

`BoardView.revealHidden()` 在结算横幅落幕后触发：所有仍然 `hidden` 的子依次翻面（45 ms 一个，
最多 720 ms），翻完压到 `REVEALED_ALPHA = 0.6`；`reconcile()` 也认这个状态，否则下一次对账会把它们
按引擎的 `hidden` 又扣回去。

认输一局（引擎 29 个暗子）的读数：

| 判据 | 结束前 | 结束后 |
| ---- | ------ | ------ |
| 引擎里 `hidden` 的格子数 | 29 | 29 |
| 视图里 `alpha = 0.6` 的棋子数 | 0 | **29** |
| 视图里背面朝上的棋子数 | 29 | **0** |
| `board.isOver` | false | true |
| 状态栏 | 走子提示 | `黑方认输 · 所有暗子已翻开` |

截图核对：翻开的子明显比明着走出来的子透（棋盘同一行里两种子并排，可逐格对照）。

同一局里电脑托盘的变化（玩家执黑，被吃的是玩家的子）：

| 时刻 | 电脑托盘 | 玩家托盘 |
| ---- | -------- | -------- |
| 对局中 | `暗 暗 暗 暗 C A` | `E R E C P(淡) H(淡) R(淡)` |
| 对局后 | `H(淡) E(淡) P(淡) R(淡) C A` | 同上（本来就是半透明正面） |

即：R7 挡的是"下棋的时候偷看"，棋下完就没有什么可挡的了 —— 与棋盘上剩下的暗子同一个道理。
纯数据面的规则在 `test/tray.test.ts` 里直接驱动（`revealHidden` 选项），不靠截图。

### 8.5 未验证

- **字体在真机上的冷启动耗时**没有读数：桌面浏览器上 7.9 MB 几乎瞬间到位，低端手机上是几百毫秒
  量级还是秒级，本轮没有设备可测。加载页让这段等待可见，但不改变它有多长。
- APK 体积从 6.5 MB 涨到 14 MB，见 §8.6；同样**没有在真机上装过**（与 §6.2 同一条边界）。

### 8.6 Android

```
JIEQI_VERSION_CODE=3 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.1.0-release.apk` |
| 大小 | **14 MB**（7.6 MB 字体 + 2.9 MB 背景音乐 + 1.6 MB js + 音效） |
| 签名 | **V2 校验通过**，证书 SHA-256 `b0ec2bcd…89c9`（与前两版同一把密钥） |
| 包名 / 版本 | `com.jieqi.game` / 1.1.0（versionCode **3**） |
| SDK | min 24 / target 35 / compile 35 |
| 包内容 | `assets/www/fonts/LXGWWenKai-Regular.woff2`（7,925,896 字节）+ `OFL.txt`，15 个 mp3 齐全 |

> **versionCode 得手工往上加**：上一版发的是 2，脚本默认是 1 —— 直接 `./build-android-release.sh`
> 会打出一个 Android 拒绝安装的降级包（`INSTALL_FAILED_VERSION_DOWNGRADE`）。本轮第一次构建就是这么
> 撞上的（`aapt2 dump badging` 读到 `versionCode='1'`），改成 3 重打。脚本现在在没传
> `JIEQI_VERSION_CODE` 时会把 versionName / versionCode 和这件事一起打出来。

---

## 9. 吃子提示与禁止全局同形（本轮）

本轮三件事：**难度设置里的「吃子提示」复选框**、它开出来的**红/绿光圈**、以及把长将/长捉换成
**禁止全局同形**（任何一方都不得让局面回到本局出现过的样子）。

### 9.1 三条判据的边界（单测）

`test/danger.test.ts`（6 条）逐条钉住"有危险"的定义，重点不在于找到一个白吃的车，而在于**否掉三个
似是而非的局面**：

| 用例 | 判据 | 期望 |
| ---- | ---- | ---- |
| 敌方车照着、无人保护的马 | 条件一二 | `isHanging = true` |
| 同一局面 + 己方车在马后面一格 | 条件二（有保护） | `false` |
| 黑将被自家车挡在 a 线上、红车瞄准该线：黑车吃旁边的红马会**送将** | 条件三 | `false`；**并且**先断言该吃法**在着法表里**（证明 `false` 是条件三给的，不是生成器偷偷漏掉） |
| 红帅被黑车照着且无人保护 | 将/帅不上色 | `isSquareAttacked(黑) = true`（是将军）但 `hangingSquares('red') = []` |
| 黑方**暗子**摆在车的初始格位（真身是兵） | 规则 R4 | 威胁按**格位**算 → 红马危险；把同一枚子翻成明兵 → `false` |
| 双方各有一枚白吃子 | 一次遍历 | `red = [右马]`、`black = [左马]`，互不多算 |

### 9.2 禁止全局同形（单测）

`test/rules.test.ts` 追加 3 条，用一局手工局面走完一个**四步循环**（红车出、黑车出、红车回、黑车回）：

| 读数 | 值 |
| ---- | -- |
| 循环第三步后 `repetitionCount(开局局面)` | 1 |
| 第四步（把开局局面走回来）在 `legalMoves()` 里 | **在** |
| 同上，`wouldRepeat()` / `isSelectable()` | `true` / `false` |
| 同上，`selectableMoves()` | **不含**（即 AI 的根着法表里没有它） |
| 同上，`apply()` | 抛 `禁止全局同形`，`ply` 停在 3 |
| `chooseMove()` 的候选 | 不含该着法，且选出来的一手 `isSelectable` 为真 |
| 悔棋一步后，被退回的局面 | 从记录里去掉 → 那一步又能走（`isSelectable = true`） |

```
pnpm test      # Test Files 5 passed · Tests 69 passed
```

即：规则 35 + AI 9 + 托盘 9 + 定先后 10 + **吃子提示 6** = **69 / 69**，`pnpm typecheck` 干净。

### 9.3 构建产物上的指针验收

服务 = `pnpm build && pnpm preview`（`:4174`，**APK 里就是这份 bundle**），浏览器 640×960，走真实鼠标。

| 动作 | 读数 |
| ---- | ---- |
| 菜单 →「难度设置」 | 模态里多了一行控件：`captureHintToggle`，文案 `☐ 吃子提示` + 说明行；DOM 里是真复选框：`role=checkbox`、`aria-checked=true`、`aria-label=吃子提示` |
| 真实点击复选框 | `captureHint() = true`；`localStorage["jieqi.hints.v1"] = {"captureHint":true}`；同一行的难度 key `{"difficulty":"easy"}` **没被动过**（两把 key 分开写） |
| 刷新页面 | 菜单上 `captureHint()` 仍为 `true`（从存储读回来），进棋盘后棋盘带着提示 |
| 开局 | `danger() = { mine: ["6,3"], theirs: [], marks: 1, on: true }` —— 我方一枚子已被电脑盯着；截图核对：该子底下是**红色**光圈 |
| 自对弈到同时出现两种 | `mine: ["8,3"], theirs: ["6,3"], marks: 2`；截图核对：左边缘黑子**红圈**、中间红相**绿圈**，都在棋子底下 |
| 关闭提示 | `marks = 0`，而 `mine/theirs` 的读数**不变**（关的是显示，不是判据） |
| 逐手一致性 | 自对弈 81 步，每一步都断言 `marks === mine.length + theirs.length`，**0 次不一致** |
| 终局 | `黑方困毙 · 所有暗子已翻开` 之后 `marks = 0`（局面结束了就不再指指点点） |

**禁止全局同形**用真实鼠标走了一整个循环（悔棋回到第 1 手 → 黑走一步无关的着法 → 帅出 → 将出 →
帅回），此时：

| 动作 | 读数 |
| ---- | ---- |
| 点「将」 | 状态栏 `将 · 可走 4 处，其中 1 处禁止全局同形` |
| 点那个会重复的落点 | 横幅 **「禁止全局同形」**（截图）；状态栏 `禁止全局同形：这一步会让局面回到本局已经出现过的样子` |
| `ply` | **5 → 5**（没落子）；`selection` 仍停在「将」上，可以改点别处 |
| `errors()` | `[]` |

> 上述链条在**最终 bundle**（`index-CsapqR_t.js`，多了"900 ms 内不重复弹横幅"这一层）上又跑了一遍：
> 这次玩家执红，循环是 `帅五进一 → 将五进一 → 帅五退一 → 将五退一`，读数完全相同 ——
> 选子是 `帅 · 可走 4 处，其中 1 处禁止全局同形`，点下去 `ply` 停在 4、横幅照旧，900 ms 内再点一次
> 不会叠出第二个横幅。

整局自对弈（`aiPly`，`normal`/`easy` 交替）**81 步**：逐手记录 `回合 + 可见棋盘` 作为局面签名，
**42 个签名互不相同**（即这局从未回到过任何一个出现过的局面 —— 可见棋盘不重复 ⇒ 完整局面必不重复），
`errors()` 为空、控制台错误 0。

> 三张截图（复选框关/开、棋盘上的红圈与绿圈、禁止横幅）逐张看过：复选框是方框 + `☑/☐`，
> 光圈在棋子底下且两种颜色分得清，横幅红字落在棋盘上方。与仓库惯例一致，截图不入库。

### 9.4 Android

```
JIEQI_VERSION_CODE=5 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.2.0-release.apk` |
| 大小 | **14 MB**（14,450,415 字节） |
| 签名 | **V2 校验通过**，证书 SHA-256 `b0ec2bcd…89c9`（与前四版同一把密钥） |
| 包名 / 版本 | `com.jieqi.game` / 1.2.0（versionCode **5**） |
| SDK | min 24 / target 35 / compile 35 |
| 包内 | `assets/www/assets/index-C3U8nWc2.js`（1.6 MB）+ 15 个 mp3 + `fonts/LXGWWenKai-Regular.woff2` |
| 新功能确实在包里 | `unzip -p` 后在 bundle 里搜到 `禁止全局同形` 与 `吃子提示` |

### 9.5 未验证

- 光圈在**真机小屏**上的可读性（红圈压在朱砂色的红子上、绿圈压在墨色的黑子上）没有实机读数，
  桌面 640×960 上两种圈与棋子都分得清。
- `禁止全局同形` 与**揭棋平台的具体判罚**（有的平台把被迫重复判负而不是判和）没有逐条对齐：
  本作曾按 `循环重复，判和` 收场（保守侧）；**2026-09-14 用户拍板改为困毙判负**（轮到的一方无允许着法即输，
  与 R10 困毙同一种收场），见 §10 1.3.2。

---

## 10. 连续发布与渲染观感还原（2026-09-14）

今日三连发（产物都在 `release/`），签名全部同一把密钥：V2 校验通过，证书 SHA-256 `b0ec2bcd…89c9`，
包名 `com.jieqi.game`、应用名 揭棋、SDK min 24 / target 35 / compile 35。

| 版本 | versionCode | 产物 | 大小 | 内容 |
| ---- | ---- | ---- | ---- | ---- |
| 1.2.1 | 6 | `jieqi-1.2.1-release.apk` | 14,450,451 B | 设计分辨率渲染基线 |
| 1.2.2 | 7 | `jieqi-1.2.2-release.apk` | 14,451,023 B | 08:51–08:56 改动 UI/场景渲染 + main.ts，引入设备分辨率 pass（缓冲=设计×dpr、相机缩放） |
| 1.2.3 | 8 | `jieqi-1.2.3-release.apk` | 14,450,927 B | **还原 1.2.2 的设备分辨率 pass**（用户反馈锐利刺眼），回到设计分辨率渲染（`RENDER_SCALE=1` / `BAKE_SCALE=2`，浏览器放大 → 略糊） |
| 1.2.4 | 9 | `jieqi-1.2.4-release.apk` | 14,451,027 B | **恢复锐利渲染 + 柔和翻面揭示光**：还原设备分辨率 pass（回到 1.2.2 观感）；刺眼的元凶是落子翻面的揭示闪光（`PieceView.sweep`，`TEX.glow`），已调柔和——尺寸 `PIECE_RADIUS×2.8→2.0`、初始 alpha `0.9→0.5`、最大膨胀 `1.6→1.3` |
| 1.3.0 | 10 | `jieqi-1.3.0-release.apk` | 17,873,695 B | **BGM 状态管理器 + 吃子提示红绿分级 + 送将提示**：`AudioDirector.setBgm` 按状态切歌（menu/game/win/lose，新三曲各 ~1MB 入库，包内 `bgm-menu/win/lose.mp3` 确认存在）；选中棋子后落子会被白吃的目标格改画红圈（复用 `isHanging`），安全格保持绿圈；移动会暴露己方将帅的格画红叉（与吃子提示开关无关），点击弹「移动会送将」警告 |
| 1.3.1 | 11 | `jieqi-1.3.1-release.apk` | 17,873,687 B | **定先后界面切对局 BGM**：DrawScene 从 menu 曲改 game 曲（定先后即视为对局开始；GameScene 同状态 no-op 无缝延续） |
| 1.3.2 | 12 | `jieqi-1.3.2-release.apk` | 17,873,663 B | **全部合法着法都重复时按困毙判负**（用户 2026-09-14 拍板）：`computeResult` 的 `selectableMoves` 空分支由 `循环重复，判和`（winner=null）改为 `stalemate` 困毙判负（winner=对方）。旧串已从包内消失（grep `循环重复`=0） |

已上传坚果云 `揭棋/`：`_v1`(1.2.1) `_v2`(1.2.2) `_v3`(1.2.3) `_v4`(1.2.4) `_v5`(1.3.0) `_v6`(1.3.2)。

---

## 11. 混斗玩法（2026-09-14，1.4.0）

### 11.0 签名 release 包

```
JIEQI_VERSION_CODE=13 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.4.0-release.apk`，**17,875,355 B** |
| badging | `com.jieqi.game`、versionName **1.4.0**、versionCode **13**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.2.1–1.3.2 同一把密钥） |
| 包内核对 | `assets/www/assets/index-dxRbx89F.js`（与 `pnpm build` 产物同名），串 `混斗玩法` / `翻出敌方` / `反 将` / `吃子 ` / `jieqi.mode.v1` 均在其中 |

下一版 versionCode 基线：**13**。

### 11.1 单测

```
pnpm test      # 6 个文件、95 条，全绿
pnpm run typecheck
pnpm run build
```

新增 `test/mixed.test.ts` **26 条**，覆盖：发子（32 子/30 暗/两军身份多重集守恒/暗子 `homeKind` 仍等于格位）、
半场归属（己方半场的暗子归自己、翻面后归真身）、**合法着法与暗子真身无关**（同一局面交换两枚暗子的真身，
着法表逐条相同）、翻开易主（落点、事件 `revealedColor`、双方信息池同步缩水、记谱按走子方读）、
**反将自身**（该步仍在 `legalMoves` 内、`selfCheck=true`、对方吃将后判将死、无将即被攻击）、
信息池守恒（`|池| = 盘上暗子 + 被他人吃掉的暗子`）、混斗托盘（按吃子方归档、只给吃子方看暗子的脸）、
落点危险提示按**走子方**读（`landsHangingAs`，不看翻开后的归属），以及混斗下的 AI 自对弈不产生非法着法。

### 11.2 自对弈压力跑（Node，临时脚本，已删除）

12 局（6 局混斗 + 6 局标准，easy/normal 混合）共 **915 步**：

| 读数 | 值 |
| ---- | -- |
| 翻开易主（`revealedColor !== color`） | **45** 次 |
| 反将自身（`selfCheck`） | **2** 次 |
| 将帅真的被吃（`kingSq < 0`）的局 | **2** 局 |
| 非法着法 / 不变式失败 | **0** |
| 结局 | 11 局将死或困毙结束，1 局标准玩法触到 300 步上限未终局 |

### 11.3 浏览器实跑（Playwright，dev server `127.0.0.1:5180`）

真鼠标点击走完整条链路，全部读 `window.__JIEQI__`：

1. 菜单 →「开始游戏」弹出**玩法弹窗**（`mode_standard` / `mode_mixed` / `modeCancel` 三个真实按钮）；
2. 点「混斗玩法」→ 定先后 → 棋盘：`state().mode === 'mixed'`、`pool = {red:15, black:15}`、
   `errors: []`；顶栏标题旁出现徽标「混斗玩法」；
3. `truth` 视图确认两军确实混在一起（例：黑方底线 9 格里 7 枚是红子），`view` 视图里除了将帅全是背面；
4. **真点击**选子与落子：选中己方半场暗子后状态栏 `暗车 · 可走 2 处`；落子后
   `黑 暗车一进一 · 翻出敌方兵 · 易主`，同时弹出横幅「易 主 / 兵已归红方」，落点上出现一枚红兵；
5. 一路 `autoPlay` 到终局：`红方被将死`，终局揭示把所有暗子翻开（红黑混杂）、托盘显示
   `吃子 4 枚` / `吃子 1 枚`（含被吃的红帅）；全程 `errors: []`、控制台 0 错误 0 警告；
6. 这局里真实出现过 M5 设计的那条路：红 `暗相七进五` 翻开是**黑车**（`revealedColor: black`、
   `selfCheck: true`），下一手黑 `车五进二` 直接吃掉红帅判将死 —— 与 §11.1 里手工构造的用例一致；
7. 刷新页面后菜单仍记得混斗（`localStorage` 的 `jieqi.mode.v1`）；改点「标准玩法」则照常按标准发子
   （20 步 `autoPlay`、池按红黑两侧计、0 错误），标准玩法没有回归。

**实跑抓出的一个真 bug**：`GameScene.onSquare` 用 `piece.color === player` 判断"这枚子能不能点"，
而混斗里暗子的 `piece.color` 是**真身**，于是整块己方暗子点不动（浏览器一跑就暴露，单测看不见）。
改为 `board.ownerAt(square) === player` 后正常。

> 渲染观感定论（2026-09-14）：**锐利渲染是对的**（1.2.4 恢复），当初"刺眼"是翻面揭示光过亮，不是清晰度。
> 项目自本轮起纳入 git 管理（2026-09-14 初始化，main 分支，暂无远程）。提交：`0106152`（1.2.2 基线）、
> `0e65c46`（1.2.3 还原）、`e950d46`（1.2.4 恢复锐利+柔和翻面光）、`61ec2d6`（1.3.0 BGM+提示增强）、
> `638f159`（1.3.1 定先后切对局曲）、`8e7bb3c`（1.3.2 重复困毙判负）。下一版 versionCode 基线从这里读：**12**。

---

## 12. 禁止循环追棋 + 混斗禁止立即吃将（2026-09-14，1.4.1）

### 12.0 签名 release 包

```
JIEQI_VERSION_CODE=14 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.4.1-release.apk`，**17,875,627 B** |
| badging | `com.jieqi.game`、versionName **1.4.1**、versionCode **14**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.2.1–1.4.0 同一把密钥） |
| 包内核对 | 串 `禁止循环追棋` / `禁止立即吃将` / `翻出敌方` 均在 bundle 中，旧串 `禁止全局同形` 已清除 |
| 坚果云 | `揭棋/揭棋_20260914_v7.apk`，PROPFIND 远端 `getcontentlength` 17875627 == 本地字节数（HTTP 201） |

下一版 versionCode 基线：**14**。

### 12.1 规则改动（用户拍板）

1. **禁止循环追棋**（取代禁止全局同形）：同一局面**最多出现两次**，第三次重现的着法才禁止
   （`wouldRepeat` 判 `repetitionCount(key) >= 2`）；**走子方正被将军时完全豁免**
   （`wouldRepeat` 对 `inCheck()` 直接放行）。全部提示文案改为「禁止循环追棋」。
2. **混斗禁止立即吃将**：新增 `wouldEatGeneral()` —— 上一手是 `selfCheck`（翻出的敌方子照着自己将帅）时，
   对方**下一手不能用这枚翻出的子直接吃将**；被将军一方得一回合解将，走完那一手规则即失效。
   AI 根着法表（`selectableMoves`）过滤、`apply()` 兜底抛错、UI 横幅「禁止立即吃将」+ 状态栏
   `N 处禁止立即吃将` 计数。

### 12.2 单测（97/97 全绿）

```
pnpm test          # 6 个文件、97 条，全绿
pnpm run typecheck
```

- `test/rules.test.ts` 重构为**第三次重现判禁**（两圈循环局，`ply=7` 时 `wouldRepeat(收尾)=true`、
  `isSelectable=false`、`apply` 抛 `禁止循环追棋`）；**被将军豁免**用例（同一局面，`inCheck` 时放行 /
  不将军时禁）；悔棋重开；AI 不选禁着。
- `test/mixed.test.ts`：M5 用例改为**禁吃将**（`wouldEatGeneral(吃将)=true`、`isSelectable=false`、
  `apply` 抛 `禁止立即吃将`、黑方仍有其他着法）+ 新增"规则在一手后失效"用例（黑走一步将位移后
  `wouldEatGeneral` 恒 false）。

### 12.3 未重跑项（如实说明）

- §9 的 Playwright 实跑记录里出现过的旧文案（`禁止全局同形`、`其中 1 处禁止循环追棋` 的旧版本、
  M5 直接吃将判将死那条路）随规则改动已失效；本轮**未**跑浏览器端接受测试，新横幅/状态栏文案
  只经单测与包内串核对验证。上一版基线：`1fd2e03`（1.4.1 规则改动提交）。

---

## 13. 框架基线更新：焦点可见性（2026-09-14）

### 13.0 这次同步了什么

`pnpm vendor:mvvm` 从框架 checkout 重新同步 `vendor/phaser-mvvm/`，上游基线
**`02c24d4`**（`fix(phaser): separate focus visibility from focus (CSS :focus-visible)`，
决策见上游 `docs/adr/0012-focus-visible-ring.md`）。

对玩家可见的变化只有一处，而且正是这个项目以前一直没注意到的：**鼠标点过的控件不再留一个焦点框**。
框架原来用**同一个** `focused` 同时决定「谁持有焦点」与「要不要画焦点环」，所以点一下 HUD 按钮，
那一圈框会一直留着，直到焦点被别的东西拿走。现在采用 CSS `:focus-visible` 的规则：

| 来源 | 焦点是否移动 | 是否画环 |
| ---- | ------------ | -------- |
| 指针按下（鼠标 / 触摸） | 移动（`Tab` 从点过的地方继续） | **不画** |
| 键盘 `Tab` / 方向键 / 手柄 | 移动 | 画 |
| 文本域 | 移动 | 画（浏览器的例外，本项目没有文本域） |

同步的可核对的细节：

- `pnpm vendor:mvvm` 的**本地补丁步骤仍然生效**——Slider `localXOf` 的 `this.x` 修复（§4.3 的 V8）
  重放锚点 `let offset = 0;` 仍在上游源码里，脚本没有报错，`grep -n "let offset = this.x;"`
  在 vendored 文件里仍在（第 315 行）。
- vendored `src/` 与上游 `src/` 的差异**只有那一个文件的一处**（`Slider.ts` 的补丁）；本次更新的
  7 个文件（`Widget`/`focus`/`plugin`/`Button`/`Panel`/`Slider`/`TextInputBase`）其余部分与上游逐字节相同。
- 本次更新**没有**新增或改名任何框架导出名，`pnpm-lock.yaml` 未变（vendored 包的 `package.json`
  由脚本重写成同一形状）。

### 13.1 游戏内实测（Playwright，开发服务器 `:5180`，竖屏 640×960）

真实鼠标（CDP 点击）+ 真实键盘（CDP `Tab`），逐条读数：

| 步骤 | 真实输入 | 读数 | 是否画环 |
| ---- | -------- | ---- | -------- |
| 打开开始界面 | — | 镜像节点 3 个：`开始游戏` / `难度设置 · 困难` / `音量设置` | 无（基线） |
| 点「难度设置」 | 鼠标 (358, 654) | 难度对话框打开，镜像多出 `难度 简单/普通/困难`、`吃子提示`、`关闭` | 无 |
| 点「普通」 | 鼠标 (358, 436) | 选中标记 `✓` 从「困难」移到「普通」——点击确实落上了 | **无**（这是本次更新的重点） |
| 按 `Tab` | 键盘 Tab | `document.activeElement` = 镜像节点 **「难度 困难」** | **有**（主题金色环） |
| 点「简单」 | 鼠标 (358, 397) | 开始界面文案变为 `难度设置 · 简单`，`activeElement` = 「难度 简单」 | **无** |

第 3、5 行与第 4 行合起来就是这条规则的判据：**同一排同样三个按钮，鼠标点过的不带框、键盘走到的带框**。
点击是否真的到达控件由「选中标记 + 开始界面文案跟着变」证明（否则「没有环」也可能只是没点中）。

### 13.2 门禁

```
pnpm typecheck   # exit 0
pnpm test        # 6 个文件、97 条，全绿（17.97 s）
pnpm build       # vite build ✓ 142 modules；dist/assets/index-B2s3zFxq.js 1,651.29 kB（gzip 444.54 kB）
```

四轮重跑（第一次同步、V82 修复后、V83 修复后、关掉焦点环后）都是同一读数：typecheck 0 错、97/97、构建通过——框架侧的三次改动与这一行开关，一条都没碰到规则引擎与 AI。

97/97 与上一版逐条相同（这次同步的是框架源码，规则引擎与 AI 一条都没动）。

### 13.3 集成时抓到的两条框架缺陷（V82 / V83），以及它们修好之后的样子

这一节是这次集成最大的收获：**新版本在框架自己的门禁下是全绿的，但一放进这个游戏，用户看着屏幕就说出了两句话**。两条都记在框架仓库的 [`DEFECT-BACKLOG.md`](https://github.com/universe-st/phaser-mvvm/blob/main/docs/DEFECT-BACKLOG.md)（V82 / V83），修法在框架侧，这里不改任何游戏代码。

**第一条（V82）**：「我看这个滑杆还是带框啊」。查下来是两条独立的路，都藏在"早退"里：

| # | 现象 | 根因 |
| - | ---- | ---- |
| ① | 音量对话框打开时 `focusFirst` 已经把焦点给了音乐滑杆，**用户再点这个滑杆，框不消失** | `FocusManager#applyFocus` 在"焦点已经在这个控件上"时**直接早退**，指针按下连控件都没通知到——于是"可见性"从来没被降下来过 |
| ② | 键盘聚焦的滑杆上把 `focus: { ring: false }` 打开，**框还在屏幕上** | `Slider` 的重绘缓存键（`styleKey`）里有 `visualState` 却没有 `focusVisible`：这条路只改可见性、不改状态 → 键不变 → 不重画（切一次主题它自己就好了，这就是"陈旧画笔"的签名） |

判别手法值得记一笔：**只把指针移开**（焦点不变、只触发一次无关重画）框照样在 → 说明控件自己就认为"焦点可见"，不是陈旧画笔；**切一次主题**框就没了 → 那才是陈旧画笔。

**第二条（V83）**：「还是有框，我希望它没框」。这一次是**没有来源的焦点变化**：`Tab` 与指针按下都有显式来源，但**对话框 `focusFirst`、页面栈 `pop` 还原、`widget.focus()` 都没有**，而它们一律按"可见"处理。于是**触摸玩家点开音量对话框，第一个滑杆被自动聚焦并戴上一个框**——那一下框是**上一次点击的后果**，而点击已经说明发生了什么。修法是 `:focus-visible` 剩下的一半：没有来源时**跟随最后一次输入的模态**（触摸/鼠标 → 不画环；键盘/手柄 → 画环）。

修好之后在本游戏里实测（同一个 640×960 竖屏，开发服务器 `:5180`，真鼠标 + 真键盘）：

| 步骤 | 真实输入 | 焦点（镜像节点的 `activeElement`） | 画面 |
| ---- | -------- | ---------------------------------- | ---- |
| 打开音量对话框 | **真鼠标点「音量设置」** | `音乐音量` | **两个滑杆都没有框** ✅ |
| 再按一次 `Tab` | 真键盘 `Tab` | `音效音量` | 音效滑杆出现金色焦点环 ✅（键盘/手柄玩家照旧看得见） |
| 真鼠标点音乐滑杆 | 真鼠标（点它中点 → 值变 50%） | `音乐音量` | 点击后**框立即消失**，值照常生效 ✅ |

最后一行同时验证了①：**同一个滑杆**，先由对话框聚焦（无框）、再由键盘聚焦（有框）、再由鼠标点（框消失）——三次都是同一行像素，颜色却按输入来源变。

这三条状态在框架仓库里是**常驻像素门禁**（`visual-check` 的 `states.pointer` / `states.tab` / `states.pressFocused` / `states.ringGate` 四条臂，116 个像素检查 + 4 条输入断言），本仓库没有这样的门禁，所以**每次更新框架基线都要把上表重跑一遍**。

### 13.4 最终决定：这个游戏**不要任何焦点框**（`focus: { ring: false }`）

修好 V82/V83 之后剩下的最后一圈框，是**键盘焦点**的环：用户截图给出的那一张里，「音效」滑杆带着环——那是验证时按了一次 `Tab` 的结果，属于框架设计中的"键盘在这儿"提示。用户的原话是「我希望它没框」，而揭棋是**手指玩的游戏**（HUD 是唯一的 mvvm 界面），所以这个提示在本作里没有受众。

因此 `src/main.ts` 的插件配置里加了一行全局开关（框架侧早就提供了它，第 113 轮之前它是个只写不读的死选项 V79，由 V82 修好并配上 `states.ringGate` 门禁）：

```ts
MVVMPlugin.configure({
  designResolution: { width: DESIGN_WIDTH, height: DESIGN_HEIGHT },
  focus: { ring: false },   // 全游戏不画焦点环
});
```

**关掉的只是"画不画"，不是"焦点"**：`Tab`/方向键照旧移动焦点，`Enter` 照旧激活，无障碍镜像照旧报告当前聚焦的控件（读屏用户不受影响）；以后若要做键盘/手柄版本，删掉这一行就恢复。

实测（同一竖屏 640×960，真鼠标 + 真键盘）：

| 步骤 | 真实输入 | 焦点（`activeElement`） | 画面 |
| ---- | -------- | ----------------------- | ---- |
| 真鼠标点「音量设置」 | 真鼠标 | `音乐音量`（对话框 `focusFirst` 给的） | **没有框** ✅ |
| 再按一次 `Tab` | 真键盘 | `音效音量` | **仍然没有框** ✅（全局开关生效，且滑杆真的重画了——这正是 V82② 修的缓存键） |
| 真鼠标点音乐滑杆 | 真鼠标 | `音乐音量` | 没有框，值照常改变 ✅ |

### 13.5 签名 release 包（1.4.2）

```
JIEQI_VERSION_CODE=15 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.4.2-release.apk`，**17,875,959 B** |
| badging | `com.jieqi.game`、versionName **1.4.2**、versionCode **15**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.2.1–1.4.1 同一把密钥） |
| 包内核对 | `assets/www/assets/index-B2s3zFxq.js`（1,651,296 B）——与本次 `vite build` 的产物**同名**；该 bundle 已用 `pnpm preview`（`:4174`）在浏览器里逐条验过：真鼠标点「音量设置」打开对话框**没有框**，随后按 `Tab`（焦点到「音效」）**仍然没有框**。所以"不画焦点环"这条读数适用于上架的包本身，而不只是开发服务器 |
| 坚果云 | **未上传**（本仓库没有上传脚本，历史版本是手工传的）；按序号下一个文件名应为 `揭棋_20260915_v8.apk` |

下一版 versionCode 从 **16** 起（本次用了 15；上一节写的"基线 14"是笔误——基线应当是"已用过的最大值 + 1"）。

### 13.6 签名 release 包（1.4.3）— 棋子繁体化

```
JIEQI_VERSION_CODE=16 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.4.3-release.apk`，**17,875,959 B** |
| badging | `com.jieqi.game`、versionName **1.4.3**、versionCode **16**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.2.1–1.4.2 同一把密钥） |
| 改动 | `KIND_NAME` 棋子字 帅/将/马/车 → 帥/將/馬/車（炮兵卒仕士相象繁简同形不变）；抽子判词 红 帥 / 黑 將（`spin.ts` 硬编码处）；notation 进→進、后→後，棋谱全繁体（車九進五 / 暗兵五進一）；`backdoor.ts` 后门版本号 1.4.1→1.4.3（上两版漏改，已修正） |
| 字体 | 霞鹜文楷 WOFF2 cmap 已核：帥將馬車全在，无缺字 |
| 门禁 | typecheck 0 错；`pnpm test` 97/97（5 处繁体断言更新：车九进五/马八进七/吃马/暗兵五进一×2） |
| 包内核对 | `assets/www/assets/index-BgHkWSTE.js`：帥×2、將×2、馬×1、車×1；仅剩 2 处简体为界面文案（送将提示、抽子说明），非棋子字 |
| 坚果云 | 已上传 `揭棋_20260915_v2.apk`（同日 v1 为 1.4.2） |

下一版 versionCode 从 **17** 起。

### 13.7 未验证 / 边界

- **焦点环的像素没有本仓库的门禁**：本项目的验收是"人看截图 + 读数"，像素级 A/B（真鼠标点击后
  按钮顶边必须与没被碰过的邻居同色、真 `Tab` 后必须读到环色）在**框架仓库**里常驻
  （上游 `scripts/visual-check.mjs` 的四条臂 `states.pointer`/`states.tab`/`states.pressFocused`/`states.ringGate`，116 个像素检查）。
  本仓库没有 `visual-check` 那样的像素门禁，所以框架再更新时要重跑一遍本节 13.1 与 13.3 的表。
- **触摸路径未在本仓库实测**：桌面 Chrome 上触摸同样走 `onPointerFocus`，行为应与鼠标一致，
  但没有在 Android 模拟器/真机上复跑 `android:release` 之外的输入验收。
- **本次同步未出 APK**：没有版本号变更、`release/` 未动；下一版打包时会带上这一变化
  （观感变化：全游戏不再有焦点框——见 §13.4）。
- **§13.3 的三条读数只在本机 Chrome（桌面窗口 640×960）上取过**：Android WebView 里的触摸路径没有复跑
  （框架侧的触摸与鼠标走同一个 `onPointerFocus`，但那是推断，不是实测）。

### 14.0 签名 release 包（1.5.0）— 迷雾玩法

```
JIEQI_VERSION_CODE=17 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.5.0-release.apk`，**17,878,599 B** |
| badging | `com.jieqi.game`、versionName **1.5.0**、versionCode **17**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.2.1–1.4.3 同一把密钥） |
| 改动 | 新增第三种玩法「迷雾玩法」（用户拍板）：视野 = 自身格 + 周围八格 + 一步可达格（V1–V2，炮能看到隔山打的目标但看不到炮架）；暗子按格位算视野、翻开按真身（V3）；将帅碰头需连线全在受检方视野内（F1），迷雾驱散导致照面可直接飞将吃将获胜（F2）；吃子提示/送将/落点危险/将军提示全部按玩家视野门控，不提示看不到的信息；迷雾中的电脑行棋不进棋谱、状态只报「电脑在迷雾中行棋…」；AI 同样受视野限制——候选着法在 AI 视野棋盘生成、被真盘拒绝就顺延次优步、采样世界把看不见的敌子重摆到采样迷雾格（唯一例外：敌方将帅位置恒已知）。实现：`src/core/vision.ts`（视野 + Zobrist-key 全局缓存 + `foggedBoardFor`）、`moves.ts` `kingsFaceEachOtherFog` + 飞将吃将、`ai/engine.ts` `fogCandidates`/`sampleFogWorld`、`BoardView` 迷雾层（90 格瓦片 + 飘动雾团）、`GameScene` 可见性门控；`backdoor.ts` 版本同步 1.5.0 并新增 `fog()`/`log()` 探针 |
| 门禁 | typecheck 0 错；`pnpm test` **114/114**（新增 `test/vision.test.ts` 17 例：视野规则、迷雾照面、飞将吃将、迷雾 AI 候选与 3 局无卡死自对弈） |
| 浏览器实测 | `pnpm dev` 真机驱动：迷雾局开局即 37–49 格迷雾、截图确认灰蓝迷雾覆盖黑方半场；迷雾中电脑首步状态=「电脑在迷雾中行棋…」且棋谱只显示玩家可见的着法（ply 2 → 1 行）；吃子提示的标记全部落在玩家可见格（0 泄漏）；悔棋回退到 ply 0 且迷雾同步；认输后迷雾全消（tiles 0）；标准玩法 0 迷雾格；玩法对话框含 `mode_fog` 且真鼠标点击后按迷雾模式开局；全程 `errors()` 为 0 |
| 包内核对 | `assets/www/assets/index-Nm6rdqsu.js`：迷雾玩法×1、标准玩法 + 视野×1、电脑在迷雾中行棋×1、被迷雾覆盖×1、迷雾挡住将帅碰头×1、1.5.0×1 |
| 坚果云 | 已上传 `揭棋_20260915_v3.apk`（17,878,599 B，PROPFIND `getcontentlength` 与本地字节数一致；同日 v1=1.4.2、v2=1.4.3） |

下一版 versionCode 从 **18** 起。

### 14.1 签名 release 包（1.5.1）— 迷雾三修正

```
JIEQI_VERSION_CODE=18 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.5.1-release.apk`，**17,878,839 B** |
| badging | `com.jieqi.game`、versionName **1.5.1**、versionCode **18**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.5.0 同一把密钥） |
| 改动 | ① **F3 敌王按最后一次看见追踪**（用户拍板）：`JieqiGame.kingSeen` 记录各观察者上次见到敌方将帅的格子（默认敌王原位），每手按视野刷新、悔棋恢复；AI 的迷雾棋盘把敌王摆在 `kingSeen` 而非真位置 —— 取代 1.5.0 的「恒已知」例外，王真能藏进迷雾了（AI 会对着幻影王走棋，被真盘拒绝就顺延）。② **迷雾变实墙**：`TEX.fog` 瓦片内部全不透明（实体到半格 86% > 棋子半径 19），`BoardView.reconcile` 直接 `setVisible(false)` 雾格上的棋子视图（不是盖住、是不画），双重保险；`setFog(null)` 终局恢复显示全部。③ **「对方已落子」提示**：迷雾中电脑落子状态栏必报「对方已落子（迷雾中，看不清具体走法）」——视野信息完全没变时这是玩家知道对手走了一手的唯一信号 |
| 门禁 | typecheck 0 错；`pnpm test` **117/117**（新增 kingSeen 追踪不变量、敌王接管位置、占位不覆盖 3 例） |
| 浏览器实测 | **未完成**：本轮 headless 浏览器环境持续退化（vite + 全新浏览器也卡在 boot 场景、CDP daemon 反复断连），无法复跑迷雾局截图；引擎侧由 117 例单测覆盖（含迷雾 3 局无卡死自对弈），UI 三处改动为代码审阅 + `vite build` 编译通过。真机/桌面浏览器复核待用户确认 |
| 包内核对 | `assets/www/assets/index-vCZgLt7Z.js`：对方已落子（迷雾中，看不清具体走法）×1、kingSeen×16、迷雾玩法×1、1.5.1×1 |
| 坚果云 | 已上传 `揭棋_20260915_v4.apk`（17,878,839 B，PROPFIND `getcontentlength` 与本地字节数一致） |

下一版 versionCode 从 **19** 起。

### 14.2 签名 release 包（1.5.2）— 迷雾吃王棋 + 柔雾回退

```
JIEQI_VERSION_CODE=19 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.5.2-release.apk`，**17,878,971 B** |
| badging | `com.jieqi.game`、versionName **1.5.2**、versionCode **19**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（与 1.5.0 同一把密钥） |
| 改动 | ① **F4 迷雾=吃王棋**（用户拍板「取消送将限制」）：`legalMoves` 在 fog 下返回伪合法着法（不做王安全过滤）；`computeResult` 在 fog 下只判「将帅被吃」（对方胜，文案含「被吃」）与「久无吃子判和」，将死/困毙不判负；搜索 `generateLegal`/`quiesce` 同跳过王过滤，`searchRoot`/`negamax` 吃将分支返回 `MATE`（第一次吃将即终局，不搜反吃）；场景 `sendsCheck` 迷雾下为空（红 X 与拦截消失）。② **F5 将军提示以「将军的棋」为门**（用户拍板）：`isCheckVisible` 扫敌方着法，凡终点=己方将帅格且起点在玩家视野内 → 看得见的将军才提示（高亮/状态栏/横幅）；`announceCheck`/`clearSelection`/`undo` 三处统一。③ **迷雾回退柔雾**（用户拍板「还是之前的样式就好，棋子隐藏就行」）：`drawFogTile` 回到 30 层 (1-t)²·2.4 渐变、瓦片 alpha 0.8↔0.96 呼吸；「棋子不画」保留（`reconcile` `setVisible(false)`） |
| 门禁 | typecheck 0 错；`pnpm test` **121/121**（新增 F4 一组 4 例：送将合法可落子、吃将即胜含「被吃」文案、将死局面在 fog 不判负、同局面标准模式仍判将死；迷雾 3 局无卡死自对弈仍绿） |
| 浏览器实测 | headless 实机跑通：`startGame('fog')` 后 mode=True、雾格 **39**（玩家黑方，90−51 可见）；截图确认**半透明柔雾**覆盖黑方半场、雾下棋子不显示（唯二可见顶行子为规则上合法的 (1,0)/(7,0) 车）；AI 落子后状态栏=「对方已落子（迷雾中，看不清具体走法）」；连续 5+ 手无卡死；`errors()` 全程 0。CDP daemon 反复崩断（环境问题），对局未跑到终局，吃将终局由单测覆盖 |
| 包内核对 | `assets/www/assets/index-*.js`：对方已落子×1、将帅被吃×1、迷雾×N、1.5.2×1 |
| 坚果云 | 已上传 `揭棋_20260915_v5.apk`（17,878,971 B，PROPFIND `getcontentlength` 与本地字节数一致） |

下一版 versionCode 从 **20** 起。

### 14.3 签名 release 包（1.5.3）—「对方已落子」升级为横幅

```
JIEQI_VERSION_CODE=20 ./build-android-release.sh
```

| 读数 | 值 |
| ---- | -- |
| 产物 | `release/jieqi-1.5.3-release.apk`，**17,879,023 B** |
| badging | `com.jieqi.game`、versionName **1.5.3**、versionCode **20**、minSdk 24 / target 35 / compile 35、应用名 揭棋 |
| 签名 | V2 通过，证书 SHA-256 `b0ec2bcd…89c9`（同一把密钥） |
| 改动 | 迷雾中电脑落子的「对方已落子」从状态栏一行字升级为完整三件套：蓝灰牌匾横幅（`banner`，`C.fog` 0x93a8c2）+ 全屏淡蓝灰蒙层（`screenWash` 0.14）+ `place` 提示音；状态栏文字保留；`afterMove` 不可见分支加 `!jieqi.result` 守卫（终局前不打扰）；调色板新增 `C.fog`。玩家自己可见的着法不受影响（着法终点必在玩家视野内，走不到该分支） |
| 门禁 | typecheck 0 错；`pnpm test` **121/121**（本轮纯 UI） |
| 浏览器实测 | headless 实测：迷雾局 AI（黑）落子后截图确认——居中的蓝灰牌匾「对方已落子 / 迷雾中，看不清具体走法」+ 整屏淡蓝灰蒙层 + 状态栏同步；玩家先行着法无横幅；`errors()` 0 |
| 包内核对 | `assets/www/assets/index-*.js`：对方已落子×1、迷雾中×1、1.5.3×1 |
| 坚果云 | 已上传 `揭棋_20260915_v6.apk`（17,879,023 B，PROPFIND `getcontentlength` 与本地字节数一致） |

下一版 versionCode 从 **21** 起。


