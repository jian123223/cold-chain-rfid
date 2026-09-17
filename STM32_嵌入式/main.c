/* USER CODE BEGIN Header */
/**
  STM32U5 FreeRTOS 冷链溯源整合工程
  优化点：
  1. 单条标签分步读取，每条间隔400ms，避免指令堆叠射频丢包
  2. 每次读卡清空接收缓存+清除串口溢出错误，脏数据不干扰下一次
  3. 800ms超时等待完整帧，未读到不覆盖历史正常温度
  4. 三路独立缓存+有效标志，只更新合法-20~85℃温度
  5. 上电先释放网络再重拨号，每2s上报三路温度JSON
  6. GPS定位：AT+GTGPS=1开启，AT+GTGIS=6查询，ISR只设标志不解析
  7. AT指令统一等待OK响应，避免缓冲区冲突
  8. OLED实时显示温度+GPS状态
*/
/* USER CODE END Header */
#include "main.h"
#include "stm32u5xx_hal.h"
#include "cmsis_os2.h"
#include "FreeRTOS.h"
#include "task.h"
#include "oled.h"
#include "w25q_flash.h"
#include <string.h>
#include <stdio.h>

//==================== 硬件串口句柄 ====================
UART_HandleTypeDef huart3;    // KF720 PA7(TX)/PA5(RX)
UART_HandleTypeDef hlpuart1;  // L610 PA2(TX)/PA3(RX)

//==================== KF720射频读卡配置 ====================
#define USART_RX_MAX    128U
uint8_t usart_rx_buf[USART_RX_MAX];
uint16_t rx_index = 0;
uint8_t frame_finish = 0;

//==================== GPS定位缓存 ====================
uint8_t gps_valid = 0;
char gps_location[64] = "0.000000,0.000000";
char gps_address[128] = "";
volatile uint8_t at_ok_flag = 0;
volatile uint8_t at_error_flag = 0;
// 三个标签指令：TAG1=118 TAG2=117 TAG3=116
const uint8_t KF720_CMD_TAG1[] = {0xBB,0x00,0xC0,0x00,0x0E,0x34,0x04,0x00,0x00,0x00,0x00,0x20,0x25,0x02,0x21,0x00,0x00,0x01,0x18,0x42,0x7E};
const uint8_t KF720_CMD_TAG2[] = {0xBB,0x00,0xC0,0x00,0x0E,0x34,0x04,0x00,0x00,0x00,0x00,0x20,0x25,0x02,0x21,0x00,0x00,0x01,0x17,0x42,0x7E};
const uint8_t KF720_CMD_TAG3[] = {0xBB,0x00,0xC0,0x00,0x0E,0x34,0x04,0x00,0x00,0x00,0x00,0x20,0x25,0x02,0x21,0x00,0x00,0x01,0x16,0x42,0x7E};
// 盘存指令（单步轮询所有标签EPC）
const uint8_t KF720_CMD_INVENTORY[] = {0xBB,0x00,0x22,0x00,0x00,0x22,0x7E};

#define TEMP_MIN        -20.0f
#define TEMP_MAX        85.0f
#define TEMP_ALARM_HIGH 8.0f
#define TEMP_ALARM_LOW  2.0f
float temp_buffer[3] = {25.0f, 25.0f, 25.0f};
uint8_t temp_valid[3] = {0, 0, 0};
uint8_t temp_alarm[3] = {0, 0, 0};
uint8_t network_online = 0;
uint16_t offline_count = 0;
uint8_t w25q_present = 0;
uint8_t pub_fail_cnt = 0;
uint8_t zeren = 0;
const uint8_t CN_ZEREN_XING[] = {CN_WANG, CN_LI, CN_ZHANG, CN_ZHAO, CN_CHEN};

//==================== 时间基准 ====================
typedef struct {
    uint16_t year;
    uint8_t  month;
    uint8_t  day;
    uint8_t  hour;
    uint8_t  min;
    uint8_t  sec;
} DateTime;

DateTime base_time = {2026, 1, 1, 0, 0, 0};
TickType_t base_tick = 0;
uint8_t time_valid = 0;

