#ifndef __W25Q_FLASH_H
#define __W25Q_FLASH_H

#include "stm32u5xx_hal.h"

#define W25Q_SECTOR_SIZE   4096
#define W25Q_PAGE_SIZE     256

#define W25Q_CLK_HIGH      HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_SET)
#define W25Q_CLK_LOW       HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_RESET)
#define W25Q_MOSI_HIGH     HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1, GPIO_PIN_SET)
#define W25Q_MOSI_LOW      HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1, GPIO_PIN_RESET)
#define W25Q_MISO_READ     HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_4)
#define W25Q_CS_LOW        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET)
#define W25Q_CS_HIGH       HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET)

#define CACHE_RECORD_SIZE  32

typedef struct __attribute__((packed)) {
    uint8_t  valid;
    uint8_t  alarm;
    int16_t  temp_116_10;
    int16_t  temp_117_10;
    int16_t  temp_118_10;
    uint8_t  gps_valid;
    uint32_t time_offset_s;
    char     gps_loc[14];
} CacheRecord;

void W25Q_Init(void);
uint8_t W25Q_Detect(void);
uint8_t W25Q_ReadStatusReg(void);
void W25Q_WriteEnable(void);
uint8_t W25Q_WaitBusy(void);
void W25Q_EraseSector(uint32_t addr);
void W25Q_WritePage(uint32_t addr, uint8_t *data, uint16_t len);
void W25Q_ReadData(uint32_t addr, uint8_t *buf, uint16_t len);

void Cache_Init(void);
void Cache_SaveRecord(float t116, float t117, float t118, uint8_t alarm, uint8_t gps_v, char *gps, uint32_t time_off);
uint8_t Cache_HasPending(void);
uint8_t Cache_ReadPending(CacheRecord *rec);
void Cache_Clear(void);

extern uint32_t cache_write_addr;
extern uint32_t cache_read_addr;

#endif
