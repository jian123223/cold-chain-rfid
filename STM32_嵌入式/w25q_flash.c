#include "w25q_flash.h"
#include <string.h>

uint32_t cache_write_addr = 0;
uint32_t cache_read_addr = 0;

static void W25Q_GPIO_Init(void)
{
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();

    GPIO_InitTypeDef GPIO_InitStruct = {0};

    GPIO_InitStruct.Pin = GPIO_PIN_0 | GPIO_PIN_1;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_PULLUP;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

    GPIO_InitStruct.Pin = GPIO_PIN_4;
    GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
    GPIO_InitStruct.Pull = GPIO_PULLUP;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

    GPIO_InitStruct.Pin = GPIO_PIN_0;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_PULLUP;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

    W25Q_CS_HIGH;
    W25Q_CLK_LOW;
}

static uint8_t W25Q_SpiTransfer(uint8_t data)
{
    uint8_t rx = 0;
    for(uint8_t i = 0; i < 8; i++)
    {
        if(data & 0x80)
            W25Q_MOSI_HIGH;
        else
            W25Q_MOSI_LOW;

        W25Q_CLK_HIGH;
        rx <<= 1;
        if(W25Q_MISO_READ)
            rx |= 1;
        W25Q_CLK_LOW;

        data <<= 1;
    }
    return rx;
}

void W25Q_Init(void)
{
    W25Q_GPIO_Init();
}

uint8_t W25Q_Detect(void)
{
    uint8_t id[3] = {0};
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x9F);
    id[0] = W25Q_SpiTransfer(0xFF);
    id[1] = W25Q_SpiTransfer(0xFF);
    id[2] = W25Q_SpiTransfer(0xFF);
    W25Q_CS_HIGH;

    if(id[0] == 0xFF && id[1] == 0xFF && id[2] == 0xFF)
        return 0;
    if(id[0] == 0x00 && id[1] == 0x00 && id[2] == 0x00)
        return 0;
    return 1;
}

uint8_t W25Q_ReadStatusReg(void)
{
    uint8_t val;
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x05);
    val = W25Q_SpiTransfer(0xFF);
    W25Q_CS_HIGH;
    return val;
}

void W25Q_WriteEnable(void)
{
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x06);
    W25Q_CS_HIGH;
}

uint8_t W25Q_WaitBusy(void)
{
    uint32_t cnt = 0;
    while(W25Q_ReadStatusReg() & 0x01)
    {
        if(++cnt > 100000) return 0;
    }
    return 1;
}

void W25Q_EraseSector(uint32_t addr)
{
    W25Q_WriteEnable();
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x20);
    W25Q_SpiTransfer((addr >> 16) & 0xFF);
    W25Q_SpiTransfer((addr >> 8) & 0xFF);
    W25Q_SpiTransfer(addr & 0xFF);
    W25Q_CS_HIGH;
    W25Q_WaitBusy();
}

void W25Q_WritePage(uint32_t addr, uint8_t *data, uint16_t len)
{
    W25Q_WriteEnable();
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x02);
    W25Q_SpiTransfer((addr >> 16) & 0xFF);
    W25Q_SpiTransfer((addr >> 8) & 0xFF);
    W25Q_SpiTransfer(addr & 0xFF);
    for(uint16_t i = 0; i < len; i++)
        W25Q_SpiTransfer(data[i]);
    W25Q_CS_HIGH;
    W25Q_WaitBusy();
}

void W25Q_ReadData(uint32_t addr, uint8_t *buf, uint16_t len)
{
    W25Q_CS_LOW;
    W25Q_SpiTransfer(0x03);
    W25Q_SpiTransfer((addr >> 16) & 0xFF);
    W25Q_SpiTransfer((addr >> 8) & 0xFF);
    W25Q_SpiTransfer(addr & 0xFF);
    for(uint16_t i = 0; i < len; i++)
        buf[i] = W25Q_SpiTransfer(0xFF);
    W25Q_CS_HIGH;
}

void Cache_Init(void)
{
    cache_write_addr = 0;
    cache_read_addr = 0;

    CacheRecord rec;
    for(uint32_t addr = 0; addr < W25Q_SECTOR_SIZE * 4; addr += CACHE_RECORD_SIZE)
    {
        W25Q_ReadData(addr, (uint8_t *)&rec, sizeof(CacheRecord));
        if(rec.valid == 0xAA)
        {
            if(cache_read_addr == 0)
                cache_read_addr = addr;
            cache_write_addr = addr + CACHE_RECORD_SIZE;
        }
        else
        {
            break;
        }
    }
}

void Cache_SaveRecord(float t116, float t117, float t118, uint8_t alarm, uint8_t gps_v, char *gps, uint32_t time_off)
{
    if(cache_write_addr % W25Q_SECTOR_SIZE == 0 && cache_write_addr > 0)
    {
        W25Q_EraseSector(cache_write_addr);
    }

    CacheRecord rec;
    memset(&rec, 0, sizeof(CacheRecord));
    rec.valid = 0xAA;
    rec.alarm = alarm;
    rec.temp_116_10 = (int16_t)(t116 * 10);
    rec.temp_117_10 = (int16_t)(t117 * 10);
    rec.temp_118_10 = (int16_t)(t118 * 10);
    rec.gps_valid = gps_v;
    rec.time_offset_s = time_off;
    strncpy(rec.gps_loc, gps, sizeof(rec.gps_loc) - 1);

    W25Q_WritePage(cache_write_addr, (uint8_t *)&rec, sizeof(CacheRecord));
    cache_write_addr += CACHE_RECORD_SIZE;
}

uint8_t Cache_HasPending(void)
{
    if(cache_read_addr >= cache_write_addr)
        return 0;
    return 1;
}

uint8_t Cache_ReadPending(CacheRecord *rec)
{
    if(!Cache_HasPending())
        return 0;

    W25Q_ReadData(cache_read_addr, (uint8_t *)rec, sizeof(CacheRecord));
    if(rec->valid == 0xAA)
    {
        if(rec->temp_116_10 < -500 || rec->temp_116_10 > 850 ||
           rec->temp_117_10 < -500 || rec->temp_117_10 > 850 ||
           rec->temp_118_10 < -500 || rec->temp_118_10 > 850)
        {
            rec->valid = 0x55;
            W25Q_WritePage(cache_read_addr, (uint8_t *)rec, sizeof(CacheRecord));
            cache_read_addr += CACHE_RECORD_SIZE;
            return Cache_ReadPending(rec);
        }
        return 1;
    }
    return 0;
}

void Cache_Clear(void)
{
    if(cache_read_addr >= cache_write_addr)
        return;

    CacheRecord rec;
    W25Q_ReadData(cache_read_addr, (uint8_t *)&rec, sizeof(CacheRecord));
    rec.valid = 0x55;
    W25Q_WritePage(cache_read_addr, (uint8_t *)&rec, sizeof(CacheRecord));
    cache_read_addr += CACHE_RECORD_SIZE;

    if(cache_read_addr >= cache_write_addr)
    {
        for(uint32_t addr = 0; addr < cache_write_addr + W25Q_SECTOR_SIZE; addr += W25Q_SECTOR_SIZE)
            W25Q_EraseSector(addr);
        cache_write_addr = 0;
        cache_read_addr = 0;
    }
}
