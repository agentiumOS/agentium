declare module "@stoprocent/noble" {
  import { EventEmitter } from "node:events";

  export interface Peripheral {
    id: string;
    uuid: string;
    address: string;
    addressType: string;
    rssi: number;
    advertisement: {
      localName?: string;
      serviceUuids?: string[];
      manufacturerData?: Buffer;
    };
    connect(callback: (err?: Error) => void): void;
    disconnect(callback?: (err?: Error) => void): void;
    discoverAllServicesAndCharacteristics(
      callback: (err: Error | null, services: Service[], characteristics: Characteristic[]) => void,
    ): void;
  }

  export interface Service {
    uuid: string;
  }

  export interface Characteristic {
    uuid: string;
    properties: string[];
    read(callback: (err: Error | null, data: Buffer) => void): void;
    write(data: Buffer, withoutResponse: boolean, callback: (err?: Error) => void): void;
    subscribe(callback: (err?: Error) => void): void;
    unsubscribe(callback: (err?: Error) => void): void;
    on(event: string, callback: (...args: any[]) => void): void;
  }

  const noble: EventEmitter & {
    state: string;
    startScanning(serviceUuids?: string[], allowDuplicates?: boolean): void;
    stopScanning(): void;
  };

  export default noble;
}
