# 基于RFID温度感知与4G通信的冷链全链路溯源系统

## 项目简介

冷链运输温度感知与溯源终端，以 STM32U545 为核心，集成 KF720 RFID 读写、L610 4G 通信、W25Q64 Flash 存储、OLED 显示与 GPS 定位，通过 MQTT 接入华为云 IoTDA 实现数据上云与远程溯源。获第九届全国大学生嵌入式芯片与系统设计竞赛东部赛区三等奖。

## 硬件清单

| 模块 | 型号 | 说明 |
|---|---|---|
| 主控 | STM32U545 | ARM Cortex-M33，低功耗 |
| RFID 读写 | KF720 | 超高频无源 RFID，支持温度标签 |
| 4G 通信 | 广和通 L610 | Cat.1 4G 模组，MQTT 协议 |
| Flash | W25Q64 | 64Mb SPI Flash，断网数据缓存 |
| 显示 | OLED | 温度/GPS/网络状态实时显示 |
| 定位 | GPS | L610 内置 GPS，AT 指令控制 |

## 接线说明

| 外设 | 接口 | 引脚 |
|---|---|---|
| KF720 RFID | UART3 | PA7(TX) / PA5(RX) |
| L610 4G | LPUART1 | PA2(TX) / PA3(RX) |
| W25Q64 | SPI | 见 w25q_flash.c |
| OLED | I2C/SPI | 见 oled.c |

## 技术架构

```
嵌入式端 (STM32U545 + FreeRTOS)
├── KF720 RFID 驱动 — 标签轮询采集、温度读取、身份绑定
├── L610 4G 通信 — MQTT 接入华为云 IoTDA、GPS 定位
├── W25Q64 Flash — 断网数据本地缓存与自动补传
├── OLED 显示 — 温度/GPS/网络状态
└── 温度告警 — 高温>8℃ / 低温<2℃ 触发声光告警

服务端 (Node.js)
├── MQTT 订阅 — 接收设备数据
├── 华为云 IoTDA — 设备接入与数据通信
├── SQLite — 数据存储
└── SSE 推送 — 实时数据推送到前端

前端 (HTML + ECharts + Leaflet)
├── 温度曲线 — 实时温度可视化
├── 运输轨迹 — GPS 地图轨迹
└── 告警信息 — 实时告警展示
```

## 目录结构

```
├── STM32_嵌入式/       # STM32U545 固件源码
│   ├── main.c          # 主程序（RFID/4G/GPS/温度/告警逻辑）
│   ├── app_freertos.c  # FreeRTOS 任务配置
│   ├── oled.c/h        # OLED 驱动
│   ├── w25q_flash.c/h  # W25Q64 Flash 驱动
│   └── MMM3.ioc        # STM32CubeMX 工程文件
├── 前端_监控平台/       # Node.js 服务端 + 前端
│   ├── server.js       # Express 服务器
│   ├── mqttClient.js   # MQTT 客户端
│   ├── iotdaClient.js  # 华为云 IoTDA 对接
│   ├── database.js     # SQLite 数据库
│   └── frontend/       # 前端页面
├── docs/               # 文档资料
└── README.md
```

## 编译与烧录

### 嵌入式固件
1. 使用 STM32CubeMX 打开 `STM32_嵌入式/MMM3.ioc` 重新生成工程代码
2. 用 STM32CubeIDE 编译生成 .hex/.bin
3. 通过 ST-Link 烧录到 STM32U545

### 服务端
```bash
cd 前端_监控平台
npm install
npm start
```

## 关键设计

- **RFID 分步读取**：单条标签间隔 400ms，避免指令堆叠射频丢包
- **温度校验**：三路独立缓存，只更新合法范围（-20~85℃）温度
- **断网容错**：800ms 超时等待完整帧，未读到不覆盖历史正常温度
- **自动重连**：上电先释放网络再重拨号，每 2s 上报三路温度 JSON
- **GPS 定位**：AT+GTGPS=1 开启，AT+GTGIS=6 查询，ISR 只设标志不解析

## 许可证

本项目仅供学习与竞赛使用。