uint8_t days_in_month(uint8_t m, uint16_t y)
{
    const uint8_t d[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if(m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) return 29;
    return d[m - 1];
}

void datetime_add_seconds(DateTime *dt, uint32_t s)
{
    dt->sec += s;
    while(dt->sec >= 60) { dt->sec -= 60; dt->min++; }
    while(dt->min >= 60) { dt->min -= 60; dt->hour++; }
    while(dt->hour >= 24) { dt->hour -= 24; dt->day++; }
    while(dt->day > days_in_month(dt->month, dt->year)) { dt->day -= days_in_month(dt->month, dt->year); dt->month++; }
    while(dt->month > 12) { dt->month -= 12; dt->year++; }
}

void datetime_format(DateTime *dt, char *buf)
{
    sprintf(buf, "%04u%02u%02uT%02u%02u%02uZ",
            (unsigned)dt->year, (unsigned)dt->month, (unsigned)dt->day,
            (unsigned)dt->hour, (unsigned)dt->min, (unsigned)dt->sec);
}

uint32_t get_time_offset_s(void)
{
    if(!time_valid) return 0;
    return (xTaskGetTickCount() - base_tick) / configTICK_RATE_HZ;
}

typedef union{
    uint8_t dat[4];
    float temp_val;
}FloatConvert;

//==================== L610 4G AT缓冲区 ====================
#define AT_BUF_MAX 512U
char at_rx_buf[AT_BUF_MAX];
uint16_t at_rx_idx = 0;
char raw_json[256];
char escaped_json[256];
char at_cmd[512];

//==================== RTOS任务配置 ====================
osThreadId_t taskKFRead;
const osThreadAttr_t attrKFRead = {
    .name = "KF_ReadTask",
    .stack_size = 4096,
    .priority = osPriorityNormal
};

osThreadId_t task4GUpload;
const osThreadAttr_t attr4GUpload = {
    .name = "4G_UploadTask",
    .stack_size = 4096,
    .priority = osPriorityNormal
};

//==================== 函数声明 ====================
void Task_KF_SendCmd(void *arg);
uint8_t Read_Single_Tag(const uint8_t *cmd, uint16_t cmd_len);
void Parse_Tag_Data(void);
void Serial_SendString(char *str);
void AT_ClearBuf(void);
void L610_Init_Connect(void);
void L610_Send_TestData(void);
void L610_UploadTask(void *arg);
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART3_UART_Init(void);
static void MX_LPUART1_UART_Init(void);
void Error_Handler(void);
void Parse_GPS_Data(void);
void L610_Get_GPS_Location(void);
void L610_Send_GPSData(void);
uint8_t AT_WaitOK(uint32_t timeout_ms);
void OLED_UpdateDisplay(void);
void L610_Send_OfflineData(void);
uint8_t L610_WaitCGREG(uint32_t timeout_ms);
void L610_Get_NetworkTime(void);
//==================== 主函数 ====================
int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART3_UART_Init();
    MX_LPUART1_UART_Init();

    OLED_Init();
    OLED_Clear();
    OLED_ShowChinese16(1, 24, CN_XIN);
    OLED_ShowChinese16(1, 40, CN_XIN2);
    OLED_ShowChinese16(1, 56, CN_QI);
    OLED_ShowChinese16(1, 72, CN_HANG);
    OLED_ShowChinese16(1, 88, CN_DUI);
    OLED_ShowString8(4, 0, " Initializing.. ");

    W25Q_Init();
    w25q_present = W25Q_Detect();
    if(w25q_present)
        Cache_Init();

    HAL_UART_Receive_IT(&huart3, &usart_rx_buf[rx_index], 1);
    HAL_UART_Receive_IT(&hlpuart1, (uint8_t *)&at_rx_buf[at_rx_idx], 1);

    osKernelInitialize();
    taskKFRead = osThreadNew(Task_KF_SendCmd, NULL, &attrKFRead);
    task4GUpload = osThreadNew(L610_UploadTask, NULL, &attr4GUpload);
    osKernelStart();

    while(1);
}

