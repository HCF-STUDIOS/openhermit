---
name: order-labels
description: 批量处理 Amiko staking 订单截图，自动识别 Order 位置并添加金色标签。触发条件：用户提到"处理订单图片"、"加标签"、"order截图"、指定包含日期的文件夹名（如"8.20-21"）时自动调用。
---

# 订单标签处理 Skill

## 任务说明
批量给 Amiko staking 订单截图添加金色日期标签，用于营销推广。

## 核心规则（不可改变）
1. **遮住 Order #X** — 标签必须完整覆盖"Order"文字及后面的序号（如 #1、#2）
2. **不遮住金额** — 标签下方的 Staked Value（如 $20,000.00）必须完整可见
3. **金额写入标签** — 从图片 OCR 提取金额，写在标签第二行
4. **自动识别日期** — 从文件夹名解析（如 `8.20-21` → 8月20日/8月21日），也可用户指定

## 标签样式规范
- **形状**：方形，无圆角（更真实的 p 图效果）
- **颜色**：亮金色背景 `RGB(255, 215, 0)`，黑色文字
- **倾斜**：-5 度
- **布局**：两行
  - 第一行（40pt）：`{日期} {消息}` — 例：`8月20日 东南亚沙龙会议火爆入单`
  - 第二行（38pt）：`金额: $XX,XXX.XX`
- **位置**：标签中心对齐图片宽度，Y 坐标 = OCR 检测到的 Order 文字 Y - 40px

## 固定消息内容
```
东南亚沙龙会议火爆入单
```
（除非用户明确要求更换）

## 执行流程

### 1. 确认输入
- 询问或识别：文件夹路径、日期（若文件夹名无法解析）
- 支持格式：jpg、jpeg、png、webp、bmp

### 2. 处理每张图片
```python
# 伪代码流程
for each image in folder:
    order_info = ocr_find_order(image)        # 找 Order 文字 y 坐标
    amount = ocr_find_amount(image)           # 找第一个 $xxx,xxx 金额
    label_y = order_info.y - 40              # 上移40px确保覆盖序号
    draw_square_label(image, label_y, date, amount)
    save to labeled_output/
```

### 3. 输出
- 保存到输入文件夹的 `labeled_output/` 子目录
- 文件名格式：`labeled_{序号}_{原文件名}`

## 技术实现

### 依赖
```bash
pip install pillow pytesseract numpy
# Windows 还需安装 Tesseract OCR:
# https://github.com/UB-Mannheim/tesseract/wiki
```

### 字体优先级（中文支持）
1. `C:\Windows\Fonts\msyhbd.ttc`（微软雅黑 Bold，Windows 首选）
2. `C:\Windows\Fonts\msyh.ttc`
3. `/System/Library/Fonts/PingFang.ttc`（macOS）
4. `/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc`（Linux）

### 关键代码段
```python
# 方形标签（无圆角）
draw.rectangle([0, 0, label_width, label_height], fill=(255, 215, 0, 255))

# 标签定位：覆盖 Order #X
label_pos_y = max(0, order_y - 40)

# 旋转
rotated = label.rotate(-5, expand=True, resample=Image.BICUBIC)
```

## 常见问题处理

| 问题 | 处理方式 |
|------|----------|
| OCR 未检测到 Order | 跳过该图片，输出警告 |
| 未找到金额 | 只显示第一行（日期+消息），不显示金额行 |
| 字体加载失败 | 回退到 PIL 默认字体 |
| 文件夹名无法解析日期 | 询问用户手动输入日期 |

## 调用示例

用户说：
- "处理 `C:\Users\admin\Desktop\8.20-21` 里的图片"
- "下一批，21号的"
- "发图片 [上传图片]"

对应操作：
1. 识别日期（文件夹名/用户说明/图片内容中的 Start Date）
2. 更新 `IMAGES` 列表或 `--folder` 参数
3. 运行处理，返回标注好的图片
