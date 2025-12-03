import {
  ConflictError,
  CoreError,
  Duration,
  UnauthenticatedError,
  InvalidInputError,
  NotFoundError,
  TimeoutError,
  ForbiddenError,
  UnexpectedError
} from '@zerobias-org/types-core-js';
import {
  ApiInvoker,
  RequestPrototype,
  RequestType,
  ResponsePrototype
} from '@zerobias-org/util-api-invoker-api';
import axios, { AxiosInstance, AxiosRequestConfig, Method } from 'axios';
import FormData, { AppendOptions } from 'form-data';
import qs from 'qs';

export class ApiInvokerImpl implements ApiInvoker {
  readonly client: AxiosInstance;

  protected axiosConfig: AxiosRequestConfig;

  constructor(axiosConfig: AxiosRequestConfig = { validateStatus: () => true }) {
    this.client = axios.create(axiosConfig);
    this.axiosConfig = axiosConfig;
  }

  // eslint-disable-next-line class-methods-use-this
  protected async extractErrorMessage(output: ResponsePrototype): Promise<string> {
    const content = output.body;
    let message = '';
    if (content instanceof Object) {
      message = JSON.stringify(output.body);
    } else {
      message = String(content as any);
    }
    return message;
  }

  protected async checkAndThrowError(
    input: RequestPrototype,
    output: ResponsePrototype,
    startTime: number
  ): Promise<void> {
    if (input.options?.response?.status?.tolerated?.includes(output.status)) {
      return;
    }

    if (output.status < 200 || output.status >= 400) {
      try {
        throw CoreError.deserialize(output.body);
      } catch (error) {
        if (error instanceof CoreError) {
          throw error;
        }
      }

      switch (output.status) {
        case 400: {
          throw new InvalidInputError('InvalidInput', await this.extractErrorMessage(output));
        }
        case 401: {
          throw new UnauthenticatedError();
        }
        case 403: {
          throw new ForbiddenError();
        }
        case 404: {
          throw new NotFoundError(await this.extractErrorMessage(output));
        }
        case 409: {
          throw new ConflictError(await this.extractErrorMessage(output));
        }
        case 500: {
          throw new UnexpectedError(await this.extractErrorMessage(output));
        }
        case 504: {
          const duration = Duration.fromMilliseconds((new Date().getTime()) - startTime);
          throw new TimeoutError(duration);
        }
        default:
          throw new UnexpectedError(await this.extractErrorMessage(output));
      }
    } else if (output.body && output.headers && output.headers['hub-error']) {
      // New spot to check for succesful hub attempts but failures in remote products
      try {
        if (output.body instanceof CoreError) {
          throw output.body;
        }

        throw CoreError.deserialize(output.body);
      } catch (error) {
        if (error instanceof CoreError) {
          throw error;
        }
      }

      if (output.headers && output.headers['hub-error-status']) {
        switch (output.headers['hub-error-status']) {
          case '400': {
            throw new InvalidInputError('InvalidInput', await this.extractErrorMessage(output));
          }
          case '401': {
            throw new UnauthenticatedError();
          }
          case '403': {
            throw new ForbiddenError();
          }
          case '404': {
            throw new NotFoundError(await this.extractErrorMessage(output));
          }
          case '409': {
            throw new ConflictError(await this.extractErrorMessage(output));
          }
          case '500': {
            throw new UnexpectedError(await this.extractErrorMessage(output));
          }
          case '504': {
            const duration = Duration.fromMilliseconds((new Date().getTime()) - startTime);
            throw new TimeoutError(duration);
          }
          default:
            throw new UnexpectedError(await this.extractErrorMessage(output));
        }
      }

      throw new UnexpectedError(await this.extractErrorMessage(output));
    }
  }

  // eslint-disable-next-line class-methods-use-this
  protected prepareRequest(input: RequestPrototype): AxiosRequestConfig {
    ApiInvokerImpl.sanitizeInput(input);

    /* eslint-disable max-len */
    const baseURL = input.location.hostname
      ? `${input.location.protocol}://${input.location.hostname}${input.location.port ? (`:${input.location.port}`) : ''}`
      : '';
    /* eslint-enable max-len */

    return {
      data: input.body,
      headers: input.headers,
      method: input.method as Method,
      params: input.location.params,
      responseType: input.options?.response?.body?.type,
      baseURL,
      url: `${input.location.path}${input.location.fragment ? `#${input.location.fragment}` : ''}`,
      paramsSerializer: input?.location.params
        ? (params) => qs.stringify(
          params,
          // eslint-disable-next-line max-len
          { arrayFormat: input?.options?.params?.arrayFormat ? input?.options?.params?.arrayFormat.toString().toLowerCase() as 'indices' | 'brackets' | 'repeat' | 'comma' : 'repeat', skipNulls: true }
        )
        : undefined,
    };
  }

  async invokeApi(input: RequestPrototype): Promise<ResponsePrototype> {
    const startTime = new Date().getTime();
    return this.client.request(this.prepareRequest(input))
      .then((response) => {
        // Convert AxiosHeaders to Record<string, string>, filtering out undefined values
        const headers: Record<string, string> = {};
        if (response.headers) {
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined && value !== null) {
              headers[key] = String(value);
            }
          }
        }
        const resp: ResponsePrototype = {
          status: response.status,
          headers,
          body: response.data,
          pagination: {
            count: response.headers.count ? Number(response.headers.count) : 0,
            pageToken: response.headers.pagetoken ?? response.headers.pageToken, // presumably `pagetoken` since axios lower cases all headers.
          },
        };
        return resp;
      })
      .catch((error) => {
        throw new UnexpectedError(error.message);
      })
      .then(async (output) => {
        await this.checkAndThrowError(input, output, startTime);
        return output;
      });
  }

  protected static sanitizeInput(input: RequestPrototype) {
    if (input.options?.body?.type === RequestType.Multipart) {
      const formData = new FormData();
      Object.keys(input.body as any).forEach((fieldName) => {
        let appendOptions: AppendOptions | undefined;
        if (input.options?.body?.form?.fields?.[fieldName]) {
          appendOptions = {
            contentType: input.options?.body?.form?.fields?.[fieldName]?.contentType?.toString(),
            filename: input.options?.body?.form?.fields?.[fieldName]?.fileName,
            filepath: input.options?.body?.form?.fields?.[fieldName]?.filePath,
            header: input.options?.body?.form?.fields?.[fieldName]?.headers,
            knownLength: input.options?.body?.form?.fields?.[fieldName]?.knownLength,
          };
        }
        formData.append(fieldName, (input.body as any)[fieldName], appendOptions);
      });
      input.headers = { ...formData.getHeaders(), ...input.headers };
      input.body = formData;
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async destroy(): Promise<void> {
    // no-op
  }
}