//==================== 单条标签读取：清空缓存+500ms超时等待 ====================
uint8_t Read_Single_Tag(const uint8_t *cmd, uint16_t cmd_len)
{
    rx_index = 0;
    frame_finish = 0;
    memset(usart_rx_buf, 0, USART_RX_MAX);
    __HAL_UART_CLEAR_FLAG(&huart3, UART_FLAG_ORE|UART_FLAG_PE|UART_FLAG_FE|UART_FLAG_NE);
    HAL_UART_Receive_IT(&huart3, &usart_rx_buf[rx_index], 1);

    HAL_UART_Transmit(&huart3, cmd, cmd_len, 50);
    TickType_t start_tick = xTaskGetTickCount();
    // 800ms超时等待完整帧
    while((xTaskGetTickCount() - start_tick < pdMS_TO_TICKS(800)) && (!frame_finish))
    {
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    if(frame_finish)
    {
        Parse_Tag_Data(); // 无入参，内部自动识别真实标签ID
        return 1;
    }
    return 0;
}

//==================== 帧解析：合法温度才更新缓存 ====================
void Parse_Tag_Data(void)
{
    uint8_t real_tag_id = usart_rx_buf[18];
    uint8_t idx;
    // 根据帧内真实标签ID分配缓存下标，不依赖发送顺序
    if(real_tag_id == 0x18) idx = 0; // 118 → buffer[0]
    else if(real_tag_id == 0x17) idx = 1; // 117 → buffer[1]
    else if(real_tag_id == 0x16) idx = 2; // 116 → buffer[2]
    else return; // 未知标签直接丢弃

    // 校验完整27字节帧
    if(rx_index < 27 || usart_rx_buf[0] != 0xBB || usart_rx_buf[rx_index - 1] != 0x7E)
        return;

    FloatConvert fc;
    fc.dat[0] = usart_rx_buf[26];
    fc.dat[1] = usart_rx_buf[25];
    fc.dat[2] = usart_rx_buf[24];
    fc.dat[3] = usart_rx_buf[23];
    float temp = fc.temp_val;

    // 过滤0、超温，只更新有效温度
    if(temp > 0.0f && temp <= TEMP_MAX)
    {
        temp_buffer[idx] = temp;
        temp_valid[idx] = 1;
        if(temp > TEMP_ALARM_HIGH || temp < TEMP_ALARM_LOW)
            temp_alarm[idx] = 1;
        else
            temp_alarm[idx] = 0;
    }
}

//==================== 盘存响应解析：识别普通标签更新责任人 ====================
void Parse_Inventory_Data(void)
{
    if(rx_index < 10 || usart_rx_buf[0] != 0xBB || usart_rx_buf[rx_index - 1] != 0x7E)
        return;
    if(usart_rx_buf[1] != 0x02 || usart_rx_buf[2] != 0x22)
        return;

    uint8_t pc_hi = usart_rx_buf[6];
    // 只处理普通标签 PC=0x34 0x00
    if(pc_hi == 0x34 && usart_rx_buf[7] == 0x00)
    {
        uint8_t epc_len = (pc_hi / 8 + 1) * 2 - 2;
        if(rx_index < 8 + epc_len)
            return;
        uint8_t epc_last2_hi = usart_rx_buf[6 + epc_len];
        uint8_t epc_last2_lo = usart_rx_buf[7 + epc_len];
        if(epc_last2_hi == 0x87 && epc_last2_lo == 0x34) zeren = 1;
        else if(epc_last2_hi == 0x79 && epc_last2_lo == 0x96) zeren = 2;
        else if(epc_last2_hi == 0x80 && epc_last2_lo == 0x41) zeren = 3;
        else if(epc_last2_hi == 0x95 && epc_last2_lo == 0xBA) zeren = 4;
        else if(epc_last2_hi == 0x8E && epc_last2_lo == 0x62) zeren = 5;
    }
}

//==================== 盘存单步轮询：发盘存指令，解析责任人 ====================
void Do_Inventory(void)
{
    for(uint8_t n = 0; n < 3; n++)
    {
        rx_index = 0;
        frame_finish = 0;
        memset(usart_rx_buf, 0, USART_RX_MAX);
        __HAL_UART_CLEAR_FLAG(&huart3, UART_FLAG_ORE|UART_FLAG_PE|UART_FLAG_FE|UART_FLAG_NE);
        HAL_UART_Receive_IT(&huart3, &usart_rx_buf[rx_index], 1);

        HAL_UART_Transmit(&huart3, KF720_CMD_INVENTORY, sizeof(KF720_CMD_INVENTORY), 50);
        TickType_t start_tick = xTaskGetTickCount();
        while((xTaskGetTickCount() - start_tick < pdMS_TO_TICKS(500)) && (!frame_finish))
        {
            vTaskDelay(pdMS_TO_TICKS(5));
        }
        if(frame_finish)
        {
            Parse_Inventory_Data();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

//==================== KF读卡任务：逐条300ms间隔，整组2s周期 ====================
void Task_KF_SendCmd(void *arg)
{
    (void)arg;
    TickType_t wake = xTaskGetTickCount();
    uint8_t inv_cnt = 0;
    while(1)
    {
        inv_cnt++;
        if(inv_cnt >= 3)
        {
            Do_Inventory();
            inv_cnt = 0;
        }

        Read_Single_Tag(KF720_CMD_TAG1, sizeof(KF720_CMD_TAG1));
        vTaskDelay(pdMS_TO_TICKS(400));
        Read_Single_Tag(KF720_CMD_TAG2, sizeof(KF720_CMD_TAG2));
        vTaskDelay(pdMS_TO_TICKS(400));
        Read_Single_Tag(KF720_CMD_TAG3, sizeof(KF720_CMD_TAG3));

        vTaskDelayUntil(&wake, pdMS_TO_TICKS(2000));
    }
}

//==================== 串口中断：仅标记帧结束，无复杂运算 ====================
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
    if(huart->Instance == USART3)
    {
        rx_index++;
        if(usart_rx_buf[rx_index - 1] == 0x7E || rx_index >= USART_RX_MAX)
        {
            frame_finish = 1;
        }
        else
        {
            HAL_UART_Receive_IT(&huart3, &usart_rx_buf[rx_index], 1);
        }
    }
    else if(huart->Instance == LPUART1)
    {
        at_rx_idx++;
        if(at_rx_idx >= AT_BUF_MAX - 2)
        {
            at_rx_buf[AT_BUF_MAX - 1] = '\0';
            at_rx_idx = AT_BUF_MAX - 2;
        }

        if(at_rx_idx >= 2)
        {
            uint8_t ok_matched = 0;
            if(at_rx_idx >= 4 && at_rx_buf[at_rx_idx-4]=='O' && at_rx_buf[at_rx_idx-3]=='K' &&
               at_rx_buf[at_rx_idx-2]=='\r' && at_rx_buf[at_rx_idx-1]=='\n')
                ok_matched = 1;
            else if(at_rx_idx >= 2 && at_rx_buf[at_rx_idx-2]=='O' && at_rx_buf[at_rx_idx-1]=='K')
                ok_matched = 1;
            if(ok_matched)
                at_ok_flag = 1;
            else if(at_rx_idx >= 3 && at_rx_buf[at_rx_idx-3]=='E' && at_rx_buf[at_rx_idx-2]=='R' &&
                    at_rx_buf[at_rx_idx-1]=='R')
                at_error_flag = 1;
        }
        HAL_UART_Receive_IT(&hlpuart1, (uint8_t *)&at_rx_buf[at_rx_idx], 1);
    }
}

//==================== L610 AT底层工具 ====================
void Serial_SendString(char *str)
{
    HAL_UART_Transmit(&hlpuart1, (uint8_t *)str, strlen(str), 100);
}
void AT_ClearBuf(void)
{
    taskENTER_CRITICAL();
    memset(at_rx_buf, 0, AT_BUF_MAX);
    at_rx_idx = 0;
    at_ok_flag = 0;
    at_error_flag = 0;
    hlpuart1.RxState = HAL_UART_STATE_READY;
    __HAL_UART_CLEAR_FLAG(&hlpuart1, UART_FLAG_ORE|UART_FLAG_PE|UART_FLAG_FE|UART_FLAG_NE);
    HAL_UART_Receive_IT(&hlpuart1, (uint8_t *)&at_rx_buf[0], 1);
    taskEXIT_CRITICAL();
}

uint8_t AT_WaitOK(uint32_t timeout_ms)
{
    TickType_t start = xTaskGetTickCount();
    while((xTaskGetTickCount() - start) < pdMS_TO_TICKS(timeout_ms))
    {
        if(at_ok_flag) return 1;
        if(at_error_flag) return 0;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    return 0;
}

void L610_Get_NetworkTime(void)
{
    AT_ClearBuf();
    Serial_SendString("AT+CCLK?\r\n");
    if(!AT_WaitOK(2000)) return;
    at_rx_buf[at_rx_idx] = '\0';

    char *p = strstr(at_rx_buf, "+CCLK: \"");
    if(!p) return;
    p += strlen("+CCLK: \"");

    int y, mo, d, h, mi, s;
    if(sscanf(p, "%d/%d/%d,%d:%d:%d", &y, &mo, &d, &h, &mi, &s) == 6)
    {
        base_time.year = 2000 + y;
        base_time.month = mo;
        base_time.day = d;
        base_time.hour = h;
        base_time.min = mi;
        base_time.sec = s;
        base_tick = xTaskGetTickCount();
        time_valid = 1;
    }
    AT_ClearBuf();
}

//==================== L610网络初始化：先释放IP再拨号连云 ====================
void L610_Init_Connect(void)
{
    AT_ClearBuf();
    Serial_SendString("AT+MIPCALL=0\r\n");
    AT_WaitOK(2000);
    vTaskDelay(pdMS_TO_TICKS(500));
    AT_ClearBuf();
    Serial_SendString("AT+CGREG?\r\n");
    AT_WaitOK(2000);
    vTaskDelay(pdMS_TO_TICKS(500));
    AT_ClearBuf();
    Serial_SendString("AT+MIPCALL=1,\"3GNET\"\r\n");
    AT_WaitOK(5000);
    vTaskDelay(pdMS_TO_TICKS(1000));
    AT_ClearBuf();
    Serial_SendString("AT+HMCON=0,60,\"ec8501a87.st1.iotda-device.cn-north-4.myhuaweicloud.com\",\"1883\",\"69fd9d23cbb0cf6bb958c9d0_YUESE001\",\"lzq660034\",0\r\n");
    AT_WaitOK(5000);
    vTaskDelay(pdMS_TO_TICKS(1000));
    AT_ClearBuf();
    Serial_SendString("AT+GTGPS=1\r\n");
    AT_WaitOK(2000);
    vTaskDelay(pdMS_TO_TICKS(500));

    network_online = 1;

    L610_Get_NetworkTime();

    for(uint8_t retry = 0; retry < 5; retry++)
    {
        AT_ClearBuf();
        Serial_SendString("AT+GTGIS=6\r\n");
        vTaskDelay(pdMS_TO_TICKS(3000));
        at_rx_buf[at_rx_idx] = '\0';
        Parse_GPS_Data();
        if(gps_valid) break;
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    AT_ClearBuf();
}

uint8_t L610_WaitCGREG(uint32_t timeout_ms)
{
    TickType_t start = xTaskGetTickCount();
    while((xTaskGetTickCount() - start) < pdMS_TO_TICKS(timeout_ms))
    {
        AT_ClearBuf();
        Serial_SendString("AT+CGREG?\r\n");
        AT_WaitOK(2000);
        at_rx_buf[at_rx_idx] = '\0';
        if(strstr(at_rx_buf, "+CGREG: 0,1") || strstr(at_rx_buf, "+CGREG: 0,5"))
            return 1;
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
    return 0;
}

uint8_t l610_reset_cnt = 0;
TickType_t last_reset_tick = 0;

void L610_Reconnect(void)
{
    network_online = 0;

    if((xTaskGetTickCount() - last_reset_tick) >= pdMS_TO_TICKS(30000))
    {
        last_reset_tick = xTaskGetTickCount();
        AT_ClearBuf();
        Serial_SendString("AT+CFUN=1,1\r\n");
        AT_WaitOK(5000);

        vTaskDelay(pdMS_TO_TICKS(8000));
        AT_ClearBuf();
        Serial_SendString("AT\r\n");
        AT_WaitOK(2000);
        AT_ClearBuf();

        AT_ClearBuf();
        Serial_SendString("AT+MIPCALL=1,\"3GNET\"\r\n");
        if(!AT_WaitOK(5000))
            return;
        vTaskDelay(pdMS_TO_TICKS(1000));

        AT_ClearBuf();
        Serial_SendString("AT+HMCON=0,60,\"ec8501a87.st1.iotda-device.cn-north-4.myhuaweicloud.com\",\"1883\",\"69fd9d23cbb0cf6bb958c9d0_YUESE001\",\"lzq660034\",0\r\n");
        AT_WaitOK(5000);
        vTaskDelay(pdMS_TO_TICKS(1000));
        AT_ClearBuf();

        network_online = 1;
        l610_reset_cnt = 0;

        if(w25q_present && Cache_HasPending())
        {
            L610_Send_OfflineData();
            offline_count = 0;
        }
    }
}

//==================== 温度上报：JSON对应116/117/118编号 ====================
void L610_Send_TestData(void)
{
    int i = 0, j = 0;
    // temp_buffer[0]=118 temp_buffer[1]=117 temp_buffer[2]=116
    // buffer[0] = 118 → JSON key 2025022100000118
    // buffer[1] = 117 → JSON key 2025022100000117
    // buffer[2] = 116 → JSON key 2025022100000116
    float t116 = temp_buffer[2];
    float t117 = temp_buffer[1];
    float t118 = temp_buffer[0];
    uint8_t alarm_status = (temp_alarm[0] || temp_alarm[1] || temp_alarm[2]) ? 1 : 0;

    if(!network_online)
    {
        if(w25q_present)
        {
            Cache_SaveRecord(t116, t117, t118, alarm_status, gps_valid, gps_location, get_time_offset_s());
            offline_count++;
        }
        return;
    }

    char evt_time[20] = "";
    if(time_valid)
    {
        DateTime dt = base_time;
        datetime_add_seconds(&dt, get_time_offset_s());
        datetime_format(&dt, evt_time);
    }

    if(time_valid)
        sprintf(raw_json, "{\"services\":[{\"service_id\":\"DHDHGHETEG\",\"properties\":{\"2025022100000116\":%.1f,\"2025022100000117\":%.1f,\"2025022100000118\":%.1f,\"lianwang\":1,\"zeren\":%u},\"event_time\":\"%s\"}]}",
                t116, t117, t118, (unsigned)zeren, evt_time);
    else
        sprintf(raw_json, "{\"services\":[{\"service_id\":\"DHDHGHETEG\",\"properties\":{\"2025022100000116\":%.1f,\"2025022100000117\":%.1f,\"2025022100000118\":%.1f,\"lianwang\":1,\"zeren\":%u}}]}",
                t116, t117, t118, (unsigned)zeren);

    memset(escaped_json, 0, sizeof(escaped_json));
    while(raw_json[i] != '\0')
    {
        if(raw_json[i] == '"')
        {
            escaped_json[j++] = '\\';
            escaped_json[j++] = '"';
        }
        else
            escaped_json[j++] = raw_json[i];
        i++;
    }
    escaped_json[j] = '\0';

    sprintf(at_cmd, "AT+HMPUB=1,\"$oc/devices/69fd9d23cbb0cf6bb958c9d0_YUESE001/sys/properties/report\",%d,\"%s\"\r\n",
                (int)strlen(raw_json), escaped_json);
    AT_ClearBuf();
    Serial_SendString(at_cmd);
    uint8_t pub_ok = AT_WaitOK(2000);
    AT_ClearBuf();

    if(pub_ok)
    {
        pub_fail_cnt = 0;
        network_online = 1;
        if(w25q_present && Cache_HasPending())
        {
            L610_Send_OfflineData();
            offline_count = 0;
        }
    }
    else
    {
        network_online = 0;
        pub_fail_cnt = 0;
        if(w25q_present)
        {
            Cache_SaveRecord(t116, t117, t118, alarm_status, gps_valid, gps_location, get_time_offset_s());
            offline_count++;
        }
    }
}

//==================== 4G上报循环：每2s持续上报 ====================
void L610_UploadTask(void *arg)
{
    (void)arg;
    L610_Init_Connect();
    TickType_t gps_last_tick = xTaskGetTickCount();
    TickType_t cclk_last_tick = xTaskGetTickCount();
    const TickType_t gps_interval = pdMS_TO_TICKS(20000UL);
    const TickType_t cclk_interval = pdMS_TO_TICKS(60000UL);

    while(1)
    {
        L610_Send_TestData();

        if(!network_online)
        {
            L610_Reconnect();
        }

        if(network_online && (xTaskGetTickCount() - gps_last_tick) >= gps_interval)
        {
            L610_Get_GPS_Location();
            gps_last_tick = xTaskGetTickCount();
        }

        if(network_online && (xTaskGetTickCount() - cclk_last_tick) >= cclk_interval)
        {
            L610_Get_NetworkTime();
            cclk_last_tick = xTaskGetTickCount();
        }

        OLED_UpdateDisplay();
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
//==================== GPS定位读取：发送AT+GTGIS=6 等待应答 ====================
void L610_Get_GPS_Location(void)
{
    AT_ClearBuf();
    Serial_SendString("AT+GTGIS=6\r\n");
    vTaskDelay(pdMS_TO_TICKS(3000));
    at_rx_buf[at_rx_idx] = '\0';

    char dbg[17];
    sprintf(dbg, "GPS idx=%d", at_rx_idx);
    OLED_ShowString8(7, 0, dbg);
    for(int k = strlen(dbg); k < 16; k++) OLED_ShowChar8(7, k, ' ');

    Parse_GPS_Data();

    if(gps_valid)
    {
        L610_Send_GPSData();
    }
    AT_ClearBuf();
}

void Parse_GPS_Data(void)
{
    char *p_gps_line = strstr((char *)at_rx_buf, "+GTGIS: \"");
    if(p_gps_line == NULL)
    {
        gps_valid = 0;
        return;
    }

    p_gps_line += strlen("+GTGIS: \"");

    char *p_end_quote = strchr(p_gps_line, '"');
    if(p_end_quote == NULL)
    {
        gps_valid = 0;
        return;
    }

    uint16_t gps_str_len = p_end_quote - p_gps_line;
    if(gps_str_len == 0 || gps_str_len >= sizeof(gps_location))
    {
        gps_valid = 0;
        return;
    }

    memset(gps_location, 0, sizeof(gps_location));
    strncpy(gps_location, p_gps_line, gps_str_len);

    // 解析第二行+GTGIS: 地址描述
    char *p_addr_line = strstr(p_end_quote, "+GTGIS: \"");
    if(p_addr_line != NULL)
    {
        p_addr_line += strlen("+GTGIS: \"");
        char *p_addr_end = strchr(p_addr_line, '"');
        if(p_addr_end != NULL)
        {
            uint16_t addr_len = p_addr_end - p_addr_line;
            if(addr_len > 0 && addr_len < sizeof(gps_address))
            {
                memset(gps_address, 0, sizeof(gps_address));
                strncpy(gps_address, p_addr_line, addr_len);
            }
        }
    }

    gps_valid = 1;
}

//==================== 组装定位JSON并上报云端 ====================
void L610_Send_GPSData(void)
{
    int i = 0, j = 0;
    char gps_json_raw[384];
    char gps_json_esc[384];
    char gps_at_cmd[600];

    sprintf(gps_json_raw, "{\"services\":[{\"service_id\":\"DHDHGHETEG\",\"properties\":{\"dingwei\":\"%s\"}}]}",
            gps_location);

    memset(gps_json_esc, 0, sizeof(gps_json_esc));
    while(gps_json_raw[i] != '\0')
    {
        if(gps_json_raw[i] == '"')
        {
            gps_json_esc[j++] = '\\';
            gps_json_esc[j++] = '"';
        }
        else
            gps_json_esc[j++] = gps_json_raw[i];
        i++;
    }
    gps_json_esc[j] = '\0';

    sprintf(gps_at_cmd, "AT+HMPUB=1,\"$oc/devices/69fd9d23cbb0cf6bb958c9d0_YUESE001/sys/properties/report\",%d,\"%s\"\r\n",
                (int)strlen(gps_json_raw), gps_json_esc);
    AT_ClearBuf();
    Serial_SendString(gps_at_cmd);
    AT_WaitOK(2000);
    AT_ClearBuf();
}

//==================== 外设初始化 ====================
static void MX_GPIO_Init(void)
{
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();

    GPIO_InitTypeDef GPIO_InitStruct = {0};
    GPIO_InitStruct.Pin = GPIO_PIN_6 | GPIO_PIN_7;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, GPIO_PIN_SET);
}
static void MX_USART3_UART_Init(void)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    __HAL_RCC_USART3_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    GPIO_InitStruct.Pin = GPIO_PIN_5 | GPIO_PIN_7;
    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF7_USART3;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
    huart3.Instance = USART3;
    huart3.Init.BaudRate = 115200;
    huart3.Init.WordLength = UART_WORDLENGTH_8B;
    huart3.Init.StopBits = UART_STOPBITS_1;
    huart3.Init.Parity = UART_PARITY_NONE;
    huart3.Init.Mode = UART_MODE_TX_RX;
    huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart3.Init.OverSampling = UART_OVERSAMPLING_16;
    HAL_UART_Init(&huart3);
}
static void MX_LPUART1_UART_Init(void)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};
    __HAL_RCC_LPUART1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    GPIO_InitStruct.Pin = GPIO_PIN_2 | GPIO_PIN_3;
    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF8_LPUART1;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
    hlpuart1.Instance = LPUART1;
    hlpuart1.Init.BaudRate = 115200;
    hlpuart1.Init.WordLength = UART_WORDLENGTH_8B;
    hlpuart1.Init.StopBits = UART_STOPBITS_1;
    hlpuart1.Init.Parity = UART_PARITY_NONE;
    hlpuart1.Init.Mode = UART_MODE_TX_RX;
    hlpuart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    hlpuart1.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
    HAL_UART_Init(&hlpuart1);
}

//==================== 系统时钟（修复PLL层级编译错误） ====================
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};
  HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1);
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = 1;
  RCC_OscInitStruct.PLL.PLLN = 10;
  RCC_OscInitStruct.PLL.PLLP = 2;
  RCC_OscInitStruct.PLL.PLLQ = 2;
  RCC_OscInitStruct.PLL.PLLR = 2;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
    Error_Handler();
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK|RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_3) != HAL_OK)
    Error_Handler();
}

