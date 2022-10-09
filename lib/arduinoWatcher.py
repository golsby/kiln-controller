from ast import Return
import sys
import fcntl
import io
import struct
import time
import logging
log = logging.getLogger(__name__)

SET_MAX_TEMP = 0
GET_CURRENT_TEMP = 1
OK = 2
ERROR = 3
OVER_TEMP_ALARM = 4
RESET = 5
GET_MAX_TEMP = 5  

class KilnWatcherError(Exception):
    pass

class OverTempAlarmError(Exception):
    pass  

class I2CMessage(object):
   def __init__(self):
      self.type = 3
      self.value = 1000.0
      
   def to_bytes(self):
      btype = struct.pack("h", self.type)
      bvalue = struct.pack("f", self.value)
      return btype + bvalue
   
   @classmethod
   def from_bytes(cls, bytes):
      result = I2CMessage()
      result.type = bytes[0]
      [result.value] = struct.unpack('f', bytes[2:6])
      return result

if sys.hexversion < 0x03000000:
    def _b(x):
        return x
else:
    def _b(x):
        return x.encode('latin-1')


class i2c:
    def __init__(self, device, bus):

        self.fr = io.open("/dev/i2c-"+str(bus), "rb", buffering=0)
        self.fw = io.open("/dev/i2c-"+str(bus), "wb", buffering=0)

        # set device address
        I2C_SLAVE = 0x0703

        fcntl.ioctl(self.fr, I2C_SLAVE, device)
        fcntl.ioctl(self.fw, I2C_SLAVE, device)

    def write(self, bytes):
        self.fw.write(bytes)

    def read(self, count):
        return self.fr.read(count)

    def close(self):
        self.fw.close()
        self.fr.close()
        
        
class ArduinoWatcher():
    def __init__(self, device, bus):
        self.device = i2c(device, bus)
        
    def _writeMessage(self, msgType, value):
        msg = I2CMessage()
        msg.type = msgType
        msg.value = value
        self.device.write(msg.to_bytes())
        
    def _readMessage(self):
        result = I2CMessage.from_bytes(self.device.read(6))
        if result.type == ERROR:
            raise KilnWatcherError()
        elif result.type == OVER_TEMP_ALARM:
            raise OverTempAlarmError(result.value)
        return result

    def setMaxTemp(self, degreesC):
        degreesC = min(degreesC, 1340)
        self._writeMessage(SET_MAX_TEMP, float(degreesC))
        result = self._readMessage()
        return result.value
    
    def getMaxTemp(self):
        self._writeMessage(GET_MAX_TEMP, 0)
        result = self._readMessage()
        return result.value
    
    def getCurrentTemp(self):
        self._writeMessage(GET_CURRENT_TEMP, 0)
        result = self._readMessage()
        return result.value
        