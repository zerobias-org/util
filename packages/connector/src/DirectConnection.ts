import EventEmitter from 'node:events';
import {
  ConnectionMetadata,
  ConnectionStatus,
  ConnectionStatusDef,
  NotConnectedError,
  OperationSupportStatusDef
} from '@zerobias-org/types-core-js';
import { LoggerEngine } from '@zerobias-org/logger';

import { Connection } from './Connection.js';
import { Connector } from './Connector.js';

const logger = LoggerEngine.root();
const STATUS_EVENT = 'connection.status';

export class DirectConnection<T extends Connector<ProfileType, StateType>, ProfileType, StateType>
implements Connection<T, ProfileType, StateType> {
  private _instance: T;

  private _status: ConnectionStatusDef = ConnectionStatus.Off;

  private connectionProfile?: ProfileType;

  private state?: StateType;

  private emitter: EventEmitter;

  private timeout?: NodeJS.Timeout;

  // TODO: LifecycleConfig
  constructor(instance: T) {
    this._instance = instance;
    this.emitter = new EventEmitter();
  }

  async isSupported(operationId: string): Promise<OperationSupportStatusDef> {
    return this._instance.isSupported(operationId);
  }


  async metadata(): Promise<ConnectionMetadata> {
    throw new Error('Method not implemented.');
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

  async connect(profile: ProfileType): Promise<T> {
    if (this.status === ConnectionStatus.On) {
      return this.instance();
    }
    this.connectionProfile = profile;
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
      })
      .then(async () => {
        if (this._instance.refresh && this.state && this.connectionProfile) {
          try {
            const state = await this._instance.refresh(this.connectionProfile, this.state);
            this.state = state;
            this.status = ConnectionStatus.On;
          } catch (error) {
            logger.warning('Error refreshing connection', error instanceof Error ? error : new Error(String(error)));
            this.status = ConnectionStatus.Error;
          }
        }

        return;
      });
  }
}
