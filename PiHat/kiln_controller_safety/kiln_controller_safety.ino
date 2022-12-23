// Over-temp Safety System

// Include the Wire library for I2C
#include <Wire.h>
#include <SPI.h>
#include <avr/wdt.h>
#include "Adafruit_MAX31855.h"

enum MessageType
{
  SetMaxTemp,
  GetCurrentTemp,
  OK,
  ERROR,
  OVER_TEMP_ALARM,
  RESET,
  GetMaxTemp
};

struct msg
{
  unsigned int type;
  double value;
};

// Pin Configuration
#define MAXDO 2
#define MAXCS 3
#define MAXCLK 4
#define ENABLE_PIN 12

msg msg_received;
msg output_message;
int error_state = 0;

double temp_stack[50];
int temp_stack_index = 0;
int temp_stack_max = 50;

double max_temp = 1000.0; // degrees C
bool over_temp_alarm = false;
double current_temp = 1234.0; // degrees C
double internal_temp = 0.0;
Adafruit_MAX31855 thermocouple(MAXCLK, MAXCS, MAXDO);
char log_msg[200];

void setup()
{
  for (int i = 0; i < temp_stack_max; i++)
  {
    temp_stack[i] = 0.0;
  }
  // Join I2C bus as slave with address 8
  Wire.begin(0x8);

  // Call receiveEvent when data received
  Wire.onReceive(onDataReceived);
  Wire.onRequest(onDataRequested);

  // Setup MAX31855
  Serial.begin(9600);

  Serial.println("MAX31855 setting up...");
  // wait for MAX chip to stabilize
  delay(500);
  Serial.print("Initializing sensor...");
  while (1)
  {
    if (thermocouple.begin())
    {
      break;
    }
    else
    {
      Serial.print(".");
      delay(10);
    }
  }

  // OPTIONAL: Can configure fault checks as desired (default is ALL)
  // Multiple checks can be logically OR'd together.
  // thermocouple.setFaultChecks(MAX31855_FAULT_OPEN | MAX31855_FAULT_SHORT_VCC);  // short to GND fault is ignored

  Serial.println(" done.");

  // Setup output pin
  pinMode(ENABLE_PIN, OUTPUT);
  digitalWrite(ENABLE_PIN, LOW);
}

void reboot()
{
  wdt_disable();
  wdt_enable(WDTO_15MS);
  while (1)
  {
  }
}

// Function that executes whenever data is received from master
void onDataReceived(int numBytes)
{
  // Serial.print("Received event with bytes: ");
  // Serial.println(numBytes);
  // Serial.print("Hoping for bytes: ");
  // Serial.println(sizeof(msg));

  if (Wire.available())
  { // loop through all but the last
    // Serial.println("  receiving...");
    Wire.readBytes((byte *)&msg_received, sizeof(msg_received));

    char msg[100];
    sprintf(msg, "Message %d received.", msg_received.type);
    Serial.println(msg);

    if (msg_received.type == MessageType::SetMaxTemp)
    {
      max_temp = msg_received.value;
      Serial.println("Setting max temp to:");
      Serial.println(max_temp);
    }
    if (msg_received.type == MessageType::RESET)
    {
      reboot();
    }
  }
  // Serial.println("   done...");
}

// Function is called when master requests data from us.
void onDataRequested()
{
  if (over_temp_alarm)
  {
    output_message.type = MessageType::OVER_TEMP_ALARM;
    output_message.value = ComputeCurrentTemp();
  }
  else
  {
    switch (msg_received.type)
    {
    case MessageType::SetMaxTemp:
      output_message.type = MessageType::OK;
      output_message.value = max_temp;
      break;
    case MessageType::GetMaxTemp:
      output_message.type = MessageType::GetMaxTemp;
      output_message.value = max_temp;
      break;
    case MessageType::GetCurrentTemp:
    {
      double currentTemp = ComputeCurrentTemp();
      if (isnan(currentTemp))
      {
        output_message.type = MessageType::ERROR;
        output_message.value = error_state;
      }
      else
      {
        output_message.type = MessageType::GetCurrentTemp;
        output_message.value = currentTemp;
      }
      break;
    }
    default:
      output_message.type = MessageType::ERROR;
      output_message.value = 0;
      break;
    }
  }
  Wire.write((byte *)&output_message, sizeof(output_message));
}

