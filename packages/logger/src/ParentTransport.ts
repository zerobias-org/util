import Transport from 'winston-transport';

/**
 * Transport that forwards log events to parent logger's transports
 * This enables automatic log chaining up the hierarchy
 */
export class ParentTransport extends Transport {
  private forwardFn: (info: any) => void;

  constructor(forwardFn: (info: any) => void) {
    super();
    this.forwardFn = forwardFn;
  }

  /**
   * Forward log event to parent's Winston logger
   */
  log(info: any, callback: () => void): void {
    this.forwardFn(info);
    callback();
  }
}
