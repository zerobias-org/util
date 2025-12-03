/* eslint-disable @typescript-eslint/no-explicit-any */

import { MimeType } from '@zerobias-org/types-core-js';

export declare type RequestPrototype = {
  method: string,
  location: {
    protocol: 'http' | 'https',
    hostname?: string,
    port?: string,
    path: string,
    pathParams: Record<string, any>,
    params?: Record<string, any>,
    fragment?: string
  },
  headers?: Record<string, any>,
  body?: unknown,
  options?: {
    params?: {
      arrayFormat?: ArrayParameterFormat
    },
    body?: {
      type?: RequestType
      form?: FormOptions
    };
    response?: {
      body?: {
        type?: ResponseType
      },
      status?: {
        tolerated?: Array<number>
      }
    }
  }
};

export declare type FormOptions = {
  fields?: {
    [key: string]: FormFieldOptions
  },
  boundary?: string
  knownLength?: number
};

export declare type FormFieldOptions = {
  knownLength?: number,
  headers?: Record<string, string>,
  fileName?: string,
  filePath?: string,
  contentType?: MimeType
};

export declare type ResponsePrototype = {
  body?: unknown,
  headers?: Record<string, string>,
  status: number,
  pagination?: {
    count?: number,
    pageToken?: string
  }
};

export enum ArrayParameterFormat {
  Indices = 'indices',
  Brackets = 'brackets',
  Repeat = 'repeat',
  Comma = 'comma'
}

export enum RequestType {
  Multipart = 'multipart',
  OctetStream = 'octetstream',
  Json = 'json'
}

export enum ResponseType {
  ArrayBuffer = 'arraybuffer',
  Json = 'json',
  Stream = 'stream'
}
