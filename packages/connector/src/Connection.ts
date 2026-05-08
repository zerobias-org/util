import { ConnectionStatusDef, OperationSupportStatusDef, ConnectionMetadata } from '@zerobias-org/types-core-js';

import { Connector } from './Connector.js';

export const STATUS_EVENT = 'connection.status';

export interface Connection<T extends Connector<ProfileType, StateType>, ProfileType, StateType> {

  onStatus(listener: (status: ConnectionStatusDef) => void): void;

  status: ConnectionStatusDef;

  instance(): T;

  connect(profile: ProfileType): Promise<T>;

  disconnect(): Promise<void>;

  metadata(): Promise<ConnectionMetadata>;

  isSupported(operationId: string): Promise<OperationSupportStatusDef>;
}