void Error_Handler(void)
{
  __disable_irq();
  while(1);
}

void OLED_UpdateDisplay(void)
{
    static uint8_t disp_cycle = 0;
    disp_cycle++;
    if(disp_cycle >= 7) disp_cycle = 0;

    if(disp_cycle >= 6 && zeren > 0)
    {
        OLED_Clear();
        OLED_ShowChinese16(0, 0, CN_ZEREN_XING[zeren - 1]);
        OLED_ShowChinese16(0, 16, CN_MOU);
        OLED_ShowString8(3, 0, "  Responsible   ");
        char zr_buf[17];
        sprintf(zr_buf, "  Person: %u     ", (unsigned)zeren);
        OLED_ShowString8(4, 0, zr_buf);
        return;
    }

    char line_buf[17];

    if(time_valid)
    {
        DateTime dt = base_time;
        datetime_add_seconds(&dt, get_time_offset_s());
        dt.hour += 8;
        while(dt.hour >= 24) { dt.hour -= 24; dt.day++; }
        while(dt.day > days_in_month(dt.month, dt.year)) { dt.day -= days_in_month(dt.month, dt.year); dt.month++; }
        while(dt.month > 12) { dt.month -= 12; dt.year++; }
        sprintf(line_buf, "%02u/%02u/%02u %02u:%02u",
                (unsigned)(dt.year % 100), (unsigned)dt.month, (unsigned)dt.day,
                (unsigned)dt.hour, (unsigned)dt.min);
    }
    else
    {
        sprintf(line_buf, "--/--/-- --:--");
    }
    OLED_ShowString8(0, 0, line_buf);
    for(int k = strlen(line_buf); k < 16; k++) OLED_ShowChar8(0, k, ' ');

    if(network_online)
    {
        OLED_ShowString8(1, 0, "4G:OK           ");
    }
    else
    {
        char net_buf[17];
        sprintf(net_buf, "4G:OFF c:%u", (unsigned)offline_count);
        OLED_ShowString8(1, 0, net_buf);
        for(int k = strlen(net_buf); k < 16; k++) OLED_ShowChar8(1, k, ' ');
    }

    sprintf(line_buf, "T118:%5.1fC%s", temp_buffer[0], temp_alarm[0] ? "!" : " ");
    OLED_ShowString8(2, 0, line_buf);
    for(int k = strlen(line_buf); k < 16; k++) OLED_ShowChar8(2, k, ' ');

    sprintf(line_buf, "T117:%5.1fC%s", temp_buffer[1], temp_alarm[1] ? "!" : " ");
    OLED_ShowString8(3, 0, line_buf);
    for(int k = strlen(line_buf); k < 16; k++) OLED_ShowChar8(3, k, ' ');

    sprintf(line_buf, "T116:%5.1fC%s", temp_buffer[2], temp_alarm[2] ? "!" : " ");
    OLED_ShowString8(4, 0, line_buf);
    for(int k = strlen(line_buf); k < 16; k++) OLED_ShowChar8(4, k, ' ');

    if(gps_valid)
    {
        char *comma = strchr(gps_location, ',');
        if(comma)
        {
            char buf[17];
            uint16_t lon_len = comma - gps_location;
            if(lon_len > 16) lon_len = 16;
            OLED_ShowString8(5, 0, "GPS:OK          ");
            memset(buf, 0, sizeof(buf));
            strncpy(buf, gps_location, lon_len);
            OLED_ShowString8(6, 0, buf);
            for(int k = strlen(buf); k < 16; k++) OLED_ShowChar8(6, k, ' ');
            memset(buf, 0, sizeof(buf));
            strncpy(buf, comma + 1, 16);
            OLED_ShowString8(7, 0, buf);
            for(int k = strlen(buf); k < 16; k++) OLED_ShowChar8(7, k, ' ');
        }
        else
        {
            OLED_ShowString8(5, 0, "GPS:OK          ");
            OLED_ShowString8(6, 0, gps_location);
            for(int k = strlen(gps_location); k < 16; k++) OLED_ShowChar8(6, k, ' ');
            OLED_ShowString8(7, 0, "                ");
        }
    }
    else
    {
        OLED_ShowString8(5, 0, "GPS:Waiting...  ");
        OLED_ShowString8(6, 0, "                ");
        OLED_ShowString8(7, 0, "                ");
    }
}

