#ifndef __OLED_H
#define __OLED_H

#include "stm32u5xx_hal.h"

// 正确I2C引脚定义 PB6=SCL PB7=SDA
#define OLED_W_SCL(x)  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define OLED_W_SDA(x)  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define OLED_ADDR 0x78

// 8*8小字配置
#define OLED_LINE_LEN_SMALL 16
#define OLED_LINE_NUM_SMALL 8
extern char oled_small_buf[OLED_LINE_NUM_SMALL][OLED_LINE_LEN_SMALL + 1];

// 16x16中文字库索引
#define CN_WANG  0
#define CN_LI    1
#define CN_ZHANG 2
#define CN_ZHAO  3
#define CN_CHEN  4
#define CN_MOU   5
#define CN_XIN   6
#define CN_XIN2  7
#define CN_QI    8
#define CN_HANG  9
#define CN_DUI   10

// 函数声明
void OLED_I2C_Init(void);
void OLED_Init(void);
void OLED_Clear(void);
void OLED_SetCursor(uint8_t Y, uint8_t X);
void OLED_ShowChar8(uint8_t Y, uint8_t X, char Char);
void OLED_ShowString8(uint8_t Y, uint8_t X, char *String);
void OLED_AppendSmallLog(char *str);
void OLED_ShowChinese16(uint8_t page, uint8_t col, uint8_t idx);
void OLED_ClearLine8(uint8_t Y);

#endif
