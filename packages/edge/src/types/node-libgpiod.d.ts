declare module "node-libgpiod" {
  export class Chip {
    constructor(chipNumber: number);
  }
  export class Line {
    constructor(chip: Chip, offset: number);
    requestInputMode(): void;
    requestOutputMode(): void;
    getValue(): number;
    setValue(value: number): void;
    release(): void;
  }
}