double ComputeCurrentTemp()
{
  double value = 0.0;
  int valid_value_count = 0;
  for (int i = 0; i < temp_stack_max; i++)
  {
    if (isnan(temp_stack[i]))
      continue;

    value += temp_stack[i];
    valid_value_count++;
  }

  if (valid_value_count == 0)
  {
    // Serial.println("    ComputeCurrentTemp: INVALID");
    return 0xFFFFFFFF;
  }

  double computedTemp = value / valid_value_count;
  char sCurrentTemp[20];
  char msg[200];
  dtostrf(computedTemp, 7, 1, sCurrentTemp);
  sprintf(msg, "    ComputeCurrentTemp %s from %d ", sCurrentTemp, valid_value_count);
  // Serial.println(msg);
  return computedTemp;
}

void append_temp(double value)
{
  temp_stack[temp_stack_index++] = value;
  if (temp_stack_index >= temp_stack_max)
  {
    temp_stack_index = 0;
  }
}

int measureTemp()
{
  internal_temp = thermocouple.readInternal();
  current_temp = thermocouple.readCelsius();
  uint8_t e = 0;
  // sprintf(sError, "UNINIT");

  append_temp(current_temp);

  if (isnan(current_temp))
  {
    // Serial.println("Thermocouple fault(s) detected!");
    e = thermocouple.readError();
    if (e & MAX31855_FAULT_OPEN)
    {
      // Serial.println("FAULT: Thermocouple is open - no connections.");
      error_state = MAX31855_FAULT_OPEN;
      // sprintf(sError, "OPEN");
    }
    else if (e & MAX31855_FAULT_SHORT_GND)
    {
      // Serial.println("FAULT: Thermocouple is short-circuited to GND.");
      error_state = MAX31855_FAULT_SHORT_GND;
      // sprintf(sError, "SHORT -> GND");
    }
    else if (e & MAX31855_FAULT_SHORT_VCC)
    {
      // Serial.println("FAULT: Thermocouple is short-circuited to VCC.");
      error_state = MAX31855_FAULT_SHORT_VCC;
      // sprintf(sError, "SHORT -> VCC");
    }
    else
    {
      // Serial.println("FAULT: UNKNOWN");
      error_state = 99;
      // sprintf(sError, "ERR UNKNOWN %d", 99);
    }
  }
  else
  {
    error_state = 0;
    // sprintf(sError, "OK");
  }

  return error_state;
}

void loop()
{
  // char sCurrentTemp[20], sMaxTemp[20], sInternalTemp[20], sError[20];
  int error_state = measureTemp();

  double ct = ComputeCurrentTemp();

  if (isnan(ct))
  {
    Serial.println("Temp NaN");
    digitalWrite(ENABLE_PIN, LOW);
  }
  else
  {
    if (ct < max_temp && !over_temp_alarm)
    {
      // Serial.println("Temp GOOD");
      digitalWrite(ENABLE_PIN, HIGH);
    }
    else
    {
      Serial.println("Temp OVER");
      digitalWrite(ENABLE_PIN, LOW);
      over_temp_alarm = true;
    }
  }
  // dtostrf(current_temp, 7, 1, sCurrentTemp);
  // dtostrf(max_temp, 7, 1, sMaxTemp);
  // dtostrf(internal_temp, 7, 1, sInternalTemp);
  // sprintf(log_msg, "Thermocouple: %s | Max: %s | Internal: %s | State: %s", sCurrentTemp, sMaxTemp, sInternalTemp, sError);
  // Serial.println(log_msg);
  delay(10);
}
