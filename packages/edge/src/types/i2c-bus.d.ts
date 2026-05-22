declare module "i2c-bus" {
  export interface I2CBus {
    scanSync(): number[];
    readByteSync(addr: number, cmd: number): number;
    readWordSync(addr: number, cmd: number): number;
    readI2cBlockSync(addr: number, cmd: number, length: number, buffer: Buffer): number;
    writeByteSync(addr: number, cmd: number, byte: number): void;
    closeSync(): void;
  }
  export function openSync(busNumber: number): I2CBus;
}
