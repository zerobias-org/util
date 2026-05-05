import { EventEmitter } from 'node:events';
import {
  ConnectionMetadata,
  ConnectionStatus,
  ConnectionStatusDef,
  HubConnectionProfile,
  NotConnectedError,
  OperationSupportStatusDef
} from '@zerobias-org/types-core-js';

import { Connection } from './Connection.js';
import { HubConnector } from './HubConnector.js';

const STATUS_EVENT = 'connection.status';

export class HubConnection<T extends HubConnector>
implements Connection<T, HubConnectionProfile, void> {
  private _instance: T;

  private _status: ConnectionStatusDef = ConnectionStatus.Off;

  private emitter: EventEmitter;

  private timeout?: NodeJS.Timeout;

  constructor(instance: T) {
    this._instance = instance;
    this.emitter = new EventEmitter();
  }

  async isSupported(operationId: string): Promise<OperationSupportStatusDef> {
    return this._instance.isSupported(operationId);
  }

  async metadata(): Promise<ConnectionMetadata> {
    return this._instance.metadata();
  }

  onStatus(listener: (status: ConnectionStatusDef) => void): void {
    this.emitter.on(STATUS_EVENT, listener);
  }

  get status(): ConnectionStatusDef {
    return this._status;
  }

  set status(status: ConnectionStatusDef) {
    this._status = status;
    this.emitter.emit(STATUS_EVENT, this.status);
  }

  instance(): T {
    if (this.status !== ConnectionStatus.On) {
      throw new NotConnectedError();
    }
    return this._instance;
  }

  async connect(profile: HubConnectionProfile): Promise<T> {
    if (this.status === ConnectionStatus.On) {
      return this.instance();
    }
    this.status = ConnectionStatus.Starting;
    return this._instance.connect(profile)
      .then(() => {
        this.status = ConnectionStatus.On;
        this.timeout = setTimeout(this.check, 60_000);
        return this.instance();
      })
      .catch((error: Error) => {
        this.status = ConnectionStatus.Error;
        throw error;
      });
  }

  async disconnect(): Promise<void> {
    this.status = ConnectionStatus.Stopping;
    this._instance.disconnect()
      .then(() => {
        this.status = ConnectionStatus.Off;
      })
      .catch(() => {
        this.status = ConnectionStatus.Error;
      })
      .finally(() => {
        if (this.timeout) {
          clearTimeout(this.timeout);
        }
      });
  }

  private async check(): Promise<void> {
    return this._instance.isConnected()
      .then((connected) => {
        this.status = connected ? ConnectionStatus.On : ConnectionStatus.Off;
      });
  }
}