void L610_Send_OfflineData(void)
{
    CacheRecord rec;
    uint8_t batch = 0;

    while(Cache_HasPending() && batch < 10)
    {
        if(Cache_ReadPending(&rec))
        {
            float t116 = rec.temp_116_10 / 10.0f;
            float t117 = rec.temp_117_10 / 10.0f;
            float t118 = rec.temp_118_10 / 10.0f;

            int i = 0, j = 0;
            char off_json[320];
            char off_json_esc[320];
            char off_at_cmd[600];

            if(time_valid && rec.time_offset_s > 0)
            {
                DateTime dt = base_time;
                datetime_add_seconds(&dt, rec.time_offset_s);
                char evt[20];
                datetime_format(&dt, evt);
                sprintf(off_json, "{\"services\":[{\"service_id\":\"DHDHGHETEG\",\"properties\":{\"2025022100000116\":%.1f,\"2025022100000117\":%.1f,\"2025022100000118\":%.1f,\"lianwang\":0,\"zeren\":%u},\"event_time\":\"%s\"}]}",
                        t116, t117, t118, (unsigned)zeren, evt);
            }
            else
            {
                sprintf(off_json, "{\"services\":[{\"service_id\":\"DHDHGHETEG\",\"properties\":{\"2025022100000116\":%.1f,\"2025022100000117\":%.1f,\"2025022100000118\":%.1f,\"lianwang\":0,\"zeren\":%u}}]}",
                        t116, t117, t118, (unsigned)zeren);
            }

            memset(off_json_esc, 0, sizeof(off_json_esc));
            while(off_json[i] != '\0')
            {
                if(off_json[i] == '"')
                {
                    off_json_esc[j++] = '\\';
                    off_json_esc[j++] = '"';
                }
                else
                    off_json_esc[j++] = off_json[i];
                i++;
            }
            off_json_esc[j] = '\0';

            sprintf(off_at_cmd, "AT+HMPUB=1,\"$oc/devices/69fd9d23cbb0cf6bb958c9d0_YUESE001/sys/properties/report\",%d,\"%s\"\r\n",
                        (int)strlen(off_json), off_json_esc);
            AT_ClearBuf();
            Serial_SendString(off_at_cmd);
            if(AT_WaitOK(2000))
            {
                Cache_Clear();
            }
            else
            {
                break;
            }
            AT_ClearBuf();
        }
        else
        {
            Cache_Clear();
        }
        batch++;
        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

#ifdef USE_FULL_ASSERT
void assert_failed(uint8_t *file,uint32_t line){}
#endif
