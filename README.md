# 咒法学中文网（hexcasting.cn）

Hex Casting（咒法学）中文资料站前端，基于 [Astro](https://astro.build) 构建的静态站点。

## 开发命令

```bash
pnpm install     # 安装依赖
pnpm dev         # 本地开发（http://localhost:4321）
pnpm build       # 构建到 dist/
pnpm preview     # 预览构建产物
```

## 添加文章

文章放在 `src/content/posts/`，一个 `.md` 文件一篇文章（frontmatter 字段见下）：

```markdown
---
title: "文章标题"
date: 2026-08-10
author: "作者名"
description: "（可选）文章简介，显示在列表页"
---

# 正文从这里开始

这是正文……
```

- 文件名即文章路径（`src/content/posts/my-note.md` → `/posts/my-note/`）
- 按 `date` 降序排列（首页展示最近 4 篇）
- 字段校验见 `src/content.config.ts`（`title`/`date`/`author` 必填，`description` 可选）
- 支持 Markdown（标题、列表、代码块、链接等）

## 在文章里显示 Iota

正文中直接书写 `iota:...`，页面加载后会自动渲染为 Iota 图形/文本（无需任何组件或特殊标记）：

```markdown
这个法术使用了 iota:hexguide:get_caster.json 和 iota:[double:1, vec:{2,3,4}, null]
```

### 支持的 iota 写法

| 写法 | 说明 | 示例 |
|---|---|---|
| `iota:<a85>` | Ascii85 压缩的 NBT 二进制（游戏内 copy 法术生成） | `iota:GaqdV3spKl&-]kY…` |
| `iota:<ns>:<name>.json` | 站内资源文件（见下） | `iota:hexguide:get_caster.json` |
| `iota:<name>.json` | 省略命名空间（默认 `hexguide`） | `iota:quine.json` |
| `iota:pattern{<朝向>,<笔顺>}` | 便携图案：朝向 `NORTH_EAST`/`EAST`/…，笔顺字符 `w/e/d/s/a/q` | `iota:pattern{NORTH_EAST,qqaeaae}` |
| `iota:double:<数字>` | 数字 | `iota:double:3.14` |
| `iota:vec:{x,y,z}` | 向量 | `iota:vec:{1,2,3}` |
| `iota:null` | 空值 | `iota:null` |
| `iota:[<元素>,…]` | 列表（元素可递归使用以上任意形式） | `iota:[double:1, vec:{2,3,4}, null]` |

### 资源文件（`iota:<ns>:<name>.json`）

文件放 `public/<ns>/iotas/<name>.json`，两种内容格式均可：

```json
// 纯 JSON（推荐）
{"hexcasting:type":"hexcasting:pattern","hexcasting:data":{"start_dir":1,"angles":[2,1,0,3]}}
```

```json
// {"nbt":"<SNBT>"}（游戏内 OpTextCopy 自动保存的格式，也支持）
{"nbt":"{hexcasting:type:\"hexcasting:pattern\",hexcasting:data:{start_dir:1b,angles:[2B,1B,0B,3B]}}"}
```

### 渲染规则

| Iota 类型 | 显示 |
|---|---|
| 图案 | 六边形网格笔画（SVG，浅蓝，与游戏内 HexMod 渲染一致） |
| 数字 | 绿色黑体数值 |
| 向量 | 红色黑体 `(x, y, z)` |
| Null | 灰色 `Null` |
| 垃圾 | 灰色乱码 |
| 列表 | 暗紫 `[内部元素递归渲染]`，相邻图案之间不加逗号（与 HexMod 一致） |

### 组件方式（可选）

需要固定尺寸时可用 Astro 组件：

```astro
---
import IotaPattern from '../components/IotaPattern.astro';
---
<IotaPattern value="iota:hexguide:get_caster.json" size={14} />
```

（不写组件、直接写 `iota:...` 文本也会自动渲染，组件只是提供显式尺寸控制。）

### 细节

- 代码块（` ``` ` 或 `<code>`）内的 `iota:...` **不会**渲染，保留原文——适合展示语法本身
- 渲染失败（资源 404 / 解析错误）时保留原文文本
- 图案坐标算法逐行对照 HexMod 源码（`HexPattern.positions()` / `coordToPx`），方向与游戏一致

## 目录结构

```
src/
  content.config.ts      # 文章 frontmatter 校验
  content/posts/         # 文章（Markdown）
  components/            # header / footer / IotaPattern
  layouts/baseLayout.astro  # 布局（含 iota 自动渲染全局脚本）
  lib/iotaRender.js      # iota 解析 + 图案渲染核心（Ascii85 / NBT / SNBT / SVG）
  pages/                 # 页面（index / posts / iota-demo）
public/
  hexguide/iotas/        # iota 资源文件（<ns>/iotas/<name>.json）
```

## 测试页

`/iota-demo/`：输入任意 `iota:...` 实时渲染，内置全类型示例（含便携语法与 quine 列表）。
