# 基于RFID温度感知与4G通信的冷链全链路溯源系统

## 项目简介
冷链运输温度感知与溯源终端，以STM32U545为核心，集成KF720 RFID、L610 4G模组、W25Q Flash、OLED显示屏，通过华为云IoTDA实现数据上云。

## 技术栈
- 硬件：STM32U545 + KF720 + L610 + W25Q64 + OLED
- 云平台：华为云IoTDA
- 服务端：Node.js + Express + SQLite
- 前端：ECharts + Leaflet + SSE

## 目录结构
- `STM32/` - 嵌入式工程源码
- `frontend/` - 前端监控平台
- `docs/` - 文档资料