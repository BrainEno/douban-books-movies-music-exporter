# notion-script

一个用于 **批量导出豆瓣书籍、电影、音乐目录** 的 Userscript。  
脚本会自动翻页、抓取详情页补全信息，并导出为：

- 通用表格 `CSV`
- 可直接导入 `Notion` 的 `CSV`
- `JSON` 备份文件

适合整理个人豆瓣目录、迁移到 Notion、做长期归档和备份。

---

## 功能特性

- 支持导出：
  - 豆瓣书籍
  - 豆瓣电影
  - 豆瓣音乐（专辑）
- 支持导出：
  - 已标记（读过 / 看过 / 听过）
  - 想读 / 想看 / 想听
- 自动翻页抓取完整目录
- 自动访问详情页补充字段
- 导出前自动排序，便于在 Notion 中归档查看
- 同时生成：
  - 普通表格 CSV
  - Notion 专用 CSV
  - JSON 备份

---

## 导出后的排序规则

为了更适合在 Notion 中查看与整理，脚本会在导出前按以下顺序排序：

1. 创作者（作者 / 导演 / 表演者）
2. 国家 / 地区
3. 年份
4. 标题

这会让数据在导入 Notion 后更适合继续分组、排序和筛选。

---

## 导出字段

不同媒介会尽量统一到同一套结构中，常见字段包括：

- 类型
- 标记状态
- 标题
- 创作者
- 国家 / 地区
- 豆瓣评分
- 我的评分
- 标记日期
- 发行 / 出版日期
- 年份
- 出版社 / 制片地区 / 厂牌
- ISBN / 条形码 / IMDb
- 定价
- 类型 / 流派
- 简评
- 摘要
- 封面链接
- 豆瓣链接
- Subject ID
- 原始信息（JSON 字符串）

Notion 专用 CSV 还会额外包含一些便于排序的列，例如：

- `Archive Sort Creator`
- `Archive Sort Country`
- `Archive Sort Year`

---

## 支持页面

脚本可在以下页面工作：

### 个人主页入口
- `https://www.douban.com/people/<你的ID>/`

### 书籍
- `https://book.douban.com/people/<你的ID>/collect`
- `https://book.douban.com/people/<你的ID>/wish`

### 电影
- `https://movie.douban.com/people/<你的ID>/collect`
- `https://movie.douban.com/people/<你的ID>/wish`

### 音乐
- `https://music.douban.com/people/<你的ID>/collect`
- `https://music.douban.com/people/<你的ID>/wish`

---

## 安装方法

### 1. 安装 Userscript 管理器
浏览器需先安装以下任意一种扩展：

- Tampermonkey
- Violentmonkey

### 2. 新建脚本
在脚本管理器中创建一个新脚本。

### 3. 保存脚本文件内容
将仓库中的 `notion-script.js` 全部内容复制进去并保存。

---

## 使用方法

1. 打开你的豆瓣个人主页。
2. 页面右下角会出现导出面板。
3. 选择导出格式：
   - 全部导出（表格 CSV + Notion CSV + JSON）
   - 只导出表格 CSV
   - 只导出 Notion CSV
   - 只导出 JSON
4. 点击对应按钮开始导出：
   - 导出读过的书 / 想读
   - 导出看过的片 / 想看
   - 导出听过的碟 / 想听
5. 脚本会自动翻页并抓取详情页信息。
6. 完成后会自动下载文件。

---

## 导入 Notion

导出的 `*.notion.csv` 可以直接用于导入 Notion。

推荐流程：

1. 打开 Notion
2. 新建一个数据库或页面
3. 选择 **Import**
4. 选择 `CSV`
5. 选中导出的 `*.notion.csv`

导入后可在 Notion 中按以下列继续整理：

- `Media Type`
- `Status`
- `Creator`
- `Country / Region`
- `Archive Sort Year`

---

## 文件输出说明

脚本通常会生成以下文件：

- `douban-book-collect-YYYYMMDD.csv`
- `douban-book-collect-YYYYMMDD.notion.csv`
- `douban-book-collect-YYYYMMDD.json`

电影和音乐同理。

### 各文件用途

- `.csv`
  - 普通表格查看
  - 适合 Excel / Numbers / Google Sheets
- `.notion.csv`
  - 适合直接导入 Notion
- `.json`
  - 作为完整原始备份
  - 便于后续重新清洗或写转换脚本

---

## 适合的使用场景

- 将豆瓣目录迁移到 Notion
- 备份豆瓣书影音数据
- 建立自己的书影音数据库
- 做个人阅读 / 观影 / 听音档案
- 后续接入其他知识管理工具

---

## 已知限制

- 豆瓣页面结构如果发生变化，脚本可能需要更新选择器。
- 个别条目详情页字段不完整时，导出结果也会不完整。
- 音乐、电影、书籍三类详情页结构并不完全一致，因此部分字段会因类型不同而为空。
- 导出大量条目时需要等待一段时间，因为脚本会逐页并访问详情页抓取信息。

---

## 隐私说明

此脚本仅在你的浏览器本地运行，用于读取你当前可见的豆瓣页面并导出数据。  
不会主动上传你的数据到第三方服务器。

---

## 仓库文件

- `notion-script.js`：主脚本文件
- `README.md`：使用说明

---

## 适合继续扩展的方向

后续可以继续扩展为：

- 支持豆列 / 片单 / 音乐清单导出
- 支持更多 Notion 字段映射
- 支持自定义排序规则
- 支持按标签 / 评分 / 年份筛选导出
- 支持导出 Markdown 或 HTML

---

## License

MIT
