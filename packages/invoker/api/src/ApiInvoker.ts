import { AxiosInstance } from 'axios';
import { RequestPrototype, ResponsePrototype } from './types.js';

export interface ApiInvoker {
  client: AxiosInstance;

  invokeApi(input: RequestPrototype): Promise<ResponsePrototype>

  destroy(): Promise<void>
}
